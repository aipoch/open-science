import { expect, test } from '@playwright/test'

test('Settings covers the persistent recovery alert until the modal closes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/?catalog')
  const alert = page.getByTestId('session-persistence-alert')
  await expect(alert).toBeVisible()
  await page.getByRole('button', { name: 'Model settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings).toBeVisible()

  // Check painting order, not just hit testing: an inert card can still obscure the modal.
  const alertLayer = await alert.evaluate((el) => Number(getComputedStyle(el).zIndex))
  const modalLayer = await settings.evaluate((el) => Number(getComputedStyle(el).zIndex))
  expect(alertLayer).toBeLessThan(modalLayer)
  expect(
    await alert.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.right - 20, rect.bottom - 20)
      return hit !== null && !el.contains(hit)
    })
  ).toBe(true)

  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  await alert.getByTestId('session-persistence-action').click()
  const details = page.getByTestId('session-recovery-details-dialog')
  await expect(details).toBeVisible()
  await details.getByRole('button', { name: 'Close', exact: true }).click()
  await alert.getByTestId('session-persistence-dismiss').click()
  await expect(alert).toHaveCount(0)
})
