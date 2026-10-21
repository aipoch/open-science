import { expect, test } from '@playwright/test'
import { openSettingsPage } from '../fixtures/settings-preferences'

for (const height of [800, 600]) {
  for (const kind of ['skill', 'connector'] as const) {
    test(`${kind} picker scrolls inside Settings at height ${height}`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height })
      await page.goto('/?search-shortcuts&capability-scroll')
      const settings = await openSettingsPage(page, 'Specialists')
      await settings.getByRole('button', { name: 'Edit Researcher', exact: true }).first().click()
      if (kind === 'connector') await settings.getByRole('tab', { name: 'Connectors 0' }).click()
      const trigger = settings.getByRole('button', { name: `＋ Add a ${kind}`, exact: true })
      await trigger.click()
      const picker = page.getByRole('dialog', { name: `＋ Add a ${kind}`, exact: true })
      const search = picker.getByRole('searchbox', { name: `Search ${kind}s to add` })
      await expect(search).toBeFocused()
      const bounds = await picker.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.y).toBeGreaterThanOrEqual(0)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height)
      const settingsScroll = await settings
        .locator('[data-slot="settings-main"]')
        .evaluate((node) =>
          Array.from(node.querySelectorAll('*')).map((element) => element.scrollTop)
        )
      await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height - 30)
      await page.mouse.wheel(0, 2000)
      await expect.poll(() => picker.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
      const last = picker.getByRole('button', { name: `Scroll ${kind} 39`, exact: true })
      await expect(last).toBeInViewport()
      expect(
        await settings
          .locator('[data-slot="settings-main"]')
          .evaluate((node) =>
            Array.from(node.querySelectorAll('*')).map((element) => element.scrollTop)
          )
      ).toEqual(settingsScroll)

      // The nested tag Select still dismisses before its parent and returns keyboard focus.
      const tags = picker.getByRole('combobox', { name: 'Filter by Tag' })
      await tags.click()
      await expect(page.getByRole('listbox')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('listbox')).toBeHidden()
      await expect(tags).toBeFocused()
      await expect(picker).toBeVisible()
      await last.click()
      await expect(picker).toBeHidden()
      await expect(trigger).toBeFocused()
      await expect(settings.getByRole('button', { name: `Remove Scroll ${kind} 39` })).toBeVisible()

      await trigger.click()
      await search.fill(`Scroll ${kind} 38`)
      await expect(
        picker.getByRole('button', { name: `Scroll ${kind} 38`, exact: true })
      ).toBeVisible()
      await search.press('Escape')
      await expect(picker).toBeHidden()
      await expect(trigger).toBeFocused()
      await expect(settings).toBeVisible()
    })
  }
}
