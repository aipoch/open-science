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
