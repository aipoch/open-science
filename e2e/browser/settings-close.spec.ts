import { expect, test, type Locator } from '@playwright/test'

const observeExit = async (surface: Locator): Promise<void> => {
  await surface.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished))
    // Observe the real CSS exit boundary before Radix removes the dialog. Settings animates
    // a child of Dialog.Content, so Presence does not retain that child's final frame.
    element.addEventListener('animationend', (event) => {
      if (event.target !== element || element.getAttribute('data-state') !== 'closed') return
      document.body.dataset.closedSurfaceOpacity = getComputedStyle(element).opacity
    })
  })
}

for (const layout of ['restored', 'maximized', 'mobile'] as const) {
  for (const closeWith of ['button', 'Escape'] as const) {
    test(`${layout} Settings stays transparent when closed with ${closeWith}`, async ({
      page
    }, testInfo) => {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.setViewportSize({ width: layout === 'mobile' ? 390 : 1280, height: 800 })
      await page.goto('/')
      const trigger = page.getByRole('button', { name: 'Settings', exact: true })
      await trigger.click()
      if (layout === 'maximized') await page.getByRole('button', { name: 'Maximize' }).click()
      // Start inside content: Escape on an autofocus-opened tooltip dismisses that layer first.
      await page.locator('[data-slot="settings-main"] h2').first().click()
      const surface = page.locator('[data-slot="settings-surface"]')
      await observeExit(surface)
      if (closeWith === 'button') {
        await page.getByRole('button', { name: 'Close settings', exact: true }).click()
      } else {
        await page.keyboard.press('Escape')
      }
      await expect(surface).toHaveCount(0)
      expect(await page.locator('body').getAttribute('data-closed-surface-opacity')).toBe('0')
      await expect(trigger).toBeFocused()
      if (layout === 'restored' && closeWith === 'button') {
        await page.screenshot({ path: testInfo.outputPath('settings-closed.png') })
      }
      await trigger.click()
      await expect(surface).toHaveAttribute('data-state', 'open')
      await expect(surface).toHaveCSS('opacity', '1')
    })
  }
}

test('Settings closes and reopens with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  const trigger = page.getByRole('button', { name: 'Settings', exact: true })
  const surface = page.locator('[data-slot="settings-surface"]')
  await trigger.click()
  await expect(surface).toHaveCSS('animation-name', 'none')
  await page.keyboard.press('Escape')
  await expect(surface).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(surface).toHaveCSS('opacity', '1')
})

for (const kind of ['dialog', 'alertdialog'] as const) {
  test(`shared ${kind} already retains its transparent exit frame`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.goto(kind === 'dialog' ? '/global-overlays.html' : '/error-surfaces.html')
    await page
      .getByRole('button', {
        name: kind === 'dialog' ? 'Open modal' : 'Open dangerous action',
        exact: true
      })
      .click()
    const surface = page.getByRole(kind)
    await observeExit(surface)
    await page.keyboard.press('Escape')
    await expect(surface).toHaveCount(0)
    expect(await page.locator('body').getAttribute('data-closed-surface-opacity')).toBe('0')
  })
}

test('mobile search dismisses results before navigation and Settings', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Open settings navigation', exact: true }).click()
  const nav = page.getByRole('navigation', { name: 'Settings', exact: true })
  const search = nav.getByRole('combobox', { name: 'Search settings', exact: true })
  await search.fill('proxy')
  await expect(nav.getByRole('listbox')).toBeVisible()
  await search.press('Escape')
  await expect(nav.getByRole('listbox')).toHaveCount(0)
  await expect(nav).not.toHaveAttribute('aria-hidden', 'true')
  await page.keyboard.press('Escape')
  await expect(page.locator('nav[aria-label="Settings"]')).toHaveAttribute('aria-hidden', 'true')
  await expect(page.locator('[data-slot="settings-surface"]')).toBeVisible()
})
