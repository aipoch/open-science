import { expect, test } from '@playwright/test'

for (const height of [800, 600]) {
  for (const kind of ['skill', 'connector'] as const) {
    test(`${kind} picker scrolls inside the resource center at height ${height}`, async ({
      page
    }) => {
      await page.setViewportSize({ width: 1280, height })
      await page.goto('/?search-shortcuts&capability-scroll')
      await page.getByRole('button', { name: 'Resource center', exact: true }).click()
      await page
        .getByRole('navigation', { name: 'Resource center' })
        .getByRole('button', { name: 'Specialists' })
        .click()
      const center = page.getByRole('main')
      await center
        .getByRole('button', { name: 'View details for Researcher', exact: true })
        .first()
        .click()
      await page.getByRole('button', { name: 'Edit', exact: true }).click()
      if (kind === 'connector') await center.getByRole('tab', { name: 'Connectors 0' }).click()
      const trigger = center.getByRole('button', { name: `＋ Add a ${kind}`, exact: true })
      await trigger.click()
      const picker = page.getByRole('dialog', { name: `＋ Add a ${kind}`, exact: true })
      const search = picker.getByRole('searchbox', { name: `Search ${kind}s to add` })
      await expect(search).toBeFocused()
      const bounds = await picker.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.y).toBeGreaterThanOrEqual(0)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height)
      const initialScroll = await center.evaluate((node) =>
        Array.from(node.querySelectorAll('*')).map((element) => element.scrollTop)
      )
      await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height - 30)
      await page.mouse.wheel(0, 2000)
      await expect.poll(() => picker.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
      const last = picker.getByRole('button', { name: `Scroll ${kind} 39`, exact: true })
      await expect(last).toBeInViewport()
      expect(
        await center.evaluate((node) =>
          Array.from(node.querySelectorAll('*')).map((element) => element.scrollTop)
        )
      ).toEqual(initialScroll)

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
      await expect(center.getByRole('button', { name: `Remove Scroll ${kind} 39` })).toBeVisible()

      await trigger.click()
      await search.fill(`Scroll ${kind} 38`)
      await expect(
        picker.getByRole('button', { name: `Scroll ${kind} 38`, exact: true })
      ).toBeVisible()
      await search.press('Escape')
      await expect(picker).toBeHidden()
      await expect(trigger).toBeFocused()
      await expect(center).toBeVisible()
    })
  }
}
