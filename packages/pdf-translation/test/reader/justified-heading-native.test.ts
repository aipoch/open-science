import { expect, it } from 'vitest'
import { readPdfTranslationCases } from '../fixtures/read-cases'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

const fixture = readPdfTranslationCases<{ page: PdfLayoutPage }>(
  'justified-heading-native.jsonl'
)[0]
const read = (page: PdfLayoutPage): ReturnType<typeof groupPdfTranslationPages> =>
  groupPdfTranslationPages({ pages: [page], pageCount: 1 })

it('joins a justified title at its peer-proved hanging origin and stops at the body', () => {
  const page = structuredClone(fixture.page),
    result = read(page)
  const heading = result.units.find((unit) => unit.items.includes('1:2'))!
  expect(heading.source).toBe('2.3 Robust methods can support stable updates')
  expect(heading.items).toEqual(['1:2', '1:4', '1:5'])
  expect(result.units.find((unit) => unit.items.includes('1:7'))?.source).toMatch(
    /^Ordinary explanations/
  )
  const indices = page.items.flatMap((item, index) => (item.str.trim() ? [`1:${index}`] : []))
  const claims = result.units.flatMap((unit) => unit.items)
  expect(new Set(claims).size).toBe(claims.length)
  expect([...claims].sort()).toEqual(indices.sort())
})

it.each([
  'missing-peer',
  'wrong-rail',
  'wrong-font',
  'rotation',
  'native-gap',
  'body-font',
  'body-gap',
  'missing-body',
  'missing-line-end',
  'wrong-label-gap',
  'gap-font',
  'gap-width',
  'gap-rotation'
])('keeps an unproved title tail separate: %s', (fault) => {
  const page = structuredClone(fixture.page),
    items = page.items
  const main = items[4],
    tail = items[5],
    body = items[7],
    peer = items[9]
  if (fault === 'missing-peer') peer.str = '2.8'
  if (fault === 'wrong-rail') tail.transform[4] -= 8
  if (fault === 'wrong-font') tail.fontName = 'other'
  if (fault === 'rotation') main.transform[1] = 1
  if (fault === 'native-gap')
    items.splice(5, 0, { ...main, str: 'foreign', width: 20, transform: [12, 0, 0, 12, 300, 500] })
  if (fault === 'body-font') body.fontName = 'other'
  if (fault === 'body-gap') body.transform[5] -= 20
  if (fault === 'missing-body') items.splice(7, 1)
  if (fault === 'missing-line-end') main.hasEOL = false
  if (fault === 'wrong-label-gap') main.transform[4] -= 2
  if (fault === 'gap-font') items[3].fontName = 'other'
  if (fault === 'gap-width') items[3].width -= 3
  if (fault === 'gap-rotation') items[3].transform[1] = 1
  const heading = read(page).units.find((unit) => unit.items.includes('1:2'))!
  const tailIndex = items.findIndex((item) => item.str === 'stable updates')
  expect(heading.items).not.toContain(`1:${tailIndex}`)
})

