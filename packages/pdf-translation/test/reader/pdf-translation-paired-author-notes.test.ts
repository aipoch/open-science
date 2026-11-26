import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each(['†', '‡'])(
  'keeps two author notes on their native rows when the title uses %s',
  (mark) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      height = 10,
      fontName = 'Body',
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height,
      transform: [height, 0, 0, height, x, y],
      fontName,
      hasEOL,
      fontAscent: 0.72,
      fontDescent: -0.22,
      fontVertical: false
    })
    const items = [
      item('An example of a two author document', 203, 688, 207, 16, 'Title', true),
      item('First Writer', 176, 660, 75, 14, 'Title'),
      item('∗', 251, 665.5, 5.5, 9, 'Marker'),
      item('Second Writer', 306, 660, 87, 14, 'Title'),
      item(mark, 393, 665.5, 5.5, 9, 'Marker', true),
      item('', 71, 78.8, 0, 0, 'Marker', true),
      item('∗', 71, 78.8, 3.65, 6, 'Marker'),
      item('Institute One, 12345 Example, Country One, E-mail:', 75, 75, 241, 9, 'Footer'),
      item('sample@example.org', 320, 75, 83, 9, 'Email'),
      item('.', 403, 75, 2.6, 9, 'Footer'),
      item('', 71.1, 67.55, 0, 0, 'Marker', true),
      item('†', 71.1, 67.55, 3.43, 6, 'Marker'),
      item('Institute Two, 54321 Example, Country Two, E-mail:', 75, 63.75, 252, 9, 'Footer'),
      item('writer@example.net', 331, 63.75, 83, 9, 'Email'),
      item('.', 414, 63.75, 2.6, 9, 'Footer')
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const first = units.find((unit) => unit.items.includes('1:6'))
    const second = units.find((unit) => unit.items.includes('1:11'))
    if (mark === '†') {
      expect(first?.items).toEqual(['1:6', '1:7', '1:8', '1:9'])
      expect(second?.items).toEqual(['1:11', '1:12', '1:13', '1:14'])
      expect(second?.fragments[0].rect.y).toBeGreaterThan(first!.fragments[0].rect.bottom)
    } else {
      expect(first).toBe(second)
    }
    expect(units.flatMap((unit) => unit.originalStrings)).toEqual(
      items.filter((entry) => entry.str).map((entry) => entry.str)
    )
  }
)
