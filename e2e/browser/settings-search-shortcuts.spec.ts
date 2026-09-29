import { test, expect } from '@playwright/test'
import { openGeneralSettings } from '../fixtures/settings-preferences'

// Exercise real key events with both platform conventions against the full Settings UI.
for (const platform of ['Win32', 'MacIntel']) {
  test(`keeps global and panel searches distinct on ${platform}`, async ({ page }) => {
    await page.addInitScript((value) => {
      Object.defineProperty(navigator, 'platform', { get: () => value })
    }, platform)
    await page.goto('/?search-shortcuts')
    const settings = await openGeneralSettings(page)
    const navigation = settings.getByRole('navigation', { name: 'Settings', exact: true })
    const globalSearch = settings.getByRole('combobox', { name: 'Search settings' })
    const modifier = platform === 'MacIntel' ? 'Meta' : 'Control'

    for (const [panel, label] of [
      ['Specialists', 'Search specialists'],
      ['Skills', 'Search skills'],
      ['Connectors', 'Search connectors'],
      ['Tags', 'Search tagged resources']
    ]) {
      await navigation.getByRole('button', { name: panel, exact: true }).click()
      const localSearch = settings.getByRole('searchbox', { name: label, exact: true })
      await expect(localSearch).toBeVisible()
      await expect(globalSearch).toHaveAttribute('aria-keyshortcuts', `${modifier}+K`)
      await expect(localSearch).toHaveAttribute('aria-keyshortcuts', `${modifier}+Alt+K`)
      // Local hints were removed to keep narrow panel searches readable; the shortcut remains.
      await expect(localSearch.locator('..').locator('kbd')).toHaveCount(0)

      await page.keyboard.press(`${modifier}+k`)
      await expect(globalSearch).toBeFocused()
      await page.keyboard.press(`${modifier}+Alt+k`)
      await expect(localSearch).toBeFocused()
      await localSearch.fill('a query')
      await page.keyboard.press(`${modifier}+k`)
      await expect(globalSearch).toBeFocused()
      await expect(localSearch).toHaveValue('a query')
      await page.keyboard.press(`${modifier}+Alt+k`)
      await expect(localSearch).toBeFocused()
      await localSearch.fill('')
    }
  })
}

test('keeps every keyboard-selected settings result visible without moving input focus', async ({
  page
}) => {
  await page.goto('/?search-shortcuts')
  const settings = await openGeneralSettings(page)
  const input = settings.getByRole('combobox', { name: 'Search settings' })
  await input.focus()
  const list = settings.getByRole('listbox', { name: 'Search settings' })
  for (let index = 0; index < 36; index++) {
    await input.press('ArrowDown')
    await expect(input).toBeFocused()
    await expect
      .poll(async () => {
        const viewport = await list.boundingBox()
        const option = await list.locator('[aria-selected="true"]').boundingBox()
        return Boolean(
          viewport &&
          option &&
          option.y >= viewport.y &&
          option.y + option.height <= viewport.y + viewport.height
        )
      })
      .toBe(true)
  }
  await input.fill('language')
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  await expect(input).toHaveValue('language')
  await expect(list).toBeVisible()
  await input.press('Enter')
  await expect(list).toBeHidden()
  await expect(settings.locator('[data-settings-anchor="general.language"]')).toBeFocused()
})
