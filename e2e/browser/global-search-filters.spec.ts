import { expect, test } from '@playwright/test'

test('keeps the filter toggle fixed while categories scroll and supports keyboard disclosure', async ({
  page
}) => {
  await page.setViewportSize({ width: 600, height: 720 })
  await page.goto('/global-search-filters.html')
  const toggle = page.getByRole('button', { name: /^Filters/ })
  const scope = page.getByRole('combobox', { name: 'Search scope' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(scope).toBeHidden()
  await page.getByRole('dialog').evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished))
  })
  const before = (await toggle.boundingBox())!
  const chips = page.locator('.global-search-chips')
  expect(await chips.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await chips.evaluate((el) => {
    el.scrollLeft = el.scrollWidth
  })
  expect((await toggle.boundingBox())!.x).toBe(before.x)
  expect(before.x + before.width).toBeLessThan(600)
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Tab')
  await expect(scope).toBeFocused()
  await scope.press('Enter')
  await page.getByRole('option', { name: 'Current project', exact: true }).click()
  await expect(toggle).toHaveText('Filters1')
  await toggle.focus()
  await page.keyboard.press('Space')
  await expect(scope).toBeHidden()
  await page.keyboard.press('Tab')
  await expect(page.locator('.search-subfilters :focus')).toHaveCount(0)
  await toggle.click()
  await expect(scope).toContainText('Current project')
})

test('starts with result groups even when old search history exists', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('open-science-recent-searches', JSON.stringify(['session']))
  })
  await page.goto('/global-search-filters.html')
  await expect(page.getByRole('listbox', { name: 'Search results' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'session', exact: true })).toHaveCount(0)
  await expect(page.locator('.search-recent-queries')).toHaveCount(0)
  await expect(page.locator('[data-search-group="projects"]')).toBeVisible()
})
