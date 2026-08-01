import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

test('persists the selected theme after closing settings and relaunching', async ({ app }) => {
  let page = await app.completeOnboarding()

  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', {
      name: 'General',
      exact: true
    })
    .click()

  const theme = settings.getByRole('radiogroup', { name: 'Theme' })
  await theme.getByRole('radio', { name: 'Dark' }).click()
  await expect(theme.getByRole('radio', { name: 'Dark' })).toBeChecked()
  await expect(page.locator('html')).toHaveClass(/dark/)

  await settings.getByRole('button', { name: 'Close settings' }).click()
  await expect(page.getByRole('button', { name: 'Theme: Dark' })).toBeVisible()

  page = await app.restart()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.getByRole('button', { name: 'Theme: Dark' })).toBeVisible()
})
