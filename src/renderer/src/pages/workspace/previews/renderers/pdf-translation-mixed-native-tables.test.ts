import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from './pdf-translation-layout'

const table = (change = 'valid'): PdfLayoutTextItem[] => {
  const run = (
    str: string,
    x: number,
    y: number,
    width: number,
    hasEOL = false,
    fontName = 'body',
    font = 10
  ): PdfLayoutTextItem => ({
    str,
    width,
    height: font,
    fontName,
    hasEOL,
    dir: 'ltr',
    transform: [font, 0, 0, font, x, 800 - y]
  })
  const items =
    change === 'no-header'
      ? []
      : [
          run('Method', 40, 80, 35, false, 'bold'),
          run('Unit', 194, 75, 22, false, 'bold'),
          run('Type', 194, 85, 22, false, 'bold'),
          run('Architecture', 280, 80, 70, false, 'bold'),
          run('Error', 404, 80, 30, true, 'bold')
        ]
  for (let row = 0; row < (change === 'two-rows' ? 2 : 4); row++) {
    const y = 110 + row * (change === 'distant-records' ? 70 : 18)
    items.push(
      run(`Model ${String.fromCharCode(65 + row)}`, 40, y, 60),
      run(
        'Logistic',
        190 + (change === 'drifting-columns' ? row * 10 : 0),
        y,
        30,
        false,
        change === 'foreign-font' ? `body-${row}` : 'body'
      ),
      run(
        '2 layers, 800 units',
        270,
        y,
        change === 'overlapping-columns' ? 145 : 90,
        false,
        'body',
        change === 'foreign-size' ? 12 : 10
      ),
      run(
        change === 'missing-values' ? 'Unknown' : '1.25',
        410,
        y,
        18,
        change !== 'unserialized-records'
      )
    )
    if (change === 'intervening-prose' && row < 3)
      items.push(run('This separate sentence spans the page.', 40, y + 9, 400, true))
  }
  return items
}
const extract = (items: PdfLayoutTextItem[]): ReturnType<typeof groupPdfTranslationPages> =>
  groupPdfTranslationPages({ pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }] })

it('keeps mixed native records and centered wrapped headers in their own cells', () => {
  const items = table(),
    result = extract(items)
  expect(result.units.filter((unit) => /^Model [A-D]$/u.test(unit.source))).toHaveLength(4)
  expect(result.units.filter((unit) => unit.source === 'Logistic')).toHaveLength(4)
  expect(result.units.filter((unit) => unit.source === '2 layers, 800 units')).toHaveLength(4)
  expect(result.units.filter((unit) => unit.source === '1.25')).toHaveLength(4)
  expect(result.units.find((unit) => unit.source === 'Unit Type')?.items).toHaveLength(2)
  expect(result.units.flatMap((unit) => unit.items)).toHaveLength(items.length)
  expect(new Set(result.units.flatMap((unit) => unit.items)).size).toBe(items.length)
})
it.each([
  'no-header',
  'two-rows',
  'distant-records',
  'drifting-columns',
  'foreign-font',
  'foreign-size',
  'missing-values',
  'overlapping-columns',
  'unserialized-records',
  'intervening-prose'
])('does not establish mixed table ownership from %s', (change) => {
  expect(
    extract(table(change)).pages[0].blocks.some(
      (block) => block.tableCell && block.source === 'Logistic'
    )
  ).toBe(false)
})
