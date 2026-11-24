import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

const run = (
  str: string,
  x: number,
  y: number,
  width: number,
  hasEOL = false,
  fontName = 'Body',
  height = 10
): PdfLayoutTextItem => ({
  str,
  width,
  height,
  dir: 'ltr',
  transform: [height, 0, 0, height, x, y],
  fontName,
  fontAscent: 0.72,
  fontDescent: -0.2,
  fontVertical: false,
  hasEOL
})

it.each([false, true])(
  'keeps a native variable definition on its own row (offset=%s)',
  (offset) => {
    const items = [
      run('The scale follows from the measured quantities:', 52, 452, 210, true),
      run('A', 132, 433, 8, false, 'Math'),
      run('v,', 140, 431.5, 6, false, 'Script', 7),
      run('ref', 146, 431.5, 12, false, 'Small', 7),
      run('∼ ', 161, 433, 10, false, 'Symbol'),
      run('√', 171, 439.7, 8, false, 'Symbol'),
      run('μλ', 179, 433, 12, false, 'Math'),
      run('2', 192, 437, 4, false, 'Small', 7),
      run('k/F ,', 196.5, 433, 21, false, 'Math'),
      run('(2)', 285, 433, 10, true),
      run('where', 52, 415, 25, false),
      run('μ', 79, 415, 5, false, 'Math'),
      run('is the contrast,', 86, offset ? 413.5 : 415, 58),
      run('λ', 146, offset ? 413.5 : 415, 6, false, 'Math'),
      run('is the reference value,', 154, offset ? 413.5 : 415, 88),
      run('k', 244, offset ? 413.5 : 415, 4, false, 'Math'),
      run('is the mixing', 250, offset ? 413.5 : 415, 45, true),
      run('coefficient. The scale follows from the reference sample.', 52, 404.5, 243, true),
      run('All measurements use the same protocol.', 62, 391, 185, true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const definition = units.find((unit) => unit.items.includes('1:10'))
    expect(definition?.items.includes('1:12')).toBe(!offset)
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(items.map((_, n) => '1:' + n).sort())
  }
)
