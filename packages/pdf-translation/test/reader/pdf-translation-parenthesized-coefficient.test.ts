import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([false, true])(
  'keeps a stacked parenthesized coefficient independent of prose (offset=%s)',
  (offset) => {
    const body = 'The reading gives the scale factor'
    const next = '. Record the value in the log.'
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      size: number,
      fontName: string,
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height: size,
      transform: [size, 0, 0, size, x, y],
      fontName,
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false,
      hasEOL
    })
    const items = [
      item(body, 60, 518, 150, 10, 'body'),
      item('(', 212.5, 518, 4.2, 10, 'math'),
      item('3', 216.7, 524, 4.3, 7.2, 'math'),
      item('𝑥', 221, 524, 4.4, 7.2, 'math'),
      item('', 218, 513, 0, 0, 'math', true),
      item('𝑛', offset ? 220 : 218, 513, 6.3, 7.2, 'math'),
      item(')', 225.5, 518, 4.2, 10, 'math'),
      item(next, 229.7, 518, 131, 10, 'body', true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const coefficient = units.find((unit) => unit.source === '(3𝑥/𝑛)')
    if (offset) {
      expect(coefficient).toBeUndefined()
    } else {
      expect(units).toEqual([
        expect.objectContaining({ source: body, items: ['1:0'] }),
        expect.objectContaining({
          source: '(3𝑥/𝑛)',
          sourceOnly: true,
          preserve: 'formula',
          items: ['1:1', '1:2', '1:3', '1:5', '1:6']
        }),
        expect.objectContaining({ source: next, items: ['1:7'] })
      ])
    }
    const covered = units.flatMap(({ items }) => items).sort()
    expect(covered).toEqual(['1:0', '1:1', '1:2', '1:3', '1:5', '1:6', '1:7'])
  }
)
