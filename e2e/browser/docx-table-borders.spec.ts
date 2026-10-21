import { expect, test } from '@playwright/test'
import { docxTableCases } from '../../test/fixtures/docx-table-borders'

for (const scenario of docxTableCases) {
  test(`DOCX table borders: ${scenario.name}`, async ({ page }, testInfo) => {
    await page.goto(`/docx-table-borders.html?case=${encodeURIComponent(scenario.name)}`)
    const preview = page.locator('[data-office-preview-ready="true"]')
    await expect(preview).toBeVisible()
    const colors = (): Promise<string[][]> =>
      page.evaluate(() =>
        (window as unknown as { readTableBorders(): string[][] }).readTableBorders()
      )
    await expect.poll(colors).toEqual(scenario.expected)
    await preview.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await page.setViewportSize({ width: 480, height: 500 })
    await expect.poll(colors).toEqual(scenario.expected)
    await page.screenshot({ path: testInfo.outputPath('table.png'), fullPage: true })
  })
}
