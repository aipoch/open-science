import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'
import { test } from './fixtures/electron-app'

const openGeneralSettings = async (page: Page): Promise<Locator> => {
  await page.getByRole('button', { name: 'Settings' }).click()
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

  test('uses interface scale steps for Windows plus aliases and reset shortcuts @pr-mainline-windows', async ({
    app
  }, testInfo) => {
    const page = await app.completeOnboarding()
    await app.setMainWindowZoomFactor(1)
    const pixelRatio = (): Promise<number> => page.evaluate(() => window.devicePixelRatio)
    const baseline = await pixelRatio()
    await testInfo.attach('zoom-before', {
      body: await page.screenshot(),
      contentType: 'image/png'
    })

    for (const key of ['=', 'numadd']) {
      for (const expectedScale of [1.1, 1.25, 1.25]) {
        await app.pressMainWindowShortcut(key, ['control'])
        await expect.poll(async () => (await pixelRatio()) / baseline).toBeCloseTo(expectedScale, 4)
      }
      await testInfo.attach(`zoom-after-${key === '=' ? 'equal' : 'numpad'}`, {
        body: await page.screenshot(),
        contentType: 'image/png'
      })
      await app.pressMainWindowShortcut('0', ['control'])
      await expect.poll(pixelRatio).toBeCloseTo(baseline, 4)
    }

    await app.pressMainWindowShortcut('+', ['control', 'shift'])
    await expect.poll(async () => (await pixelRatio()) / baseline).toBeCloseTo(1.1, 4)
    await app.pressMainWindowShortcut('-', ['control'])
    await expect.poll(pixelRatio).toBeCloseTo(baseline, 4)
  })

  test('persists minimize-to-tray across titlebar close, relaunch, and Ctrl+W @pr-mainline-windows', async ({
    app
  }) => {
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
