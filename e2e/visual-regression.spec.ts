import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { test } from './fixtures/electron-app'

const prepareVisualPage = async (page: Page): Promise<void> => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addStyleTag({
    content:
      '* { scrollbar-width: none !important; } *::-webkit-scrollbar { display: none !important; }'
  })

  await page.getByRole('button', { name: /^Theme:/ }).click()
  await page.getByRole('menuitem', { name: /^Light/ }).click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
}

const expectStableScreenshot = async (
  page: Page,
  name: string,
  maxDiffPixelRatio = 0.002
): Promise<void> => {
  await page.locator('a[aria-label*="GitHub"]').evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = 'hidden'
  })
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await expect(page).toHaveScreenshot(name, {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixelRatio: process.platform === 'darwin' ? maxDiffPixelRatio : 0.035
  })
}

test('keeps core desktop surfaces visually stable', async ({ app }) => {
  const page = await app.completeOnboarding()
  await prepareVisualPage(page)
  await expect(page.getByRole('region', { name: 'Projects' })).toBeVisible()
  await expectStableScreenshot(page, 'home-empty.png')

  await page.getByRole('button', { name: 'New project' }).click()
  const projectDialog = page.getByRole('dialog', { name: 'New project' })
  await expect(projectDialog).toBeVisible()
  await expectStableScreenshot(page, 'project-create-dialog.png')

  await projectDialog.getByLabel('Name').fill('Visual baseline project')
  await projectDialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
  await expectStableScreenshot(page, 'workspace-empty.png')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'General', exact: true })
    .click()
  await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  const appVersion = settings.getByRole('region', { name: 'App version' })
  await appVersion.getByRole('button').evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = 'hidden'
  })
  await appVersion.locator(':scope > p').evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = 'hidden'
  })
  // The text-dense settings surface has slightly different font antialiasing on macos-14 runners.
  await expectStableScreenshot(page, 'settings-general.png', 0.004)
})
