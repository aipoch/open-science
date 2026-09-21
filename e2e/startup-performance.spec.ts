import { readFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

test.use({ windowMode: 'normal' })

test('records first renderer readiness before the fixture reload', async ({ app }, testInfo) => {
  await app.completeOnboarding()
  await app.beginResourceProfile({
    ...(process.env.OPEN_SCIENCE_PERF_OUTPUT_ROOT
      ? { outputRoot: process.env.OPEN_SCIENCE_PERF_OUTPUT_ROOT }
      : {})
  })
  try {
    await app.restart({ resourceProfilePhase: 'startup' })
  } finally {
    const result = await app.finishResourceProfile()
    await testInfo.attach('first-startup-summary', {
      path: result.summaryMarkdownPath,
      contentType: 'text/markdown'
    })
    const first = result.summary.timings?.['first-startup-ready']
    const fixture = result.summary.timings?.['startup-ready']
    expect(first?.count).toBe(1)
    expect(first?.median).toBeGreaterThan(0)
    expect(fixture?.median).toBeGreaterThan(first!.median)
  }
})

test('hydrates historical Sessions only once during startup composition', async ({
  app
}, testInfo) => {
  const page = await app.completeOnboarding()
  const cwd = await app.createTestDirectory('startup-history')
  const count = Number(process.env.OPEN_SCIENCE_STARTUP_HISTORY_COUNT ?? 80)
  expect(Number.isSafeInteger(count) && count > 0).toBe(true)
  const projectId = await page.evaluate(
    async ({ cwd, count }) => {
      const project = await window.api.projects.create({ name: 'Startup history', description: '' })
      for (let index = 0; index < count; index++) {
        const timestamp = Date.now() + index
        await window.api.sessions.saveSession({
          id: `startup-history-${index}`,
          projectId: project.id,
          cwd,
          title: `History ${index}`,
          status: 'idle',
          createdAt: timestamp,
          updatedAt: timestamp,
          messages: [
            {
              id: `history-message-${index}`,
              role: 'user',
              status: 'complete',
              eventIds: [],
              content: 'Historical research. '.repeat(1024),
              createdAt: timestamp,
              updatedAt: timestamp
            }
          ]
        })
      }
      return project.id
    },
    { cwd, count }
  )
  for (const mode of ['normal', 'crash'] as const) {
    if (mode === 'normal') await app.restart()
    else await app.restartAfterCrash()
    const logPath = await app.captureMainLog(`startup-history-${mode}.log`)
    const records = (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .flatMap((line) => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
    const startup = records
      .filter((record) => record.data?.operation === 'application-startup')
      .at(-1)
    expect(startup).toBeDefined()
    const run = records.filter((record) => record.runId === startup.runId)
    const hydrations = run.filter(
      (record) =>
        record.data?.operation === 'session-hydration' &&
        record.data?.mode === 'reconcile' &&
        record.msg === 'operation completed'
    )
    expect(hydrations).toHaveLength(1)
    expect(hydrations[0].data.sessionCount).toBeGreaterThanOrEqual(count)
    await testInfo.attach(`startup-history-${mode}-phases`, {
      body: JSON.stringify(
        run.filter((record) =>
          ['application-startup', 'application-composition', 'session-hydration'].includes(
            record.data?.operation
          )
        ),
        null,
        2
      ),
      contentType: 'application/json'
    })
    const damaged = await app.page.evaluate(
      async ({ projectId, count }) => {
        const changed: string[] = []
        for (let index = 0; index < count; index++) {
          const id = `startup-history-${index}`
          const stored = await window.api.sessions.loadOne({ projectId, sessionId: id })
          if (
            !stored ||
            stored.title !== `History ${index}` ||
            stored.messages.length !== 1 ||
            stored.messages[0].id !== `history-message-${index}` ||
            stored.messages[0].content !== 'Historical research. '.repeat(1024)
          )
            changed.push(id)
        }
        return changed
      },
      { projectId, count }
    )
    expect(damaged, `${mode} restart must preserve every historical message`).toEqual([])
  }
})
