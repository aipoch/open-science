import { expect, test } from '@playwright/test'

for (const width of [1100, 360]) {
  for (const failed of [false, true]) {
    test(`keeps completion actions visible at ${width}px with failed=${failed}`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 980 })
      await page.goto(`/batch-completion.html${failed ? '?failed&dark' : ''}`)
      for (const name of ['Skills', 'Connectors', 'Skill Marketplace']) {
        const panel = page.getByRole('region', { name, exact: true })
        const done = panel.getByRole('button', { name: 'Done', exact: true })
        await expect(done).toBeVisible()
        const actionBox = (await done.boundingBox())!
        const panelBox = (await panel.boundingBox())!
        expect(actionBox.x).toBeGreaterThan(panelBox.x)
        expect(actionBox.x + actionBox.width).toBeLessThan(panelBox.x + panelBox.width)
        if (width === 1100 && !failed) {
          const summary =
            name === 'Skill Marketplace'
              ? panel.getByRole('heading', { name: 'Batch complete' })
              : panel.getByRole('status')
          const summaryBox = (await summary.boundingBox())!
          expect(
            Math.abs(summaryBox.y + summaryBox.height / 2 - actionBox.y - actionBox.height / 2)
          ).toBeLessThan(2)
        }
      }
      const marketplace = page.getByRole('region', { name: 'Skill Marketplace', exact: true })
      await marketplace.locator('summary').click()
      await expect(marketplace.locator('details')).toHaveAttribute('open', '')
      await expect(
        marketplace.locator('details li').filter({ hasText: 'literature-review' })
      ).toBeVisible()
      for (const name of ['Skills', 'Connectors', 'Skill Marketplace']) {
        const panel = page.getByRole('region', { name, exact: true })
        await panel.getByRole('button', { name: 'Done', exact: true }).click()
        await expect(panel.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      )
    })
  }
}
