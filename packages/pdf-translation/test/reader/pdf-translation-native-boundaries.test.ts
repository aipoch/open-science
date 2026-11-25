/* eslint-disable @typescript-eslint/explicit-function-return-type -- infer small native fixtures */
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
  font = 'Body',
  size = 12,
  hasEOL = true
): PdfLayoutTextItem => ({
  str,
  dir: 'ltr',
  width,
  height: size,
  transform: [size, 0, 0, size, x, y],
  fontName: font,
  fontAscent: 0.7,
  fontDescent: -0.2,
  fontVertical: false,
  hasEOL
})
const body = (top = 540) =>
  Array.from({ length: 5 }, (_, n) =>
    item(
      'Ordinary explanatory text gives the complete context for the following independent observation.',
      72,
      top - n * 15,
      468
    )
  )
const extract = (items: PdfLayoutTextItem[], page = 1) =>
  groupPdfTranslationPages({
    pages: [{ page, width: 612, height: 792, rotation: 0, items } satisfies PdfLayoutPage]
  }).units

it.each([true, false])(
  'separates same-face Roman headings with a consecutive justified peer: %s',
  (consecutive) => {
    const input = [
      item('II. C', 55.5, 430, 23, 'Body', 10, false),
      item('OMPARISON OF THE REPEATED', 79, 430, 153, 'Body', 8, false),
      item('R-', 235, 430, 9.5, 'Body', 10, false),
      item('EADINGS', 245, 430, 48.5, 'Body', 8, false),
      item('', 59, 413.6, 0, 'Body', 0),
      item('We examine the readings from a set of sensors to obtain', 59, 413.6, 241, 'Body', 10),
      item(
        'a stable average for the conditions tested in this section.',
        49,
        401.6,
        251,
        'Body',
        10
      ),
      item('The measurements are kept for a later comparison.', 49, 389.6, 226, 'Body', 10),
      item(consecutive ? 'III. R' : 'IV. R', 402, 641, 25, 'Body', 10, false),
      item('ESULTS', 427.5, 641, 45.5, 'Body', 8, false),
      item('', 322, 626, 0, 'Body', 0),
      item('We record each response in the same calibrated range', 322, 626, 241, 'Body', 10),
      item('and compare these values at all of the sampling sites.', 312, 614, 251, 'Body', 10),
      item('A separate test uses the preceding control readings.', 312, 602, 221, 'Body', 10)
    ]
    const units = extract(input)
    const first = units.find((u) => u.items.includes('1:0'))
    expect(first?.items.includes('1:5')).toBe(!consecutive)
    if (consecutive) {
      expect(first?.items).toEqual(['1:0', '1:1', '1:2', '1:3'])
      expect(units.find((u) => u.items.includes('1:5'))?.source.startsWith('We examine')).toBe(true)
    }
  }
)
it.each([true, false])(
  'splits same-face Roman headings with consecutive openings in a single column: %s',
  (consecutive) => {
    const shortOpening = (y: number) => [
      { ...item('', 321.9, y, 0, 'Body', 10), height: 0 },
      item('We record each response in the same calibrated range', 321.9, y, 241.1, 'Body', 10),
      item(
        'and compare these values at the available sampling sites.',
        312,
        y - 12,
        251,
        'Body',
        10
      )
    ]
    const input = [
      item('III. C', 350.3, 465.3, 22.7, 'Body', 10, false),
      item('OMPARING', 373.5, 465.3, 41.2, 'Body', 8, false),
      item('F', 417.7, 465.3, 5.5, 'Body', 10, false),
      item('REQUENCY', 423.7, 465.3, 58, 'Body', 8, false),
      item('R', 484.7, 465.3, 6.1, 'Body', 10, false),
      item('ANGES', 491.3, 465.3, 33.5, 'Body', 8, false),
      ...shortOpening(448.5),
      item(consecutive ? 'IV. S' : 'V. S', 399.9, 164.1, 24.8, 'Body', 10, false),
      item('UMMARY', 425.2, 164.1, 50, 'Body', 8, false),
      ...shortOpening(147.3)
    ]
    const units = extract(input)
    const title = units.find((unit) => unit.items.includes('1:0'))
    const prose = units.find((unit) => unit.items.includes('1:7'))
    expect(title).toBeDefined()
    expect(prose).toBeDefined()
    if (consecutive) {
      expect(title?.items).toEqual(['1:0', '1:1', '1:2', '1:3', '1:4', '1:5'])
      expect(title?.source).toBe('III. COMPARING FREQUENCY RANGES')
      expect(prose?.source).toMatch(/^We record/u)
    } else {
      expect(title).toBe(prose)
    }
  }
)

