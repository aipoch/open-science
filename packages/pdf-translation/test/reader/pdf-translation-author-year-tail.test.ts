import { expect, test } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

const row = (
  str: string,
  x: number,
  y: number,
  width: number,
  hasEOL = true
): PdfLayoutTextItem => ({
  str,
  dir: 'ltr',
  width,
  height: str.trim() ? 10 : 0,
  transform: [10, 0, 0, 10, x, y],
  fontName: 'Body',
  fontAscent: 0.7,
  fontDescent: -0.2,
  fontVertical: false,
  hasEOL
})

test('requires a measured native sentence break to restore a short citation tail', () => {
  const tail = 'field [AB24].'
  const items = [
    row('Our procedure uses repeated sampling with a carefully chosen', 60, 637.5, 460),
    row('interval so all stations report during the same observation', 60, 625, 460),
    row('period. The estimated response time is', 60, 612.5, 182, false),
    row(' ', 242, 612.5, 4, false),
    { ...row('x', 246, 612.5, 5, false), fontName: 'Variable' },
    row(' ', 251, 612.5, 4, false),
    row('seconds, including the time needed to observe the entire magnetic', 255, 612.5, 265),
    row(tail, 60, 600, 62, false),
    row(' ', 122, 600, 6.5, false),
    row(
      'Note that the procedure starts after the initial sampling pass and uses',
      128.5,
      600,
      391.5
    ),
    row(
      'the original interval for all readings. The recorded values remain equally',
      60,
      587.5,
      460
    ),
    row('useful for identifying independent errors in the response after the final', 60, 575, 460),
    row('recording cycle.', 60, 562.5, 75)
  ]
  const page = { page: 3, width: 600, height: 800, rotation: 0, items }
  const restored = groupPdfTranslationPages({ pages: [page] }).units
  const incomplete = groupPdfTranslationPages({
    pages: [
      { ...page, items: items.map((item, index) => (index === 8 ? { ...item, width: 2 } : item)) }
    ]
  }).units
  expect(restored).toHaveLength(3)
  expect(restored[1]).toMatchObject({ source: tail, items: ['3:7'], originalStrings: [tail] })
  expect(restored[1].sourceOnly).toBeUndefined()
  expect(restored[1].preserve).toBeUndefined()
  expect(incomplete).toEqual([
    restored[0],
    { ...restored[1], sourceOnly: true, preserve: 'formula' },
    restored[2]
  ])
})
