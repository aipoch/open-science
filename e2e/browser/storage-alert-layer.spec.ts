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
    await page
      .locator('[data-action-toast-stack]')
      .filter({ hasText: 'Background cleanup notice' })
      .evaluate((el) => Number(getComputedStyle(el).zIndex))
  ).toBeLessThan(modalLayer)
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

test('quit recovery stays actionable above Settings without raising background notices', async ({
  page
}) => {
  await page.goto('/?quit&catalog')
  await page.getByRole('button', { name: 'Model settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings).toBeVisible()
  const quit = page
    .getByTestId('session-persistence-alert')
    .filter({ hasText: 'Quit was canceled' })
  const modalLayer = await settings.evaluate((el) => Number(getComputedStyle(el).zIndex))
  expect(await quit.evaluate((el) => Number(getComputedStyle(el).zIndex))).toBeGreaterThan(
    modalLayer
  )
  await quit.getByTestId('session-persistence-retry').click()
  await expect(page.getByTestId('quit-retries')).toHaveText('1')
  await expect(settings).toBeVisible()
  await quit.getByTestId('session-persistence-dismiss').click()
  await expect(quit).toHaveCount(0)
  await expect(settings).toBeVisible()
  const background = page.getByTestId('session-persistence-alert')
  expect(await background.evaluate((el) => Number(getComputedStyle(el).zIndex))).toBeLessThan(
    modalLayer
  )
})
