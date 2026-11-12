import { expect, it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from '../../src/reader/layout.js'

const part = (
  str: string,
  x: number,
  y: number,
  width: number,
  fontName = 'Body',
  size = 10,
  hasEOL = true
): PdfLayoutTextItem => ({
  str,
  width,
  height: size,
  dir: 'ltr',
  transform: [size, 0, 0, size, x, y],
  fontName,
  fontAscent: 0.8,
  fontDescent: -0.2,
  fontVertical: false,
  hasEOL
})
const page = (items: PdfLayoutTextItem[]): PdfLayoutPage => ({
  page: 1,
  width: 600,
  height: 800,
  rotation: 0,
  items
})
const source = (input: PdfLayoutPage): ReturnType<typeof groupPdfTranslationPages> => {
  const result = groupPdfTranslationPages({ pages: [input] })
  const actual = result.units.flatMap((u) => u.items.map((key, at) => [key, u.originalStrings[at]]))
  expect(actual.toSorted()).toEqual(
    input.items.flatMap((item, at) => (item.str.trim() ? [[`1:${at}`, item.str]] : [])).toSorted()
  )
  expect(new Set(actual.map(([key]) => key)).size).toBe(actual.length)
  return result
}
const owner = (
  result: ReturnType<typeof source>,
  index: number
): ReturnType<typeof source>['units'][number] =>
  result.units.find((u) => u.items.includes(`1:${index}`))!

function acronym(): PdfLayoutPage {
  return page([
    part('We describe the signal representation using the regional', 50, 700, 250),
    part('Trait (Q', 50, 688, 37, 'Body', 10, false),
    part('3', 87, 692, 4, 'Script', 6.7, false),
    part('R) across several bands. We also retain the original', 91.5, 688, 208.5),
    part('native identifiers while improving the measured response.', 50, 676, 250)
  ])
}

it('keeps a complete native acronym row with its numeric superscript in prose', () => {
  const result = source(acronym()),
    lead = owner(result, 1)
  expect(lead.sourceOnly).toBeUndefined()
  expect(lead.items).toContain('1:2')
  expect(lead.items).toContain('1:3')
  expect(lead.source).toContain('Trait (Q3R)')
})

it.each([false, true])(
  'bounds rotated foreign ink in its own axes, overlapping=%s',
  (overlapping) => {
    const input = acronym(),
      margin = part('vertical margin', overlapping ? 60 : 20, 640, 100)
    margin.transform = [0, 10, -10, 0, overlapping ? 60 : 20, 640]
    input.items.push(margin)
    const result = source(input)
    if (overlapping) expect(owner(result, 1)).not.toBe(owner(result, 3))
    else expect(owner(result, 1)).toBe(owner(result, 3))
  }
)

it.each(['missing context', 'foreign script', 'foreign glyph', 'wrong column', 'open parenthesis'])(
  'requires closed native acronym context: %s',
  (fault) => {
    const input = acronym()
    if (fault === 'missing context') input.items[0].str = 'Independent heading.'
    if (fault === 'foreign script') input.items[2].transform[5] += 10
    if (fault === 'foreign glyph') input.items.push(part('z', 120, 688, 5, 'Math'))
    if (fault === 'wrong column') input.items[0].transform[4] += 300
    if (fault === 'open parenthesis') input.items[3].str = input.items[3].str.replace('R)', 'R')
    const result = source(input)
    expect(owner(result, 1)).not.toBe(owner(result, 3))
  }
)

it('retains a complete inline numbered citation row in its continuing paragraph', () => {
  const input = page([
    part('We evaluated the proposed method using three public datasets,', 50, 700, 250),
    part('including (1) SystemOne [7], (2) SystemTwo [8], and', 50, 688, 250),
    part('(3) SystemThree [9]. We present the resulting comparisons', 50, 676, 250),
    part('under the same conditions for every method.', 50, 664, 210)
  ])
  const result = source(input)
  expect(owner(result, 1).sourceOnly).toBeUndefined()
  expect(owner(result, 1)).toBe(owner(result, 0))
  expect(owner(result, 1)).toBe(owner(result, 2))
})

it('keeps a natively split ordinary field name whole inside continuing prose', () => {
  const input = page([
    part(
      'We include the static information to improve the final response. Additional',
      50,
      700,
      280
    ),
    part('attributes', 50, 688, 40, 'Body', 10, false),
    part('(A', 93, 688, 9, 'Body', 10, false),
    part('ccount ID', 102, 688, 40, 'Body', 10, false),
    part(')', 142, 688, 4, 'Body', 10, false),
    part('are incorporated using a shared representation', 149, 688, 181),
    part('for every available sequence in the comparison.', 50, 676, 240)
  ])
  const result = source(input),
    field = owner(result, 1)
  expect(field.sourceOnly).toBeUndefined()
  expect(field).toBe(owner(result, 3))
  expect(field.source).toContain('attributes (Account ID)')
})

function caption(): PdfLayoutPage {
  return page([
    part('Fig. 2. We compare several transformations and Codec', 50, 700, 250),
    part('Encoding (', 50, 688, 45, 'Body', 10, false),
    part('rate', 95, 688, 20, 'Parameter', 10, false),
    part('= 80, 40, 20', 117, 688, 57, 'Math', 10, false),
    part(') (from left to right).', 174, 688, 90)
  ])
}

it('keeps the descriptive caption head before a closed native numeric parameter', () => {
  const result = source(caption())
  expect(owner(result, 1).sourceOnly).toBeUndefined()
  expect(owner(result, 1)).toBe(owner(result, 2))
  expect(owner(result, 1)).toBe(owner(result, 4))
  expect(owner(result, 1).source).toContain('Encoding (rate = 80, 40, 20)')
})

it.each(['Softmax (x)', 'UnknownOperator (x)', 'a = b + c', 'A = F(x)'])(
  'does not grant prose ownership to a standalone mathematical expression: %s',
  (text) => {
    const result = source(page([part(text, 50, 700, 160)]))
    expect(owner(result, 0).sourceOnly).toBe(true)
  }
)

it('does not admit the numeric parameter without an established caption', () => {
  const input = caption()
  input.items[0].str = 'An independent completed sentence.'
  const result = source(input)
  expect(owner(result, 1)).not.toBe(owner(result, 2))
})
