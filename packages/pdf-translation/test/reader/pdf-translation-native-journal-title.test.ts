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
  size = 10,
  fontName = 'Body',
  hasEOL = false
): PdfLayoutTextItem => ({
  str,
  dir: 'ltr',
  width,
  height: size,
  transform: [size, 0, 0, size, x, y],
  fontName,
  fontFamily: 'serif',
  fontAscent: 0.8,
  fontDescent: -0.2,
  fontVertical: false,
  hasEOL
})

it.each(['matched', 'different section', 'misaligned title', 'no DOI'] as const)(
  'joins a centered journal title using its repeated section heading (%s)',
  (shape) => {
    const title = 'LIMIT BOUNDS FROM MAXWELL’S ESTIMATE-ANOTHER'
    const heading =
      shape === 'different section'
        ? 'Limit Bounds from Maxwell’s Estimate -Another Result'
        : 'Limit Bounds from Maxwell’s Estimate -Another Proof'
    const page: PdfLayoutPage = {
      page: 1,
      width: 612,
      height: 792,
      rotation: 0,
      items: [
        item('Example Journal 17, 23–31 (2018)', 97, 642, 122, 9, 'Imprint', true),
        item(
          shape === 'no DOI' ? 'Published by Example Press' : 'DOI: 10.4321/record.2',
          97,
          630,
          130,
          9,
          'Imprint'
        ),
        item('', 105, 613, 0, 10, 'Title', true),
        item(title, 105, 613, 394, 10, 'Title', true),
        item('PROOF', shape === 'misaligned title' ? 286 : 281, 599, 42, 10, 'Title'),
        item('', 252, 569, 0, 8, 'Byline', true),
        item('JUNE RIVERA', 252, 569, 100, 8, 'Byline'),
        item('', 131, 517, 0, 8, 'Abstract', true),
        item('Abstract.', 131, 517, 42, 8, 'Abstract'),
        item(
          'We give independent bounds for a simple geometric estimate.',
          178,
          517,
          290,
          8,
          'Byline',
          true
        ),
        item('', 129, 480, 0, 10, 'Body', true),
        item('1.', 129, 480, 8, 10, 'Body'),
        item(heading, 145, 480, 325, 10, 'Section'),
        item(
          'The previous estimates apply under the assumptions stated here.',
          100,
          435,
          380,
          10,
          'Body',
          true
        )
      ]
    }

    const { units } = groupPdfTranslationPages({ pages: [page] })
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      page.items.flatMap(({ str }, index) => (str ? ['1:' + index] : [])).toSorted()
    )
    const titleOwner = units.find((unit) => unit.items.includes('1:3'))
    const tailOwner = units.find((unit) => unit.items.includes('1:4'))
    expect(titleOwner?.source).toBe(shape === 'matched' ? title + ' PROOF' : title)
    if (shape === 'matched') expect(tailOwner).toBe(titleOwner)
    else expect(tailOwner?.source).toBe('PROOF')
    expect(units.find((unit) => unit.items.includes('1:12'))?.source).toBe('1. ' + heading)
  }
)
