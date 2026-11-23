import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each(['R45670PREVIEW', 'R45671PREVIEW'])(
  'retains a matching media variant (%s)',
  (identifier) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL = true,
      fontName = 'Body'
    ): PdfLayoutTextItem => ({
      str,
      width,
      height: 10,
      dir: 'ltr',
      hasEOL,
      fontName,
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false,
      transform: [10, 0, 0, 10, x, y]
    })
    const items = [
      item('Recorded demonstrations', 120, 587, 145),
      item('High and low resolution versions, respectively, of the video clips', 120, 530, 355),
      item('describing the field trials are available in', 120, 517.5, 184),
      item('R45670', 124, 492.5, 40, false, 'Code'),
      item('and', 169, 492.5, 17),
      item(identifier, 124, 469, 83, false, 'Code'),
      item('.', 207, 469, 3),
      item('In these recordings, the camera stays at the same distance.', 137, 438.5, 290),
      item('We compared the same section from each demonstration.', 120, 422, 275)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const variant = units.find((unit) => unit.items.includes('1:5'))
    expect(variant?.source).toBe(identifier + '.')
    expect(variant?.items).toEqual(['1:5', '1:6'])
    expect(variant?.sourceOnly).toBe(identifier.startsWith('R45670') ? true : undefined)
    expect(units.find((unit) => unit.items.includes('1:3'))?.sourceOnly).toBeUndefined()
    expect(units.flatMap(({ items }) => items).sort()).toEqual(
      items.map((_, index) => `1:${index}`)
    )
  }
)
