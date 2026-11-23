import { expect, it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from '../../src/reader/layout.js'

type Variation = 'different rail' | 'trailing prose' | 'same-size entries'

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  fontName = 'Body',
  size = 10,
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

function page(variation?: Variation): PdfLayoutPage {
  const size = variation === 'same-size entries' ? 10 : 9
  const entry = (str: string, y: number, width: number, x = 55, hasEOL = true): PdfLayoutTextItem =>
    item(str, x, y, width, 'Reference', size, hasEOL)
  return {
    page: 1,
    width: 612,
    height: 792,
    rotation: 0,
    items: [
      ...[
        'The measurements use a simple field calculation and are shown for all recorded sites.',
        'The comparison begins with a fixed interval and a consistent sample selection rule.',
        'Quantities from both channels are accumulated for each instrument and displayed.',
        'The uncertainty estimates were computed separately by the system described above.',
        'Multiple calibration visits have been conducted to test the procedure at the site.',
        'Our group analyzed the effect of the instruments used in the recent observations.',
        'The results and limitations are described in the following companion notes.'
      ].map((text, index) => item(text, 55, 525 - index * 12, 382)),
      item('Acknowledgements', 55, 421, 91, 'Heading', 10, false),
      item('', 55, 0, 0),
      item(
        'The team thanks the observatory staff for their support during the study.',
        55,
        406,
        310
      ),
      item('References', 55, 374, 54, 'Heading', 10, false),
      item('', 55, 0, 0),
      entry('Morris, T., & Nolan, M. 2001,', 360, 124, 55, false),
      item('Journal of Field Studies', 182, 360, 108, 'Journal', size, false),
      entry(', 12, 245', 360, 37, 290),
      entry('Park, P. 2018, https://example.org/record', 349, 201),
      entry('Quinn, D., & Reed, B. 2020,', 338, 130, 55, false),
      item('Yearbook of Science', 188, 338, 91, 'Journal', size, false),
      entry(', 11, 15', 338, 35, 279),
      entry('Rios, C., Weaver, P., Ray, E., Lane, M., & Cooper, S. 2002,', 327, 345, 55, false),
      entry(
        'Bulletin of Generic Methods, 9, 41',
        317,
        160,
        variation === 'different rail' ? 105 : 75
      ),
      entry('Shea, A. 2004, https://example.org/further', 306, 210),
      entry('Tanner, S., Zimmer, K., Frost, T., Hart, T., & Holt, A. 2008,', 295, 355, 55, false),
      entry('Annals of Field Studies, 9, 24', 285, 160, 75),
      entry(
        variation === 'trailing prose'
          ? 'This narrative resumes after the material above.'
          : 'Zimmer, P. 2009, https://example.org/other',
        274,
        260
      )
    ]
  }
}

it.each([undefined, 'different rail', 'trailing prose', 'same-size entries'] as const)(
  'separates the terminal bibliography heading only with native record proof (%s)',
  (variation) => {
    const source = page(variation)
    const { units } = groupPdfTranslationPages({ pages: [source], pageCount: 1 })
    const headingIndex = source.items.findIndex(({ str }) => str === 'References')
    const heading = units.find((unit) => unit.items.includes('1:' + headingIndex))
    const owners = units.flatMap((unit) => unit.items)
    expect(owners.toSorted()).toEqual(
      source.items.flatMap(({ str }, index) => (str.trim() ? ['1:' + index] : [])).toSorted()
    )
    const tail = units.slice(units.indexOf(heading!))
    if (variation) {
      expect(heading?.source).toMatch(/^References /u)
      expect(tail.every((unit) => !unit.sourceOnly)).toBe(true)
    } else {
      expect(heading).toMatchObject({ source: 'References', items: ['1:' + headingIndex] })
      expect(tail.every((unit) => unit.sourceOnly && unit.preserve === 'reference')).toBe(true)
      expect(units[units.indexOf(heading!) - 1].sourceOnly).toBeUndefined()
    }
  }
)