it.each([
  { major: false, displacement: 0 },
  { major: true, displacement: 0 },
  { major: true, displacement: 7 }
])(
  'joins a centered numbered column heading ($major, $displacement)',
  ({ major, displacement }) => {
    const marker = major ? '3.' : '3.2.'
    const head = major ? 'DATA PROCESSING AND ADDITIONAL' : 'Measurement filtering and quality'
    const tail = major ? 'QUALITY TESTS' : 'checks'
    const titleFont = major ? 'body' : 'italic'
    const markerWidth = major ? 7 : 16
    const firstX = major ? 346 : 336.5
    const leadWidth = major ? 177 : 188
    const leadX = firstX + markerWidth + 6
    const tailWidth = major ? 130 : 41
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      height = 10,
      hasEOL = true
    ): PdfLayoutPage['items'][number] => ({
      str,
      width,
      height,
      dir: 'ltr',
      fontName,
      hasEOL,
      transform: [height, 0, 0, height, x, y],
      fontVertical: false
    })
    const items = [
      row('A separate paragraph establishes the surrounding discussion.', 320, 630, 242, 'body'),
      row(marker, firstX, 605, markerWidth, major ? 'number' : 'body', major ? 9 : 10, false),
      row(head, leadX, 605, leadWidth, titleFont),
      row(tail, leadX + (leadWidth - tailWidth) / 2 + displacement, 592.5, tailWidth, titleFont),
      row(
        'The observations are computed with the procedure described below.',
        329,
        576,
        233,
        'body'
      ),
      row('All estimates use the original measurements for each period.', 320, 563.5, 242, 'body'),
      row(
        'A final calculation checks the precision against another estimate.',
        320,
        551,
        242,
        'body'
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const heading = units.find((unit) => unit.items.includes('1:1'))!
    expect(heading.source).toBe(`${marker} ${head}${displacement ? '' : ' ' + tail}`)
    expect(heading.items).toEqual(displacement ? ['1:1', '1:2'] : ['1:1', '1:2', '1:3'])
    expect(units.find((unit) => unit.items.includes('1:4'))?.source).toMatch(/^The observations/u)
  }
)

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  fontName = 'Body',
  hasEOL = false
): PdfLayoutPage['items'][number] => ({
  str,
  width,
  height: str.trim() ? 11 : 0,
  transform: [11, 0, 0, 11, x, y],
  fontName,
  dir: 'ltr',
  fontVertical: false,
  fontAscent: 0.9,
  fontDescent: -0.2,
  hasEOL
})
it.each([0, 7])(
  'joins a split Roman heading above an independently styled subsection (offset %s)',
  (shift) => {
    const items = [
      item(
        'The estimation method is defined independently of the following results.',
        320,
        530,
        220,
        'Body',
        true
      ),
      item('An additional reading was taken during the second test.', 320, 517, 205, 'Body', true),
      item('I', 340, 480, 4),
      item('V', 344, 480, 8),
      item('. MEASUREMENT: ACCURACY AND', 352, 480, 168),
      item('', 392 + shift, 467.4, 0, 'Body', true),
      item('PRECISION', 392 + shift, 467.4, 76),
      item('', 320, 442.2, 0, 'Italic', true),
      item('A. Calibration', 320, 442.2, 94, 'Italic'),
      item('', 320, 429.6, 0, 'Body', true),
      item('The', 320, 429.6, 20),
      item('readings were made under equal conditions.', 345, 429.6, 195),
      item('', 320, 417, 0, 'Body', true),
      item('A stable grid was used for each independent trial.', 320, 417, 220),
      item('', 320, 404.4, 0, 'Body', true),
      item('Final values were retained for comparison.', 320, 404.4, 188)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const heading = units.find((unit) => unit.items.includes('1:2'))!
    expect(heading.source).toBe(
      shift ? 'IV. MEASUREMENT: ACCURACY AND' : 'IV. MEASUREMENT: ACCURACY AND PRECISION'
    )
    expect(heading.items).toEqual(shift ? ['1:2', '1:3', '1:4'] : ['1:2', '1:3', '1:4', '1:6'])
    expect(units.find((unit) => unit.items.includes('1:8'))?.source).toMatch(/^A\. Calibration/u)
  }
)

it.each(['aligned', 'shifted', 'body style'])(
  'joins a centered unnumbered section in its native body column (%s)',
  (shape) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      height = 10,
      fontName = 'Body'
    ): PdfLayoutPage['items'][number] => ({
      str,
      width,
      height,
      dir: 'ltr',
      fontName,
      hasEOL: true,
      fontVertical: false,
      transform: [height, 0, 0, height, x, y]
    })
    const heading = 'COMPARING INDEPENDENT MEASUREMENTS'
    const continuation = 'ACROSS PERIODS'
    const height = shape === 'body style' ? 10 : 12
    const font = shape === 'body style' ? 'Body' : 'Heading'
    const items = [
      row('The preceding paragraph ends at the same right-hand edge.', 315, 481, 224),
      row(heading, 325, 441, 205, height, font),
      row(continuation, shape === 'shifted' ? 374 : 365, 427, 125, height, font),
      row('The independent effects are compared in the sections below.', 325, 404, 215),
      row('Each value is based on measurements from a different trial.', 315, 392.5, 225),
      row('The next stage accounts for variation among the trials.', 315, 381, 220)
    ]
    const { units } = read({ page: 1, width: 612, height: 792, rotation: 0, items })
    const title = units.find((unit) => unit.items.includes('1:1'))
    expect(title?.source).toBe(shape === 'aligned' ? `${heading} ${continuation}` : heading)
    expect(title?.items).toEqual(shape === 'aligned' ? ['1:1', '1:2'] : ['1:1'])
    expect(units.find((unit) => unit.items.includes('1:3'))?.source).toMatch(
      /^The independent effects/u
    )
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(items.map((_, i) => `1:${i}`))
  }
)

it.each(['aligned', 'shifted', 'mixed faces'])(
  'joins a hanging decimal heading above a separately indented paragraph (%s)',
  (shape) => {
    const title = '2.4. Calibrating the panel for',
      suffix = 'LED response measurements',
      items = [
        item(
          'A reference grid is captured before updating the independent channels.',
          40,
          515,
          250,
          'Body',
          true
        ),
        item('The process restarts after the evaluation completes.', 40, 502, 218, 'Body', true),
        item('', 40, 470, 0, 'Title', true),
        item(title, 40, 470, 250, 'Title', true),
        item(
          suffix,
          shape === 'shifted' ? 68 : 62,
          456.8,
          106,
          shape === 'mixed faces' ? 'Other' : 'Title'
        ),
        item('', 51, 433, 0, 'Body', true),
        item(
          'A separate panel returns the final calibration for each channel.',
          51,
          433,
          239,
          'Body',
          true
        ),
        item(
          'Measurements continue at the edge of the same body column.',
          40,
          419.8,
          250,
          'Body',
          true
        )
      ]
    const { units } = read({ page: 1, width: 600, height: 800, rotation: 0, items })
    const heading = units.find((unit) => unit.items.includes('1:3'))
    expect(heading?.source).toBe(shape === 'aligned' ? `${title} ${suffix}` : title)
    expect(heading?.items).toEqual(shape === 'aligned' ? ['1:3', '1:4'] : ['1:3'])
    const claims = units.flatMap((unit) => unit.items).sort()
    expect(claims).toEqual(['1:0', '1:1', '1:3', '1:4', '1:6', '1:7'])
  }
)
