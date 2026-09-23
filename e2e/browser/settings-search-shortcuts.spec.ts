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
    const hint = platform === 'MacIntel' ? '⌘⌥K' : 'CtrlAltK'

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
      await expect(localSearch.locator('..').locator('span[aria-hidden="true"]')).toHaveText(hint)
      // The three-key hint has its own reserved area and stays inside the search field.
      expect(
        await localSearch.evaluate((input) => {
          const hint = input.nextElementSibling!
          const box = input.getBoundingClientRect()
          const hintBox = hint.getBoundingClientRect()
          return (
            hintBox.right <= box.right &&
            hintBox.left >= box.right - parseFloat(getComputedStyle(input).paddingRight)
          )
        })
      ).toBe(true)

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
