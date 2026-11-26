import { expect, it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from '../../src/reader/layout.js'

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  size = 8,
  fontName = 'Imprint',
  hasEOL = true
): PdfLayoutTextItem => ({
  str,
  dir: 'ltr',
  width,
  height: size,
  transform: [size, 0, 0, size, x, y],
  fontName,
  fontFamily: 'serif',
  fontAscent: 0.75,
  fontDescent: -0.25,
  fontVertical: false,
  hasEOL
})

it.each([
  ['placeholder', 'DOI: 00.0000/X00000000X', true],
  ['issued identifier', 'DOI: 10.4321/Example.2', true],
  ['displaced', 'DOI: 00.0000/X00000000X', false],
  ['prose', 'DOI: 10.4321/Example.2 is the reference.', false],
  ['no copyright mark', 'DOI: 00.0000/X00000000X', false]
] as const)(
  'identifies an imprint DOI only in its native copyright context (%s)',
  (shape, doi, retained) => {
    const page: PdfLayoutPage = {
      page: 1,
      width: 612,
      height: 792,
      rotation: 0,
      items: [
        item('Workshop on Applied Models', 57, 754, 136),
        item('Conference on Statistical Methods', 57, 745, 148),
        item('Editorial Office', 57, 736, 90),
        item(shape === 'no copyright mark' ? 'a' : '©', 287, 745, 8, 8, 'Logo', false),
        item('2020 Research Press', 298, 745, 120),
        item(doi, shape === 'displaced' ? 321 : 315, 736, 103),
        item('A New Estimate of Sampling Variance', 72, 705, 340, 17, 'Title'),
        item('J. Example and A. Sample', 115, 683, 220, 11, 'Byline'),
        item('Abstract', 79, 650, 40, 10, 'Main'),
        item(
          'We describe a method for normalizing sampling errors in observational studies.',
          79,
          635,
          462,
          10,
          'Main'
        )
      ]
    }

    const { units } = groupPdfTranslationPages({ pages: [page] })
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      page.items.map((_, index) => '1:' + index).toSorted()
    )
    const identified = units.find((unit) => unit.source === doi)
    expect(identified?.items).toEqual(['1:5'])
    expect(identified?.sourceOnly).toBe(retained ? true : undefined)
    expect(identified?.preserve).toBe(retained ? 'literal' : undefined)
  }
)
