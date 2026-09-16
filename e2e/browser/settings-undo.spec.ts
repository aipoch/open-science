import { expect, test } from '@playwright/test'

test('Undo remains reachable above Settings at the viewport top center', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?undo')
  await page.getByRole('button', { name: /^(Model settings|Settings)$/ }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings).toBeVisible()
  const undo = page.getByTestId('permission-undo-snackbar')
  expect(await undo.evaluate((el) => el.closest('[inert], [aria-hidden="true"]') !== null)).toBe(
    false
  )
  const bounds = (await undo.boundingBox())!
  expect(bounds.x + bounds.width / 2).toBeCloseTo(640, 0)
  expect(bounds.y).toBeLessThan(24)
  await undo.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(undo).toHaveCount(0)
  await expect(settings).toBeVisible()
})

for (const width of [375, 1280]) {
  for (const reducedMotion of ['reduce', 'no-preference'] as const) {
    test(`Undo preserves focus and identity across Settings at ${width}px (${reducedMotion})`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ reducedMotion })
      await page.goto('/?undo')
      const undo = page.getByTestId('permission-undo-snackbar')
      const original = await undo.elementHandle()
      await page.getByRole('button', { name: 'Model settings', exact: true }).focus()
      await page.keyboard.press('Enter')
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await expect(settings).toBeVisible()
      if (width >= 768) {
        await settings.getByRole('button', { name: 'Maximize', exact: true }).click()
        const bounds = (await undo.boundingBox())!
        expect(bounds.x + bounds.width / 2).toBeCloseTo(width / 2, 0)
        expect(bounds.y).toBe(16)
        await settings.getByRole('button', { name: 'Restore', exact: true }).click()
      }
      await settings.getByRole('button', { name: 'Close settings', exact: true }).click()
      await expect(settings).toHaveCount(0)
      expect(await undo.evaluate((el, previous) => el === previous, original)).toBe(true)
      await page.getByRole('button', { name: 'Model settings', exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect(settings).toBeVisible()
      expect(await undo.evaluate((el, previous) => el === previous, original)).toBe(true)
      const button = undo.getByRole('button', { name: 'Undo', exact: true })
      await undo.getByRole('button', { name: 'Dismiss permission Undo' }).focus()
      await page.keyboard.press('Shift+Tab')
      await expect(button).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(undo).toHaveCount(0)
      await expect(settings).toBeVisible()
    })
  }
}

test('revoking inside Permissions shows an actionable Undo above Settings', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?undo&revoke')
  await page.getByRole('button', { name: 'Model settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings
    .getByRole('navigation', { name: 'Settings', exact: true })
    .getByRole('button', { name: 'Permissions', exact: true })
    .click()
  const row = settings
    .locator('[data-slot="permission-row"]')
    .filter({ hasText: 'Attach connector' })
  await row.getByRole('button').click()
  const undo = page.getByTestId('permission-undo-snackbar')
  await expect(undo).toBeVisible()
  await settings.getByRole('combobox', { name: 'Default permission mode' }).click()
  await page.getByRole('option', { name: /Full access/ }).click()
  const confirmation = page.getByRole('alertdialog', { name: 'Use Full access by default?' })
  await expect(confirmation).toBeVisible()
  expect(
    await undo.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    })
  ).toBe(false)
  await undo.locator('button').first().focus()
  await expect(undo.locator('button').first()).not.toBeFocused()
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(confirmation).toHaveCount(0)
  await undo.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(undo).toHaveCount(0)
  await expect(row).toBeVisible()
  await expect(settings).toBeVisible()
})

for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  test(`Settings retains its panel animation (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion })
    await page.goto('/?undo')
    await page.getByRole('button', { name: 'Model settings', exact: true }).click()
    const panel = page.locator('[data-slot="settings-surface"]')
    await expect(panel).toHaveAttribute('data-state', 'open')
    expect(await panel.evaluate((el) => getComputedStyle(el).animationName)).toBe(
      reducedMotion === 'reduce' ? 'none' : 'enter'
    )
    await page.getByRole('button', { name: 'Close settings', exact: true }).click()
    await expect(panel).toHaveCount(0)
  })
}

test('mobile navigation hides Undo until its focus trap closes', async ({ page }) => {
  // Keep fast Escape/Undo input covered when React's passive effects lag behind the DOM commit.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto('/?undo')
  await page.getByRole('button', { name: 'Model settings', exact: true }).focus()
  await page.keyboard.press('Enter')
  const undo = page.getByTestId('permission-undo-snackbar')
  const original = await undo.elementHandle()
  await page.getByRole('button', { name: 'Open settings navigation' }).click()
  const navigation = page.getByRole('dialog', { name: 'Settings navigation' })
  await expect(navigation).toBeVisible()
  await expect(undo).toBeHidden()
  expect(await undo.evaluate((el) => el.closest('[inert]') !== null)).toBe(true)
  await page.keyboard.press('Tab')
  expect(await navigation.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(navigation).toHaveCount(0)
  // Wait for Settings' close effect to return focus before starting the next keyboard interaction.
  await expect(page.getByRole('button', { name: 'Open settings navigation' })).toBeFocused()
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible()
  await expect(undo).toBeVisible()
  expect(await undo.evaluate((el, previous) => el === previous, original)).toBe(true)
  await undo.getByRole('button', { name: 'Dismiss permission Undo' }).focus()
  await page.keyboard.press('Shift+Tab')
  await expect(undo.getByRole('button', { name: 'Undo', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(undo).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible()
})
