import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'
import { test } from './fixtures/electron-app'

const openGeneralSettings = async (page: Page): Promise<Locator> => {
  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'General', exact: true })
    .click()
  return settings
}

test.describe('Windows window system', () => {
  test.skip(process.platform !== 'win32', 'Windows window behavior requires a Windows host.')
  test.use({ windowMode: 'normal' })

  test('persists minimize-to-tray across titlebar close, relaunch, and Ctrl+W', async ({ app }) => {
    let page = await app.completeOnboarding()
    let settings = await openGeneralSettings(page)
    const closeAction = settings.getByRole('combobox', { name: 'When closing the window' })

    await closeAction.click()
    await page.getByRole('option', { name: 'Minimize to tray' }).click()
    await expect(closeAction).toContainText('Minimize to tray')
    await settings.getByRole('button', { name: 'Close settings' }).click()

    page = await app.restart()
    settings = await openGeneralSettings(page)
    await expect(settings.getByRole('combobox', { name: 'When closing the window' })).toContainText(
      'Minimize to tray'
    )
    await settings.getByRole('button', { name: 'Close settings' }).click()

    await app.requestMainWindowClose()
    await expect.poll(() => app.mainWindowState()).toEqual({ minimized: false, visible: false })

    await app.launchSecondInstance()
    await expect.poll(() => app.mainWindowState()).toEqual({ minimized: false, visible: true })

    await app.pressMainWindowShortcut('W', ['control'])
    await expect.poll(() => app.mainWindowState()).toEqual({ minimized: false, visible: false })

    page = await app.launchSecondInstance()
    await expect.poll(() => app.mainWindowState()).toEqual({ minimized: false, visible: true })
    await expect(page.getByRole('region', { name: 'Projects' })).toBeVisible()
  })

  test('opens the whole-window find overlay with Ctrl+F in a workspace', async ({ app }) => {
    const page = await app.completeOnboarding()
    await page.getByRole('button', { name: 'New project' }).click()
    const projectDialog = page.getByRole('dialog', { name: 'New project' })
    await projectDialog.getByLabel('Name').fill('Windows find project')
    await projectDialog.getByRole('button', { name: 'Create project' }).click()
    await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

    await expect.poll(() => app.findOverlayIsVisible()).toBe(false)
    await app.pressMainWindowShortcut('F', ['control'])
    await expect.poll(() => app.findOverlayIsVisible()).toBe(true)
  })
})
