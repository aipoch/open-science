import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([false, true])(
  'keeps measured table values in their native columns (shifted=%s)',
  (shifted) => {
    const rowItem = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL = false,
      fontName = 'Body'
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height: 9,
      transform: [9, 0, 0, 9, x, y],
      fontName,
      fontAscent: 0.71,
      fontDescent: -0.19,
      fontVertical: false,
      hasEOL
    })

    const labels = ['Cool, Low.', 'Cool, High.', 'Warm, Low.', 'Warm, High.']
    const data = labels.flatMap((label, n) => {
      const y = 540 - (n + 1) * 16.5
      const x = n === 2 && shifted ? 491 : 483
      return [
        rowItem(label, 345, y, 52),
        rowItem('7.20', 424, y, 15),
        rowItem('±', 440, y, 7, false, 'Symbol'),
        rowItem('0.12', 448, y, 16),
        ...(n % 2 === 0
          ? [
              rowItem('8.16', x, y, 15),
              rowItem('±', x + 16, y, 7, false, 'Symbol'),
              rowItem('0.09', x + 24, y, 16, true)
            ]
          : [rowItem('—', 499, y, 9, true)])
      ]
    })
    const items = [
      rowItem('Table 2.', 315, 565, 34),
      rowItem('Test results for each condition.', 353, 565, 139, true),
      rowItem('LOAD (m/s)', 418, 540, 50),
      rowItem('FLOW (m/s)', 479, 540, 48, true),
      ...data
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })

    for (const label of labels) {
      const owner = units.find((unit) => unit.source === label)
      if (!shifted) expect(owner).toMatchObject({ items: [expect.any(String)] })
    }
    const measured = units.filter((unit) => unit.source === '7.20 ± 0.12')
    if (shifted) {
      expect(measured).toHaveLength(0)
    } else {
      expect(measured).toHaveLength(4)
      expect(measured.every((unit) => unit.sourceOnly && unit.items.length === 3)).toBe(true)
      expect(units.filter((unit) => unit.source === '8.16 ± 0.09' && unit.sourceOnly)).toHaveLength(
        2
      )
    }
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(items.map((_, n) => '1:' + n).sort())
  }
)
