import { getSettingsPage } from './settings-window'
import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'

// Home and Workspace expose the same Settings action.
export const openSettingsPage = async (page: Page, section: string): Promise<Locator> => {
  await page.getByRole('button', { name: /^Settings$/ }).click()
  const settings = (await getSettingsPage(page)).getByRole('dialog', {
    name: 'Settings',
    exact: true
  })
  await expect(settings).toBeVisible()
  const navigation = settings.getByRole('navigation', { name: 'Settings', exact: true })
  if (!(await navigation.isVisible())) {
    await settings.getByRole('button', { name: 'Open settings navigation' }).click()
  }
  await navigation.getByRole('button', { name: section, exact: true }).click()
  return settings
}

export const openGeneralSettings = async (page: Page): Promise<Locator> => {
  const settings = await openSettingsPage(page, 'General')
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

export const selectLanguage = async (page: Page, label: string): Promise<void> => {
  const settings = await openGeneralSettings(page)
  await settings.getByRole('combobox', { name: 'Interface language' }).click()
  const settingsPage = await getSettingsPage(page)
  await settingsPage.getByRole('option', { name: label, exact: true }).click()
  // The dialog name changes with the locale; use Escape rather than the old English close label.
  await settingsPage.keyboard.press('Escape')
  await expect(settingsPage.getByRole('dialog')).toBeHidden()
}
