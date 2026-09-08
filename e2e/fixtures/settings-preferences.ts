import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'

// Home and Workspace expose different labels for the same direct Settings action.
export const openGeneralSettings = async (page: Page): Promise<Locator> => {
  await page.getByRole('button', { name: /^(Model settings|Settings)$/ }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings).toBeVisible()
  const navigation = settings.getByRole('navigation', { name: 'Settings', exact: true })
  if (!(await navigation.isVisible())) {
    await settings.getByRole('button', { name: 'Open settings navigation' }).click()
  }
  await navigation.getByRole('button', { name: 'General', exact: true }).click()
  await expect(settings.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible()
  return settings
}

export const setTheme = async (page: Page, theme: 'Dark' | 'Light'): Promise<void> => {
  const settings = await openGeneralSettings(page)
  const choice = settings.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', {
    name: theme,
    exact: true
  })
  await choice.click()
  await expect(choice).toBeChecked()
  await settings.getByRole('button', { name: 'Close settings' }).click()
  await expect(settings).toBeHidden()
  if (theme === 'Dark') await expect(page.locator('html')).toHaveClass(/dark/)
  else await expect(page.locator('html')).not.toHaveClass(/dark/)
}
