import { expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'

declare global {
  interface Window {
    firstTurnStopDeletedSessionIds: string[]
  }
}

// Keep production Electron, renderer and OpenCode adapter paths. Only the external ACP process
// uses the deterministic fixture. Hold the first create response until after Stop and the next
// user action, then require provider-close evidence so late cleanup cannot escape the assertion.
test.use({ windowMode: 'normal' })

for (const action of ['send a follow-up', 'delete the session'] as const) {
  test(`stopping the first OpenCode prompt immediately still permits ${action}`, async ({
    app
  }, info) => {
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    await app.setMainWindowSize(1200, 900)
    await page.evaluate(() =>
      window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
    )
    await createProjectViaUi(page, 'Immediate first stop reproduction')
    const gate = await app.holdNextFakeSessionCreate()
    await page.evaluate(() => {
      window.firstTurnStopDeletedSessionIds = []
      window.api.sessions.onDeleted(({ sessionId }) => {
        window.firstTurnStopDeletedSessionIds.push(sessionId)
      })
    })

    const composer = page.getByRole('textbox', { name: 'Ask anything' })
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    const row = page
      .getByRole('navigation', { name: 'Sessions', includeHidden: true })
      .locator('[data-session-id]')
    let stoppedSessionId: string | null = null
    let sendToStopMs: number | undefined
    let lateProviderSessionId: string | undefined
    let persistedSessions: { id: string; status: string }[] | undefined
    try {
      await composer.fill('First prompt for immediate Stop reproduction.')
      const sentAt = Date.now()
      await send.click()
      await expect.poll(() => readFile(gate.started, 'utf8').catch(() => null)).toBeTruthy()
      lateProviderSessionId = await readFile(gate.started, 'utf8')
      await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
      sendToStopMs = Date.now() - sentAt
      await expect(row).toHaveCount(1)
      stoppedSessionId = await row.getAttribute('data-session-id')
      expect(stoppedSessionId).toMatch(/^pending-session-/)
      if (action === 'send a follow-up') {
        const followup = 'Summarize the deterministic fixture.'
        await composer.fill(followup)
        await expect(send).toBeEnabled({ timeout: 5_000 })
        await send.click()
        await writeFile(gate.release, '')
        await expect(
          page.getByText(`Deterministic reply: ${followup}`, { exact: true })
        ).toBeVisible()
      } else {
        await row.getByRole('button', { name: /^Open actions for / }).click()
        const remove = page.getByRole('menuitem', { name: 'Delete', exact: true })
        await expect(remove).toBeVisible({ timeout: 5_000 })
        await remove.click()
        await page
          .getByRole('alertdialog', { name: 'Delete Session?' })
          .getByRole('button', { name: 'Delete', exact: true })
          .click()
        await expect(row).toHaveCount(0)
        await writeFile(gate.release, '')
      }
      await expect
        .poll(() => readFile(gate.closed, 'utf8').catch(() => null))
        .toBe(lateProviderSessionId)
      await expect
        .poll(() => page.evaluate(() => window.firstTurnStopDeletedSessionIds))
        .toContain(lateProviderSessionId)
      if (action === 'delete the session') {
        await expect(row).toHaveCount(0)
      } else {
        await expect(row).toHaveCount(1)
      }
      await expect
        .poll(async () => {
          persistedSessions = await page.evaluate(async () =>
            (await window.api.sessions.list()).sessions.map(({ id, status }) => ({ id, status }))
          )
          return persistedSessions.length
        })
        .toBe(action === 'delete the session' ? 0 : 1)
      await expect(page.getByText('Session cleanup needs attention', { exact: true })).toHaveCount(
        0
      )
    } finally {
      await writeFile(gate.release, '')
      const evidence = {
        action,
        sendToStopMs,
        stoppedSessionId,
        lateProviderSessionId,
        closedProviderSessionId: await readFile(gate.closed, 'utf8').catch(() => null),
        sessionId: await row.evaluateAll(
          (rows) => rows[0]?.getAttribute('data-session-id') ?? null
        ),
        persistedSessions,
        // A modal Radix menu hides the composer from the accessibility tree while open.
        sendEnabled: await page
          .locator('button[aria-label="Send message"]')
          .evaluateAll((buttons) => buttons.some((button) => !button.matches(':disabled'))),
        resumeVisible: await page
          .getByRole('button', { name: 'Resume session', exact: true })
          .isVisible(),
        menuItems: await page.getByRole('menuitem').allTextContents()
      }
      console.log('FIRST_TURN_STOP_REPRO', JSON.stringify(evidence))
      await info.attach('first-turn-stop-state', {
        body: JSON.stringify(evidence, null, 2),
        contentType: 'application/json'
      })
      await info.attach('first-turn-stop-screen', {
        body: await page.screenshot({ animations: 'disabled' }),
        contentType: 'image/png'
      })
    }
  })
}
