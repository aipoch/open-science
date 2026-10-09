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

  test.beforeEach(async ({ app }) => {
    // Native locale resolution follows the host OS, so --lang alone cannot pin test copy.
    await app.page.evaluate(async () => {
      await window.api.locale.setPreference({ preference: 'en' })
    })
    await expect(app.page.locator('html')).toHaveAttribute('lang', 'en')
  })

  test('keeps the Windows application menu beside native caption controls at interface zoom', async ({
    app
  }, testInfo) => {
    const page = await app.completeOnboarding()
    const titlebar = page.getByTestId('windows-titlebar')
    await expect(titlebar).toBeVisible()
    await expect(titlebar.getByRole('menuitem')).toHaveText(['File', 'Edit', 'View', 'Help'])

    for (const scale of [1, 1.25, 1] as const) {
      // Use the production scale shortcut so both the renderer preference and native overlay update.
      await app.pressMainWindowShortcut('0', ['control'])
      if (scale === 1.25) {
        await app.pressMainWindowShortcut('=', ['control'])
        await app.pressMainWindowShortcut('=', ['control'])
      }
      await expect
        .poll(() =>
          page.evaluate(() => {
            const overlay = (
              navigator as Navigator & {
                windowControlsOverlay: { visible: boolean; getTitlebarAreaRect: () => DOMRect }
              }
            ).windowControlsOverlay
            const header = document.querySelector<HTMLElement>('[data-testid="windows-titlebar"]')!
            const safeArea = header.querySelector<HTMLElement>('.windows-titlebar-safe-area')!
            const main = document.querySelector('main')!
            const menu = header.querySelector<HTMLElement>('[role="menubar"]')!
            return {
              overlay: overlay.visible,
              // Windows rounds native caption geometry to device pixels at fractional DPI/zoom.
              overlayAligned:
                Math.abs(
                  overlay.getTitlebarAreaRect().height - header.getBoundingClientRect().height
                ) <= 1,
              rowHeight: Math.round(header.getBoundingClientRect().height),
              captionsReserved: safeArea.getBoundingClientRect().right < innerWidth,
              contentTop: Math.round(main.getBoundingClientRect().top),
              overflow: document.documentElement.scrollHeight > innerHeight + 1,
              drag: getComputedStyle(header).getPropertyValue('-webkit-app-region'),
              menuDrag: getComputedStyle(menu).getPropertyValue('-webkit-app-region')
            }
          })
        )
        .toEqual({
          overlay: true,
          overlayAligned: true,
          rowHeight: 36,
          captionsReserved: true,
          contentTop: 36,
          overflow: false,
          drag: 'drag',
          menuDrag: 'no-drag'
        })
    }
    await page.keyboard.press('F10')
    await expect(titlebar.getByRole('menuitem', { name: 'File' })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(titlebar.getByRole('menuitem', { name: 'Edit' })).toBeFocused()
    await page.keyboard.press('Escape')
    await testInfo.attach('windows-titlebar', {
      body: await page.screenshot(),
      contentType: 'image/png'
    })
  })

  test('hides titlebar chrome in native fullscreen and restores it on exit', async ({ app }) => {
    const page = await app.completeOnboarding()
    const titlebar = page.getByTestId('windows-titlebar')
    await expect(titlebar).toBeVisible()
    await app.pressMainWindowShortcut('F11', [])
    await expect(titlebar).toBeHidden()
    await page.reload()
    await expect(titlebar).toBeHidden()
    await expect
      .poll(() => page.locator('main').evaluate((main) => main.getBoundingClientRect().top))
      .toBe(0)
    await page.keyboard.press('F10')
    await expect(page.getByRole('menuitem')).toHaveCount(0)
    await app.pressMainWindowShortcut('F11', [])
    await expect(titlebar).toBeVisible()
    await expect
      .poll(() => page.locator('main').evaluate((main) => main.getBoundingClientRect().top))
      .toBe(36)
    await page.keyboard.press('F10')
    await expect(titlebar.getByRole('menuitem', { name: 'File' })).toBeFocused()
  })

  test('uses interface scale steps for Windows plus aliases and reset shortcuts', async ({
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

  test('anchors native titlebar popups below their buttons after moving and zooming the window', async ({
    app
  }) => {
    const page = await app.completeOnboarding()
    for (const { offset, scale } of [
      { offset: 80, scale: 1 },
      { offset: 200, scale: 1.25 }
    ]) {
      await app.setMainWindowZoomFactor(scale)
      for (const name of ['File', 'Edit', 'View', 'Help']) {
        const probe = await app.observeMainWindowMenuPopup(offset)
        try {
          const button = page.getByRole('menuitem', { name, exact: true })
          const bounds = await button.boundingBox()
          expect(bounds).not.toBeNull()
          await button.click()
          await expect.poll(() => probe.evaluate((value) => value.shown)).toBe(true)
          expect(await probe.evaluate((value) => value.anchor)).toEqual({
            x: Math.round(bounds!.x * scale),
            y: Math.round((bounds!.y + bounds!.height) * scale),
            zoom: scale
          })
          await probe.evaluate((value) => value.close())
          await expect.poll(() => probe.evaluate((value) => value.closed)).toBe(true)
          await expect(button).toHaveAttribute('aria-expanded', 'false')
        } finally {
          await probe.evaluate((value) => value.dispose())
          await probe.dispose()
        }
      }
    }
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
