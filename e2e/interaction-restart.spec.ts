import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

const scenarios = [
  { action: 'approve', restart: true },
  { action: 'dismiss', restart: true },
  { action: 'comment', restart: true },
  { action: 'question', restart: true },
  { action: 'question', restart: false }
] as const

for (const { action, restart } of scenarios) {
  test(`delivers ${action} ${restart ? 'after a real application restart' : 'in the live session'}`, async ({
    app
  }, testInfo) => {
    test.setTimeout(180_000)
    await app.completeOnboarding()
    let page = await app.configureFakeAgent()
    await page.getByRole('button', { name: 'New project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByLabel('Name').fill(`Restart ${action}`)
    await dialog.getByRole('button', { name: 'Create project' }).click()
    const prompt =
      action === 'question'
        ? 'Ask a restart verification question.'
        : 'Create a restart verification Plan.'
    await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
    await page.getByRole('button', { name: 'Send message' }).click()
    if (action === 'question')
      await expect(
        page.getByText('Restart verification dataset?', { exact: true }).first()
      ).toBeVisible()
    else
      await expect(page.getByRole('button', { name: 'Approve', exact: true }).first()).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('before-restart.png') })
    if (restart) {
      const quittingPage = page
      const restarting = app.restart()
      // A live generate_plan waiter triggers the ordinary running-work quit confirmation.
      const confirmQuit = quittingPage.getByRole('button', { name: 'Quit', exact: true })
      await confirmQuit
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => confirmQuit.click())
        .catch(() => undefined)
      page = await restarting
      await page
        .getByRole('region', { name: 'Recent sessions' })
        .getByRole('button', { name: prompt })
        .click()
    }
    if (action === 'question') {
      await expect(
        page.getByText('Restart verification dataset?', { exact: true }).first()
      ).toBeVisible()
      await page.getByText('Dataset Alpha', { exact: true }).first().click()
      await page.getByRole('button', { name: 'Finish', exact: true }).click()
    } else if (action === 'approve') {
      await page.getByRole('button', { name: 'Approve', exact: true }).first().click()
    } else if (action === 'dismiss') {
      await page.getByRole('button', { name: 'Open', exact: true }).first().click()
      await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
    } else {
      await page
        .getByRole('textbox', { name: 'Respond to Plan' })
        .fill('Please verify cohort boundaries.')
      await page.getByRole('button', { name: 'Send Plan feedback' }).click()
    }
    const expected = `Restart verification: ${action === 'approve' ? 'Plan approval' : action === 'dismiss' ? 'Plan dismissal' : action === 'comment' ? 'Plan feedback' : 'Question answer'} delivered.`
    await expect(page.getByText(expected, { exact: false })).toBeVisible({ timeout: 40_000 })
    await expect
      .poll(async () =>
        page.evaluate(async (text) => {
          const { sessions } = await window.api.sessions.loadAll()
          return sessions
            .flatMap((session) => session.messages)
            .filter((message) => message.role === 'agent' && message.content.includes(text)).length
        }, expected)
      )
      .toBe(1)
    await page.screenshot({ path: testInfo.outputPath('after-response.png') })
  })
}
