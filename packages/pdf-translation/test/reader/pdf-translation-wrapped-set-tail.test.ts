import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([false, true])(
  'joins a finite-set prose tail only on the shared row, raised=%s',
  (raised) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Body',
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height: 10,
      transform: [10, 0, 0, 10, x, y],
      fontName,
      fontAscent: 0.75,
      fontDescent: -0.25,
      fontVertical: false,
      hasEOL
    })
    const prose = [
      'This paragraph describes each item in the resulting sequence of observations.',
      'The argument continues while all elements in the collection can still be counted.',
      'The proof gives the distribution of the first repeat in the sequence of uniform samples'
    ]
    const suffix = '] (the earliest match within a pair of independently chosen points).'
    const items = [
      item(prose[0], 87, 780, 426, 'Body', true),
      item(prose[1], 72, 768, 451, 'Body', true),
      item(prose[2], 72, 756, 451, 'Body', true),
      item('on [', 72, 744, 16),
      item('m', 88, raised ? 746 : 744, 6, 'Math'),
      item(suffix, 94, 744, 278)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const text = prose.join(' ')
    if (raised) {
      expect(units.map(({ source }) => source)).toEqual([text, 'on [m', suffix])
      expect(units[1]).toMatchObject({ sourceOnly: true, preserve: 'formula' })
    } else {
      expect(units.map(({ source }) => source)).toEqual([`${text} on [m${suffix}`])
      expect(units[0].sourceOnly).toBeUndefined()
    }
    expect(units.flatMap(({ originalStrings }) => originalStrings)).toEqual(
      items.map(({ str }) => str)
    )
  }
)
