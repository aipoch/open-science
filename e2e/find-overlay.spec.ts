import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

test.use({ windowMode: 'normal' })

test('refocuses the open find overlay and follows app language changes', async ({
  app
}, testInfo) => {
  const page = await app.completeOnboarding()
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Find overlay project')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  const modifiers = process.platform === 'darwin' ? (['meta'] as const) : (['control'] as const)
  await app.pressMainWindowShortcut('F', [...modifiers])
  await expect.poll(() => app.findOverlayIsVisible()).toBe(true)
  await expect
    .poll(() =>
      page
        .context()
        .pages()
        .some((candidate) => candidate.url().includes('/find-overlay/'))
    )
    .toBe(true)
  const overlay = page
    .context()
    .pages()
    .find((candidate) => candidate.url().includes('/find-overlay/'))!
  const input = overlay.getByRole('textbox')
  await expect(input).toBeFocused()

  // Playwright emulates document focus for Electron pages. Blur the actual input to
  // observe whether the repeated native shortcut reaches the overlay's show handler.
  await input.evaluate((element) => element.blur())
  await expect(input).not.toBeFocused()
  await app.pressMainWindowShortcut('F', [...modifiers])
  await expect(input).toBeFocused()

  await page.evaluate(async () => {
    await window.api.locale.setPreference({ preference: 'zh-Hans' })
  })
  await expect(input).toHaveAttribute('placeholder', '查找')
  await expect(overlay.locator('html')).toHaveAttribute('lang', 'zh-Hans')
  await expect(overlay.getByRole('button', { name: '上一个匹配项', exact: true })).toBeVisible()
  await overlay.screenshot({ path: testInfo.outputPath('find-overlay-zh-Hans.png') })

  await page.evaluate(async () => {
    await window.api.locale.setPreference({ preference: 'ja' })
  })
  await expect(input).toHaveAttribute('placeholder', '検索')
  await expect(overlay.locator('html')).toHaveAttribute('lang', 'ja')
  await overlay.screenshot({ path: testInfo.outputPath('find-overlay-ja.png') })
  await overlay.getByRole('button', { name: '検索を閉じる' }).click()
  await expect.poll(() => app.findOverlayIsVisible()).toBe(false)
})