const title = () => [
  item('A careful study of the relationships between distinct', 86, 660, 440, 'Title', 20),
  item('observed structures', 196, 620, 220, 'Title', 20),
  ...body()
]
it('keeps a complete centered title together at its native double leading', () => {
  const input = title(),
    units = extract(input)
  expect(units.find((u) => u.items.includes('1:0'))?.items).toEqual(['1:0', '1:1'])
  expect(units[0].originalStrings).toEqual(input.slice(0, 2).map((i) => i.str))
})
it.each(['large-gap', 'foreign-font', 'off-center', 'intervening-source'])(
  'does not infer a spaced title from incomplete native continuity: %s',
  (fault) => {
    const input = title()
    if (fault === 'large-gap') input[1].transform[5] -= 10
    if (fault === 'foreign-font') input[1].fontName = 'Other'
    if (fault === 'off-center') input[1].transform[4] += 25
    if (fault === 'intervening-source')
      input.splice(1, 0, item('Independent note.', 20, 560, 90, 'Other'))
    expect(extract(input).find((u) => u.items.includes('1:0'))?.originalStrings).not.toContain(
      'observed structures'
    )
  }
)

const heading = () => [
  item('7', 70, 700, 9, 'Heading', 16, false),
  item('Finite connected graphs admit a complete', 98, 700, 260, 'Heading', 16, false),
  item('5', 365, 700, 8, 'Numeric', 16, false),
  item('-vertex q-', 373, 700, 150, 'Heading', 16),
  item('regular', 98, 679, 75, 'Heading', 16),
  ...body(650)
]
it('retains a hanging heading with an independently printed scalar and literal letter prefix', () => {
  const units = extract(heading()),
    unit = units.find((u) => u.items.includes('1:0'))!
  expect(unit.items).toEqual(['1:0', '1:1', '1:2', '1:3', '1:4'])
  expect(unit.source).toContain('q-regular')
  expect(unit.items).not.toContain('1:5')
})
it.each(['foreign-word', 'raised-scalar', 'missing-number', 'wrong-indent', 'foreign-tail'])(
  'requires the complete native hanging-heading proof: %s',
  (fault) => {
    const input = heading()
    if (fault === 'foreign-word') input[2].str = 'term'
    if (fault === 'raised-scalar') input[2].transform[5] += 4
    if (fault === 'missing-number') input[0].str = 'X'
    if (fault === 'wrong-indent') input[4].transform[4] += 35
    if (fault === 'foreign-tail') input[4].fontName = 'Body'
    expect(extract(input).find((u) => u.items.includes('1:0'))?.items).not.toContain('1:4')
  }
)

const metadata = () => {
  const input: PdfLayoutTextItem[] = []
  for (const [n, name] of ['Ada Example', 'Bo Example', 'Cy Example'].entries()) {
    const y = 670 - n * 40.5
    input.push(item(name, 90, y, 70, 'Name', 11, false))
    if (!n) input.push(item('∗', 160, y + 3.5, 4, 'Marker', 7, false))
    input.push(item(`u${n}@example.test`, 410, y, 110, 'Contact', 10))
    input.push(
      item(
        'A complete institutional field belongs to this record,',
        90,
        y - 13.5,
        320,
        'Institution',
        10
      )
    )
    input.push(item('the second ordinary institutional line', 90, y - 27, 210, 'Institution', 10))
  }
  input.push(...body(520))
  return input
}
it('separates each author from affiliations only in a complete repeated native contact packet', () => {
  const input = metadata(),
    before = structuredClone(input),
    units = extract(input)
  for (const name of ['Ada Example∗', 'Bo Example', 'Cy Example'])
    expect(units.some((u) => u.source === name)).toBe(true)
  expect(units.filter((u) => u.source.includes('institutional field'))).toHaveLength(3)
  expect(
    units
      .filter((u) => u.source.includes('institutional field'))
      .every((u) => u.originalStrings.length === 2)
  ).toBe(true)
  expect(units.flatMap((u) => u.originalStrings).sort()).toEqual(input.map((i) => i.str).sort())
  expect(input).toEqual(before)
})
it.each(['unknown-contact', 'missing-affiliation', 'unpaired-baseline', 'unmarked-cluster'])(
  'does not invent metadata boundaries from incomplete records: %s',
  (fault) => {
    const input = metadata()
    if (fault === 'unknown-contact')
      input.find((i) => i.str === 'u1@example.test')!.str = 'Contact unavailable'
    if (fault === 'missing-affiliation')
      input.find((i) => i.str === 'the second ordinary institutional line')!.fontName = 'Unknown'
    if (fault === 'unpaired-baseline')
      input.find((i) => i.str === 'u1@example.test')!.transform[5] += 5
    if (fault === 'unmarked-cluster') input.splice(1, 1)
    expect(extract(input).some((u) => u.source === 'Bo Example')).toBe(false)
  }
)

