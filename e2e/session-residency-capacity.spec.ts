import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { openProjectSession } from './certification/helpers'

// Capacity measurement, not a claim that a particular RSS value is acceptable on every machine.
test('profiles same-process visits to forty persisted session bodies', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  let page = await app.completeOnboarding()
  const cwd = await app.createTestDirectory('session-residency')
  const projectId = await page.evaluate(async (cwd) => {
    const project = await window.api.projects.create({
      name: 'Residency capacity',
      description: ''
    })
    const now = Date.now()
    for (let i = 0; i < 40; i++) {
      await window.api.sessions.saveSession({
        id: `residency-${i}`,
        projectId: project.id,
        title: `Residency ${String(i).padStart(2, '0')}`,
        cwd,
        status: 'idle',
        createdAt: now + i,
        updatedAt: now + i,
        messages: [
          {
            id: `body-${i}`,
            role: 'user',
            status: 'complete',
            eventIds: [],
            content: `BODY${i}\n\n${'Historical text. '.repeat(4096)}`,
            createdAt: now,
            updatedAt: now
          }
        ]
      })
    }
    return project.id
  }, cwd)
  // The existing profiler restarts once to activate its isolated data directory.
  await app.beginResourceProfile({ sampleIntervalMs: 1000 })
  page = app.page
  try {
    await openProjectSession(page, 'Residency capacity', 'Residency 00')
    await app.markResourceProfilePhase('first-session')
    for (let i = 0; i < 40; i++) {
      await page
        .getByRole('navigation', { name: 'Sessions' })
        .getByRole('button', {
          name: new RegExp(`^Session status:.* Residency ${String(i).padStart(2, '0')}$`)
        })
        .click()
      await expect(page.locator(`[data-message-id="body-${i}"]`)).toBeVisible()
      if ((i + 1) % 10 === 0) await app.markResourceProfilePhase(`visited-${i + 1}`)
    }
    await app.markResourceProfilePhase('idle-after-visits')
    await page.waitForTimeout(3000)
    await app.sampleResourceProfileNow()
    await page
      .getByRole('navigation', { name: 'Sessions' })
      .getByRole('button', { name: /^Session status:.* Residency 00$/ })
      .click()
    await expect(page.locator('[data-message-id="body-0"]')).toBeVisible()
    await app.markResourceProfilePhase('revisited-first')
  } finally {
    const result = await app.finishResourceProfile()
    await testInfo.attach('session-residency-profile', {
      path: result.summaryMarkdownPath,
      contentType: 'text/markdown'
    })
    await testInfo.attach('session-residency-data', {
      body: JSON.stringify(result.summary),
      contentType: 'application/json'
    })
  }
  // Read back the durable API after profiling: browsing/reclamation must not rewrite bodies.
  const changedBodies = await page.evaluate(async (projectId) => {
    const changed: number[] = []
    for (let i = 0; i < 40; i++) {
      const session = await window.api.sessions.loadOne({ projectId, sessionId: `residency-${i}` })
      if (session?.messages[0]?.content !== `BODY${i}\n\n${'Historical text. '.repeat(4096)}`) {
        changed.push(i)
      }
    }
    return changed
  }, projectId)
  expect(changedBodies).toEqual([])
})
