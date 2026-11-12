import { expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'
import { submitPromptViaUi } from './fixtures/conversation'

// Keep HTTP classification failures isolated from the real Electron/Node ACP connection.
const PROMPT = 'Summarize the deterministic fixture.'
const REPLY = `Deterministic reply: ${PROMPT}`
const FAULT_ENV = 'OPEN_SCIENCE_E2E_CLASSIFICATION_FAULT_ROOT'
const manualInspection = process.env.OPEN_SCIENCE_E2E_CLASSIFICATION_PAUSE === '1'
if (manualInspection) test.use({ windowMode: 'normal' })

for (const mode of [
  'healthy',
  'transient-500',
  'transient-body-reset',
  'http-500',
  'body-reset',
  'not-yet-visible',
  'timeout'
] as const) {
  test(`OpenCode classification failure isolation: ${mode}`, async ({ app }, testInfo) => {
    await app.completeOnboarding()
    const faultRoot = await app.createTestDirectory('classification-fault')
    await writeFile(join(faultRoot, 'fault.json'), JSON.stringify({ mode }))
    const previous = process.env[FAULT_ENV]
    process.env[FAULT_ENV] = faultRoot
    let page
    try {
      // configureFakeAgent relaunches the app with the isolated fault control inherited by
      // its backend and ACP child; do not leak that environment to another test launch.
      page = await app.configureFakeAgent()
    } finally {
      if (previous === undefined) delete process.env[FAULT_ENV]
      else process.env[FAULT_ENV] = previous
    }
    await page.evaluate(() =>
      window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
    )
    await createProjectViaUi(page, `Classification boundary ${mode}`)
    await expect(page.getByRole('heading', { name: 'New conversation' }))
      .toBeVisible()
      .catch(async (error: unknown) => {
        await testInfo.attach('project-preparation-diagnostics', {
          body: (await page.locator('body').textContent()) ?? '',
          contentType: 'text/plain'
        })
        throw error
      })
    await submitPromptViaUi(page, PROMPT)

    await expect
      .poll(() => readFile(join(faultRoot, 'requests.jsonl'), 'utf8').catch(() => ''))
      .not.toBe('')
    const succeeds = mode === 'healthy' || mode.startsWith('transient-')
    if (succeeds) {
      await expect(page.getByText(REPLY, { exact: true })).toBeVisible()
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0]?.status)
        )
        .toBe('idle')
      await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toHaveCount(0)
    } else {
      await expect
        .poll(
          () =>
            page.evaluate(async () => {
              const session = (await window.api.sessions.loadAll()).sessions[0]
              return session?.messages.find((message) => message.role === 'user')?.turnOutcome
            }),
          { timeout: 15_000 }
        )
        .toMatchObject({
          kind: 'failed',
          error: expect.stringContaining('OpenCode message classification failed')
        })
      await expect(page.getByText(REPLY, { exact: true })).toHaveCount(0)
    }
    await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toHaveCount(0)
    await expect(
      page.getByText('Connection lost — Resume to reconnect and continue.', { exact: true })
    ).toHaveCount(0)

    const session = await page.evaluate(
      async () => (await window.api.sessions.loadAll()).sessions[0]
    )
    const requests = (await readFile(join(faultRoot, 'requests.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            mode: string
            timestamp: number
            infoPresent: boolean
            pid: number
          }
      )
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((request) => request.mode === mode && request.infoPresent)).toBe(true)
    const outcome = session.messages.find((message) => message.role === 'user')?.turnOutcome
    if (succeeds) expect(outcome?.kind).toBe('completed')
    expect(requests).toHaveLength(mode === 'healthy' || mode === 'not-yet-visible' ? 1 : 2)
    const elapsedMs = outcome ? outcome.settledAt - requests[0].timestamp : undefined
    if (mode === 'timeout') expect(elapsedMs).toBeGreaterThanOrEqual(4_000)
    await testInfo.attach('classification-boundary-evidence', {
      body: JSON.stringify({ mode, requests, elapsedMs, session }, null, 2),
      contentType: 'application/json'
    })
    await page.screenshot({ path: testInfo.outputPath(`classification-${mode}.png`) })
    // Allow a human to inspect the fault before the test restores the service.
    if (manualInspection) {
      console.log('Fault active: inspect the error, then click Resume in Playwright Inspector.')
      await page.pause()
    }
    await writeFile(join(faultRoot, 'fault.json'), JSON.stringify({ mode: 'healthy' }))
    if (manualInspection) {
      console.log(
        'Fault cleared: send a message manually in the same conversation, then click Resume in Playwright Inspector.'
      )
      await page.pause()
    }
    const recoveryPrompt = 'Verify this same connection still works.'
    const priorReplies = await page.getByText(REPLY, { exact: true }).count()
    await submitPromptViaUi(page, recoveryPrompt)
    // The existing fixture intentionally uses a fixed default reply for ordinary prompts.
    await expect(page.getByText(REPLY, { exact: true })).toHaveCount(priorReplies + 1)
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const sessions = (await window.api.sessions.loadAll()).sessions
          return sessions[0]?.messages.filter((message) => message.role === 'user').at(-1)
            ?.turnOutcome?.kind
        })
      )
      .toBe('completed')
    const allRequests = (await readFile(join(faultRoot, 'requests.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { pid: number; sessionId: string })
    expect(allRequests.length).toBeGreaterThan(requests.length)
    expect(new Set(allRequests.map((request) => request.pid)).size).toBe(1)
    expect(new Set(allRequests.map((request) => request.sessionId)).size).toBe(1)
    await testInfo.attach('same-connection-recovery-evidence', {
      body: JSON.stringify(
        {
          requests: allRequests,
          sessions: await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
        },
        null,
        2
      ),
      contentType: 'application/json'
    })
    await page.screenshot({ path: testInfo.outputPath(`classification-${mode}-recovered.png`) })
    await testInfo.attach('classification-main-log', {
      path: await app.captureMainLog(`classification-${mode}-${testInfo.repeatEachIndex}.log`),
      contentType: 'text/plain'
    })
  })
}