it('separates stacked centered authors from the affiliation in a distinct face', () => {
  const input = [
    item('A STUDY OF FINITE COLLECTIONS', 176, 676, 260, 'Heading', 14.4),
    item('Ivy Example', 256, 633, 100, 'Heading'),
    item('and', 296, 618, 20),
    item('Sam Sample', 263, 598, 86, 'Heading'),
    item('School of Natural Sciences', 248, 578, 116),
    item('Example Institute of Research', 225, 563.5, 162),
    item('Sample City, EX 12345, Country', 218, 549, 176),
    ...body(477)
  ]
  const units = extract(input)
  const affiliation = units.find((u) => u.items.includes('1:4'))
  expect(units.find((u) => u.items.includes('1:3'))?.originalStrings).toEqual(['Sam Sample'])
  expect(affiliation?.originalStrings).toEqual(input.slice(4, 7).map((row) => row.str))

  input[1].fontName = 'Other'
  const ordinary = extract(input).find((u) => u.items.includes('1:4'))
  expect(ordinary?.originalStrings).toContain('Sam Sample')
})

it('keeps a run of centered numbered affiliations on separate rows', () => {
  const addresses = [
    'Department of Applied Science, Sample University, Elm City, Country',
    'Laboratory for Sensor Research, Sample University, Elm City, Country',
    'North Survey Office, 24 Elm Road, Elm City, Country',
    'Field Measurements Group, 12 Oak Street, Oak City, Country'
  ]
  const input = addresses.flatMap((address, index) => {
    const y = 632 - index * 11.5
    const x = [97, 90, 96, 89][index]
    return [
      item(String(index + 1), x, y + 2.8, 3.6, 'Index', 6, false),
      item(address, x + 4.1, y, 612 - (x + 4.1) * 2, 'Address', 8)
    ]
  })
  const units = extract(input)
  expect(units.map((unit) => unit.source)).toEqual(
    addresses.map((address, index) => `${index + 1}${address}`)
  )
  expect(units.map((unit) => unit.items.length)).toEqual([2, 2, 2, 2])
})

it.each([true, false])(
  'separates centered author and affiliation rows in native order before a confirmed abstract (%s)',
  (confirmed) => {
    const centered = (text: string, y: number, width: number, font = 'Body', size = 12) =>
      item(text, (612 - width) / 2, y, width, font, size)
    const metadata = [
      centered('Patterns in Finite Collections', 666, 215, 'Title', 17),
      centered('Ivy Example', 636, 90),
      centered('Department of Statistics, North Institute', 622, 273),
      centered('Sam Sample', 602, 48),
      centered('School of Environmental Science, West Research College', 588, 338),
      centered('March 8, 2042', 564, 82)
    ]
    const units = extract([
      ...metadata,
      centered(confirmed ? 'Abstract' : 'Overview', 528, 44, 'Heading', 10),
      ...body(470).map((row) => item(row.str, 72, row.transform[5], 468, 'Prose', 11))
    ])
    if (confirmed) {
      expect(units.slice(0, metadata.length).map((unit) => unit.originalStrings)).toEqual(
        metadata.map((row) => [row.str])
      )
    } else {
      const affiliation = units.find((unit) => unit.originalStrings.includes(metadata[2].str))
      expect(affiliation?.originalStrings).toContain(metadata[4].str)
    }
  }
)

it.each([0, 8])('preserves referenced names on an aligned equation label column (%s)', (offset) => {
  const items = [
    item('The first equation follows by direct substitution.', 70, 580, 240, 'Body', 11),
    item('x² + y² = z²', 200, 550, 226, 'Math', 11, false),
    item('.', 430, 550, 3, 'Math', 11, false),
    item('(', 490, 550, 4, 'Body', 11, false),
    item('Slope', 494, 550, 30, 'Math', 11, false),
    item(')', 524, 550, 4, 'Body', 11),
    item('The second equation follows from the same identity.', 70, 480, 254, 'Body', 11),
    item('a² + b² = c²', 200, 450, 226, 'Math', 11, false),
    item('.', 430, 450, 3, 'Math', 11, false),
    item('(', 490 + offset, 450, 4, 'Body', 11, false),
    item('Shift', 494 + offset, 450, 30, 'Math', 11, false),
    item(')', 524 + offset, 450, 4, 'Body', 11),
    item(
      'Use the identities (Slope) and (Shift) to compare the two estimates.',
      70,
      388,
      354,
      'Body',
      11
    )
  ]
  const units = extract(items)
  for (const source of ['(Slope)', '(Shift)']) {
    const tag = units.find((unit) => unit.source === source)
    expect(tag?.items).toHaveLength(3)
    expect(tag?.sourceOnly).toBe(offset === 0 ? true : undefined)
    expect(tag?.preserve).toBe(offset === 0 ? 'formula' : undefined)
  }
  expect(units.find((unit) => unit.items.includes('1:12'))?.sourceOnly).toBeUndefined()
})

