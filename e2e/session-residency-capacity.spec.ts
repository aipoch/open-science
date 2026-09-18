import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { openProjectSession } from './certification/helpers'

// Keep body-integrity correctness in the gate; large resource sampling runs nightly.
for (const scenario of [
  { title: 'preserves persisted bodies across session visits', count: 3, profile: false },
  {
    title: 'profiles same-process visits to forty persisted session bodies @capacity',
    count: 40,
    profile: true
  }
]) {
  test(scenario.title, async ({ app }, testInfo) => {
    test.setTimeout(180_000)
    let page = await app.completeOnboarding()
    const cwd = await app.createTestDirectory('session-residency')
    const projectId = await page.evaluate(
      async ({ cwd, count }) => {
        const project = await window.api.projects.create({
          name: 'Residency capacity',
          description: ''
        })
        const now = Date.now()
        for (let i = 0; i < count; i++) {
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
      },
      { cwd, count: scenario.count }
    )
    // The existing profiler restarts once to activate its isolated data directory.
    if (scenario.profile) {
      await app.beginResourceProfile({ sampleIntervalMs: 1000 })
      page = app.page
    } else {
      page = await app.restart()
    }
    try {
      await openProjectSession(page, 'Residency capacity', 'Residency 00')
      if (scenario.profile) await app.markResourceProfilePhase('first-session')
      for (let i = 0; i < scenario.count; i++) {
        await page
          .getByRole('navigation', { name: 'Sessions' })
          .getByRole('button', {
            name: new RegExp(`^Session status:.* Residency ${String(i).padStart(2, '0')}$`)
          })
          .click()
        await expect(page.locator(`[data-message-id="body-${i}"]`)).toBeVisible()
        if (scenario.profile && (i + 1) % 10 === 0)
          await app.markResourceProfilePhase(`visited-${i + 1}`)
      }
      if (scenario.profile) {
        await app.markResourceProfilePhase('idle-after-visits')
        await page.waitForTimeout(3000)
        await app.sampleResourceProfileNow()
      }
      await page
        .getByRole('navigation', { name: 'Sessions' })
        .getByRole('button', { name: /^Session status:.* Residency 00$/ })
        .click()
      await expect(page.locator('[data-message-id="body-0"]')).toBeVisible()
      if (scenario.profile) await app.markResourceProfilePhase('revisited-first')
    } finally {
      if (scenario.profile) {
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
    }
    // Read back the durable API after profiling: browsing/reclamation must not rewrite bodies.
    const changedBodies = await page.evaluate(
      async ({ projectId, count }) => {
        const changed: number[] = []
        for (let i = 0; i < count; i++) {
          const session = await window.api.sessions.loadOne({
            projectId,
            sessionId: `residency-${i}`
          })
          if (session?.messages[0]?.content !== `BODY${i}\n\n${'Historical text. '.repeat(4096)}`) {
            changed.push(i)
          }
        }
        return changed
      },
      { projectId, count: scenario.count }
    )
    expect(changedBodies).toEqual([])
  })
}
