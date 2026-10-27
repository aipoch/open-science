import { expect, test, type Locator } from '@playwright/test'
import { createDocxStyleFixture } from '../../test/fixtures/docx-table-styles'

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
  const paper = preview.locator('section.docx').first()
  await expect(paper).toHaveCSS('padding-left', '75.6px')
  await expect(preview.getByText('神经信号研究报告', { exact: true })).toHaveCSS(
    'font-size',
    '22.6667px'
  )
  await expect(preview.getByText('能耗比较', { exact: true })).toHaveCSS('font-size', '18.6667px')
  await expect(preview.getByText('整理原始资料。', { exact: true })).toHaveCSS('font-size', '14px')
  await expect(table.getByText('肽/蛋白类', { exact: true })).toHaveCSS('font-size', '12.6667px')
  await expect(table.locator('td').first()).toHaveCSS('padding-top', '4px')
  await expect(table.locator('td').first()).toHaveCSS('padding-left', '5.33333px')
  await expect(table.locator('tr')).toHaveCount(4)
  await expect(table.locator('tr').first().locator('td').first()).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)'
  )
  // Every cell needs four visible edges: this covers the frame and both internal grid directions.
  for (const cell of await table.locator('td').all()) {
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      await expect(cell).toHaveCSS(`border-${edge}-style`, 'solid')
      await expect(cell).toHaveCSS(`border-${edge}-color`, 'rgb(128, 128, 128)')
      expect(
        await cell.evaluate(
          (node, side) =>
            parseFloat(getComputedStyle(node).getPropertyValue(`border-${side}-width`)),
          edge
        )
      ).toBeGreaterThan(0)
    }
  }
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
  await page.setViewportSize({ width: 360, height: 640 })
  // The fixture starts at a fixed desktop width; resize the owning panel too.
  await preview.evaluate((node) => (node.style.width = '300px'))
  await expect(paper).toHaveCSS('width', '793.719px')
  await expect.poll(async () => (await paper.boundingBox())!.width).toBeLessThanOrEqual(300)
})

// Use the production loader with independent OOXML fixtures, not browser-injected CSS.
for (const scenario of [
  {
    name: 'explicit paragraph and character styles',
    options: { styledContent: true, defaultStyle: true, nested: true, direct: true }
  },
  {
    name: 'row over column without corner formatting',
    options: {
      tableLook: 'w:firstColumn="1"',
      extraStyles:
        '<w:tblStylePr w:type="firstCol"><w:tcPr><w:shd w:fill="0000FF"/></w:tcPr></w:tblStylePr>'
    }
  },
  {
    name: 'column band over row band',
    options: { firstRow: false, banding: true, verticalBanding: true }
  },
  {
    name: 'zero-sized style bands',
    options: {
      firstRow: false,
      banding: true,
      verticalBanding: true,
      styleBandSize: 0,
      styleColBandSize: 0
    }
  },
  {
    name: 'zero-sized table bands',
    options: {
      firstRow: false,
      banding: true,
      verticalBanding: true,
      styleBandSize: 2,
      styleColBandSize: 2,
      rowBandSize: 0,
      colBandSize: 0,
      rowHints: ['000000100000']
    }
  }
]) {
  test(`DOCX cascade: ${scenario.name}`, async ({ page }) => {
    await page.route('**/*.docx', (route) =>
      route.fulfill({ body: Buffer.from(createDocxStyleFixture(scenario.options)) })
    )
    await page.goto('/docx-table-borders.html?report=1')
    const preview = page.locator('[data-office-preview-ready="true"]')
    await expect(preview).toBeVisible()
    const text = (value: string): Locator => preview.getByText(value, { exact: true })
    const cell = (value: string): Locator => text(value).locator('xpath=ancestor::td[1]')
    if (scenario.options.styledContent) {
      await expect(text('Cell heading')).toHaveCSS('font-size', '29.3333px')
      await expect(text('Cell heading')).toHaveCSS('font-family', 'Georgia')
      for (const value of ['inline_code', 'heading_code']) {
        await expect(text(value)).toHaveCSS('font-family', '"Courier New"')
        await expect(text(value)).toHaveCSS('font-size', '12px')
      }
      await expect(text('direct_code')).toHaveCSS('font-family', 'Verdana')
      await expect(text('direct_code')).toHaveCSS('font-size', '21.3333px')
      await expect(text('nested')).toHaveCSS('font-size', '13.3333px')
      await expect(cell('nested')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(text('0-0')).toHaveCSS('font-weight', '400')
    } else if (scenario.options.tableLook) {
      await expect(cell('0-0')).toHaveCSS('background-color', 'rgb(242, 244, 247)')
      await expect(cell('1-0')).toHaveCSS('background-color', 'rgb(0, 0, 255)')
    } else if (scenario.options.styleBandSize === undefined) {
      await expect(cell('0-0')).toHaveCSS('background-color', 'rgb(170, 187, 204)')
      await expect(cell('1-1')).toHaveCSS('background-color', 'rgb(204, 187, 170)')
    } else {
      for (const value of ['0-0', '0-1', '1-0', '1-1', '2-0', '2-1']) {
        await expect(cell(value)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      }
    }
  })
}