it.each([0, 4])('keeps a lowered variable with its native minimum (%s)', (offset) => {
  const units = extract([
    item('Let the measurement be the following finite quantity.', 90, 485, 248, 'Body', 10),
    item('Q(t', 248, 454, 26, 'Math', 10, false),
    item(') := min', 274, 454, 36, 'Body', 10, false),
    item('r', 299.4 + offset, 447.5, 4, 'Script', 7),
    item('|', 312, 454, 3, 'Math', 10, false),
    item('h', 315, 454, 5, 'Math', 10, false),
    item('(', 320, 454, 4, 'Body', 10, false),
    item('r', 324, 454, 4, 'Math', 10, false),
    item(')', 328, 454, 4, 'Body', 10, false),
    item('|', 332, 454, 3, 'Math', 10),
    item('over all eligible values of the variable.', 90, 426, 187, 'Body', 10)
  ])
  const label = units.find((unit) => unit.items.includes('1:3'))
  expect(label?.items).toEqual(['1:3'])
  expect(label?.sourceOnly).toBe(offset ? undefined : true)
  expect(label?.preserve).toBe(offset ? undefined : 'formula')
})

it.each([0, 4])('keeps infinity over a native summation with a lowered limit (%s)', (offset) => {
  const units = extract([
    item('The observed total is found directly from the terms.', 90, 485, 248, 'Body', 10),
    item('T = 2', 246, 420, 31, 'Body', 10, false),
    item('∞', 284 + offset, 433, 8, 'Small', 7),
    { ...item('∑', 281, 430, 14, 'Large', 10, false), fontAscent: 0.03, fontDescent: -2.7 },
    item('j', 281, 408.7, 4, 'Script', 7, false),
    item('=1', 285, 408.7, 10, 'Small', 7),
    item('c', 302, 420, 5, 'Math', 10, false),
    item('j', 307, 418, 4, 'Script', 7),
    item('We use this expression below.', 90, 389, 150, 'Body', 10)
  ])
  const label = units.find((unit) => unit.items.includes('1:2'))
  expect(label?.items).toEqual(['1:2'])
  expect(label?.sourceOnly).toBe(offset ? undefined : true)
  expect(label?.preserve).toBe(offset ? undefined : 'formula')
})

it.each([0, 5])('keeps an institution name across acknowledgements columns (%s)', (offset) => {
  const input = [
    item('Figure 1. The independent panels show both observations.', 51, 408, 510, 'Caption', 9),
    item('ACKNOWLEDGEMENTS', 112, 382, 120, 'Body', 10),
    item('We thank the independent reviewers for their suggestions.', 51, 366, 242, 'Body', 10),
    item('The data archive is maintained by the team at no charge.', 51, 353.5, 242, 'Body', 10),
    item('Work on the open collection is supported by Data Systems,', 51, 341, 242, 'Body', 10),
    item('the operator of Cedar National', 51, 328.5, 242, 'Body', 10),
    item(
      'Laboratory (Cedar). The archive supports this research.',
      319,
      382 + offset,
      242,
      'Body',
      10
    ),
    item(
      'The archived records are available for all researchers.',
      319,
      369.5 + offset,
      242,
      'Body',
      10
    ),
    item('We thank the software maintainers.', 319, 357 + offset, 141, 'Body', 10),
    item('REFERENCES', 272, 290, 68, 'Body', 10),
    item('Bell, A., & Reed, J. 2024, The Sample Journal, 1, 8', 51, 270, 215, 'Reference', 9),
    item('Grant, C., & Park, S. 2025, Example Journal, 2, 16', 51, 256, 211, 'Reference', 9),
    item('Song, D., & Lane, K. 2025, Example Journal, 2, 24', 319, 270, 215, 'Reference', 9)
  ]
  const units = extract(input)
  const source = units.find((unit) => unit.source.startsWith('We thank the independent reviewers'))
  expect(source?.source.includes('operator of Cedar National Laboratory (Cedar).')).toBe(
    offset === 0
  )
  expect(source?.fragments.length).toBe(offset === 0 ? 2 : 1)
  expect(units.find((unit) => unit.source === 'REFERENCES')?.preserve).toBe('reference')
})
