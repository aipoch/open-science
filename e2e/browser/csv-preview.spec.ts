import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark']) {
  test(`CSV row numbers cover scrolled data in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto('/csv-preview.html')
    await page.evaluate(
      (theme) => document.documentElement.classList.toggle('dark', theme === 'dark'),
      theme
    )
    const table = page.getByRole('table')
    await expect(table).toBeVisible()
    await table.evaluate((table) => {
      const scroller = table.parentElement!
      scroller.scrollLeft = 200
      scroller.scrollTop = scroller.scrollHeight
    })
    const rows = table.locator('tbody tr')
    for (const index of [98, 99]) {
      const cell = rows.nth(index).locator('td').first()
      const geometry = await cell.evaluate((cell) => {
        const style = getComputedStyle(cell)
        const rowStyle = getComputedStyle(cell.parentElement!)
        return {
          background: style.backgroundColor,
          rowBackground: rowStyle.backgroundColor,
          left: cell.getBoundingClientRect().left,
          scrollLeft: cell.closest('table')!.parentElement!.getBoundingClientRect().left
        }
      })
      expect(geometry.background).not.toBe('rgba(0, 0, 0, 0)')
      expect(geometry.background).toBe(geometry.rowBackground)
      expect(geometry.left).toBeCloseTo(geometry.scrollLeft, 0)
    }
    await page.screenshot({ path: testInfo.outputPath(`csv-${theme}.png`) })
  })
}
