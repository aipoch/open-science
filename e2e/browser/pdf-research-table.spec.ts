import { expect, test } from '@playwright/test'

for (const dark of [false, true]) {
  test(`merged PDF table has a consistent grid and cell hover in ${dark ? 'dark' : 'light'} theme`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/pdf-research-table.html${dark ? '?dark' : ''}`)
    const table = page.getByRole('table', { name: 'Candidate table' })
    const cells = table.locator('td')
    await expect(cells).toHaveCount(22)
    await page.mouse.move(0, 0)
    const baseline = await cells.evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element)
        return {
          background: style.backgroundColor,
          weight: style.fontWeight,
          align: style.textAlign,
          borders: ['Top', 'Right', 'Bottom', 'Left'].map((edge) => ({
            width: style.getPropertyValue(`border-${edge.toLowerCase()}-width`),
            style: style.getPropertyValue(`border-${edge.toLowerCase()}-style`),
            color: style.getPropertyValue(`border-${edge.toLowerCase()}-color`)
          }))
        }
      })
    )
    // Both header levels, merged labels and numeric values share one surface/alignment.
    expect(new Set(baseline.map(({ background }) => background)).size).toBe(1)
    expect(new Set(baseline.map(({ weight }) => weight)).size).toBe(1)
    expect(new Set(baseline.map(({ align }) => align))).toEqual(new Set(['start']))
    for (const cell of baseline) {
      for (const border of cell.borders) {
        expect(border.width).toBe('1px')
        expect(border.style).toBe('solid')
        expect(border.color).not.toBe('rgba(0, 0, 0, 0)')
      }
    }
    await expect(table.getByRole('cell', { name: 'FGFR2', exact: true })).toHaveAttribute(
      'rowspan',
      '4'
    )
    await expect(table.getByRole('cell', { name: 'CLDN18', exact: true })).toHaveAttribute(
      'colspan',
      '2'
    )
    // Real pointer input must highlight exactly one cell, including below a rowspan's origin row.
    for (const text of ['237', '70.5%', 'FGFR2', 'CLDN18', 'Total', 'Positive']) {
      const target = table.getByRole('cell', { name: text, exact: true })
      // 'Positive' occurs in both the header and the body; exercise the second header level.
      await target.first().hover()
      await expect
        .poll(() =>
          cells.evaluateAll(
            (elements, backgrounds) =>
              elements
                .map(
                  (element, index) =>
                    getComputedStyle(element).backgroundColor !== backgrounds[index]
                )
                .filter(Boolean).length,
            baseline.map(({ background }) => background)
          )
        )
        .toBe(1)
    }
    await page.mouse.move(0, 0)
    await expect
      .poll(() =>
        cells.evaluateAll((elements) => elements.map((el) => getComputedStyle(el).backgroundColor))
      )
      .toEqual(baseline.map(({ background }) => background))
    await page.screenshot({ path: testInfo.outputPath('merged-table.png') })
    await page.setViewportSize({ width: 375, height: 812 })
    const scroller = page.getByRole('region', { name: 'Candidate table' })
    expect(await scroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true
    )
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await scroller.focus()
    await expect(scroller).toBeFocused()
  })
}
