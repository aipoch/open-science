import { expect, test } from '@playwright/test'

for (const layer of [50, 60, 70]) {
  for (const fallback of [false, true]) {
    test(`background notices stay below modal ${layer}, fallback=${fallback}`, async ({ page }) => {
      await page.setViewportSize({ width: layer === 60 ? 390 : 1280, height: 800 })
      await page.goto(`/global-overlays.html?layer=${layer}${fallback ? '&fallback' : ''}`)
      if (!fallback) {
        await page.getByRole('button', { name: 'Show message', exact: true }).click()
        await expect(page.getByTestId('notification-live-toast')).toBeVisible()
      }
      await page.getByRole('button', { name: 'Open modal', exact: true }).click()
      const modal = page.getByRole('dialog', { name: 'Active modal' })
      await expect(modal).toBeVisible()
      const surfaces = page.locator(
        '[data-action-toast-stack], [data-testid="session-persistence-alert"], [data-testid="notification-live-toast"], [data-notification-recovery-toast]'
      )
      await expect(surfaces).toHaveCount(3)
      for (const surface of await surfaces.all()) {
        expect(await surface.evaluate((el) => Number(getComputedStyle(el).zIndex))).toBeLessThan(
          layer
        )
        expect(
          await surface.evaluate((el) => {
            const r = el.getBoundingClientRect()
            const hit = document.elementFromPoint(r.right - 15, r.top + 15)
            return hit !== null && !el.contains(hit)
          })
        ).toBe(true)
      }
      await modal.getByRole('combobox', { name: 'Modal choice' }).click()
      await page.getByRole('option', { name: 'Second choice' }).click()
      await expect(modal.getByRole('combobox')).toHaveText('Second choice')
      await page.keyboard.press('Tab')
      expect(await modal.evaluate((el) => el.contains(document.activeElement))).toBe(true)
      await modal.getByRole('button', { name: 'Close modal' }).click()
      await page.getByRole('button', { name: 'Run action', exact: true }).click()
      await expect(page.getByTestId('actions')).toHaveText('1')
    })
  }
}

test('body-portaled selection toolbar withdraws while its source is inert', async ({ page }) => {
  await page.goto('/global-overlays.html')
  await page.getByRole('button', { name: 'Select source', exact: true }).click()
  const trigger = page.locator('[data-annotation-trigger]')
  await expect(trigger).toBeVisible()
  await page.getByRole('button', { name: 'Open modal', exact: true }).click()
  await expect(trigger).toBeHidden()
  await page.getByRole('button', { name: 'Close modal' }).click()
  await expect(trigger).toBeVisible()
})

test('an open message panel closes when its source becomes inert', async ({ page }) => {
  await page.goto('/global-overlays.html')
  await page.getByRole('button', { name: 'Messages, no unread messages' }).click()
  const panel = page.locator('[role="dialog"][aria-label="Message center"]')
  await expect(panel).toBeVisible()
  // A higher-priority presentation can open without a pointer event outside the panel.
  await page
    .getByRole('button', { name: 'Open modal', exact: true })
    .evaluate((el: HTMLButtonElement) => el.click())
  await expect(panel).toHaveCount(0)
})
