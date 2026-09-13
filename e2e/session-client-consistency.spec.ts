import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'
import { test } from './fixtures/electron-app'
import { openProjectSession } from './certification/helpers'

const row = (page: Page, title: string): Locator =>
  page
    .getByRole('navigation', { name: 'Sessions' })
    .locator('button[data-slot="session-open-button"]')
    .filter({ hasText: title })

const beginRename = async (page: Page, title: string, draft: string): Promise<Locator> => {
  await row(page, title).hover()
  await page.getByRole('button', { name: 'Rename session title', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Session title', exact: true })
  await input.fill(draft)
  return input
}

test('does not restore a deleted Session from a delayed Web rename receipt', async ({
  app,
  browser
}, testInfo) => {
  test.setTimeout(180_000)
  const first = await app.completeOnboarding()
  await first.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  const cwd = await app.createTestDirectory('session-client-consistency')
  const saved = await first.evaluate(async (cwd) => {
    const project = await window.api.projects.create({
      name: 'Session consistency',
      description: ''
    })
    const now = Date.now()
    return window.api.sessions.saveSession({
      id: 'session-client-consistency',
      projectId: project.id,
      title: 'Original title',
      cwd,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          id: 'original-prompt',
          role: 'user',
          content: 'Original prompt',
          status: 'complete',
          eventIds: [],
          createdAt: now,
          updatedAt: now
        }
      ]
    })
  }, cwd)
  const second = await app.openAdditionalRenderer()
  const web = await browser.newPage()
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    await web.goto(await app.authenticatedWebUrl())
    for (const page of [first, second, web])
      await openProjectSession(page, 'Session consistency', 'Original title')
    let receiptReady!: () => void
    const receipt = new Promise<void>((resolve) => {
      receiptReady = resolve
    })
    await web.route('**/rpc/sessions%3Aedit-details', async (route) => {
      const response = await route.fetch()
      receiptReady()
      await released
      await route.fulfill({ response })
    })
    const input = await beginRename(web, 'Original title', 'Renamed before deletion')
    await input.press('Enter')
    await receipt
    // The server committed the rename, but Web has not received its RPC acknowledgement.
    await expect(row(second, 'Renamed before deletion')).toBeVisible()
    await first.evaluate(async ({ projectId, id }) => {
      await window.api.sessions.deleteSession({ projectId, sessionId: id })
    }, saved)
    await expect(row(web, 'Original title')).toHaveCount(0)
    await expect(row(second, 'Renamed before deletion')).toHaveCount(0)
    const delivered = web.waitForResponse('**/rpc/sessions%3Aedit-details')
    release()
    await (await delivered).finished()
    await web.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    await expect(web.getByRole('textbox', { name: 'Session title', exact: true })).toHaveCount(0)
    expect(
      await first.evaluate(
        ({ projectId, id }) => window.api.sessions.loadOne({ projectId, sessionId: id }),
        saved
      )
    ).toBeUndefined()
    await web.screenshot({ path: testInfo.outputPath('delayed-receipt-result.png') })
    await expect(row(web, 'Renamed before deletion')).toHaveCount(0)
  } finally {
    release()
    await web.close()
  }
})
