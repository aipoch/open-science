import { expect, test } from '@playwright/test'

test('keeps the advanced filter toggle fixed while categories scroll and supports keyboard disclosure', async ({
  page
}) => {
  await page.setViewportSize({ width: 600, height: 720 })
  await page.goto('/global-search-filters.html')
  const toggle = page.getByRole('button', { name: /^Advanced filters/ })
  const scope = page.getByRole('combobox', { name: 'Search scope' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(scope).toHaveCount(0)
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
  await expect(toggle).toHaveText('Advanced filters1')
  await toggle.focus()
  await page.keyboard.press('Space')
  await expect(scope).toHaveCount(0)
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

test('preserves composing keyboard defaults and normal Escape dismissal', async ({ page }) => {
  await page.goto('/global-search-filters.html')
  const input = page.getByRole('combobox', { name: 'Global search', exact: true })
  await input.fill('Protein')
  await input.press('ArrowDown')
  const activeId = await input.getAttribute('aria-activedescendant')
  for (const composition of [{ isComposing: true }, { isComposing: false, keyCode: 229 }]) {
    for (const key of ['ArrowDown', 'Enter', 'Escape']) {
      const defaultPrevented = await input.evaluate(
        (element, init) => {
          const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
          element.dispatchEvent(event)
          return event.defaultPrevented
        },
        { ...composition, key }
      )
      expect(defaultPrevented).toBe(false)
      await expect(input).toHaveAttribute('aria-activedescendant', activeId!)
      await expect(input).toBeFocused()
      await expect(input).toHaveValue('Protein')
      await expect(page.getByRole('dialog')).toBeVisible()
    }
  }
  await input.press('Escape')
  await expect(page.locator('[data-testid="global-search-detail"]')).toHaveAttribute(
    'data-open',
    'false'
  )
  await input.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('explains blocked search and exposes the existing recovery settings target', async ({
  page
}) => {
  await page.goto('/global-search-filters.html?unready&recovery')
  await page.getByRole('combobox', { name: 'Global search', exact: true }).fill('Protein')
  await page.locator('[data-category="messages"]').click()
  await expect(page.getByRole('status')).toContainText('Search is partially unavailable')
  await expect(page.getByText('No results found', { exact: true })).toHaveCount(0)
  await expect(page.locator('[data-category="messages"] small')).toHaveCount(0)
  await page.getByRole('button', { name: 'Review recovery options' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('status', { name: 'Recovery settings target' })).toHaveText(
    'archived'
  )
})
