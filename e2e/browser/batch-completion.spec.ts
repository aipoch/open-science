import { expect, test } from '@playwright/test'

for (const width of [1100, 360]) {
  for (const failed of [false, true]) {
    test(`keeps Marketplace completion actions visible at ${width}px with failed=${failed}`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 980 })
      await page.goto(`/batch-completion.html${failed ? '?failed&dark' : ''}`)
      const panel = page.getByRole('region', { name: 'Skill Marketplace', exact: true })
      const done = panel.getByRole('button', { name: 'Done', exact: true })
      await expect(done).toBeVisible()
      const actionBox = (await done.boundingBox())!
      const panelBox = (await panel.boundingBox())!
      expect(actionBox.x).toBeGreaterThan(panelBox.x)
      expect(actionBox.x + actionBox.width).toBeLessThan(panelBox.x + panelBox.width)
      if (width === 1100 && !failed) {
        const summaryBox = (await panel
          .getByRole('heading', { name: 'Batch complete' })
          .boundingBox())!
        expect(
          Math.abs(summaryBox.y + summaryBox.height / 2 - actionBox.y - actionBox.height / 2)
        ).toBeLessThan(2)
      }
      await panel.locator('summary').click()
      await expect(panel.locator('details')).toHaveAttribute('open', '')
      await expect(
        panel.locator('details li').filter({ hasText: 'literature-review' })
      ).toBeVisible()
      await done.click()
      await expect(done).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      )
    })
  }
}
