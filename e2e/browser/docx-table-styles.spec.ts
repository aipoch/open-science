import { expect, test, type Locator } from '@playwright/test'

test('DOCX conditional table styles remain scoped through zoom and resize', async ({
  page
}, testInfo) => {
  await page.goto('/docx-table-borders.html?styles=1')
  const preview = page.locator('[data-office-preview-ready="true"]')
  await expect(preview).toBeVisible()
  const cell = (text: string): Locator =>
    preview
      .locator('td')
      .filter({ has: page.locator('p > span', { hasText: new RegExp(`^${text}$`) }) })
      .last()
  const text = (value: string): Locator =>
    preview.locator('p > span').filter({ hasText: new RegExp(`^${value}$`) })
  const check = async (): Promise<void> => {
    await expect(cell('0-1')).toHaveCSS('background-color', 'rgb(242, 244, 247)')
    await expect(text('0-1')).toHaveCSS('font-weight', '700')
    await expect(cell('1-0')).toHaveCSS('background-color', 'rgb(221, 238, 255)')
    await expect(text('1-0')).toHaveCSS('font-size', '14px')
    await expect(text('1-0')).toHaveCSS('font-weight', '400')
    await expect(cell('2-0')).toHaveCSS('background-color', 'rgb(255, 238, 221)')
    await expect(cell('nested')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(text('nested')).toHaveCSS('font-weight', '400')
    await expect(text('0-0')).toHaveCSS('font-weight', '400')
  }
  await check()
  await preview.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.setViewportSize({ width: 480, height: 500 })
  await check()
  await page.screenshot({
    path: testInfo.outputPath('conditional-table-styles.png'),
    fullPage: true
  })
})

test('maintained Pandoc report renders Chinese tables, headings and lists', async ({
  page
}, testInfo) => {
  await page.goto('/docx-table-borders.html?report=1')
  const preview = page.locator('[data-office-preview-ready="true"]')
  await expect(preview).toBeVisible()
  const table = preview.locator('table').first()
  await expect(table.locator('tr')).toHaveCount(4)
  await expect(table.locator('tr').first().locator('td').first()).toHaveCSS(
    'background-color',
    'rgb(242, 244, 247)'
  )
  await expect(table.locator('tr').nth(1).locator('td').first()).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)'
  )
  await expect(table.getByText('肽/蛋白类', { exact: true })).toHaveCSS('font-weight', '400')
  await expect(preview.getByText('整理原始资料。', { exact: true })).toBeVisible()
  await expect(preview.getByText('保留项目列表的缩进。', { exact: true })).toBeVisible()
  // The reviewed pixel baseline uses macOS fonts; semantic/style assertions run on every OS.
  if (process.platform === 'darwin') {
    await expect(preview.locator('article').first()).toHaveScreenshot('docx-report.png', {
      maxDiffPixelRatio: 0.02
    })
  }
  await page.screenshot({ path: testInfo.outputPath('report.png'), fullPage: true })
})
