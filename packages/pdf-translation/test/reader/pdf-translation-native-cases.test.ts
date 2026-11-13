import { expect, it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from '../../src/reader/layout.js'
import { nativeCaseDisplayItems } from '../../src/reader/native-case-display.js'

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
  fontAscent: fontName === 'Brace' ? 0.04 : 0.8,
  fontDescent: fontName === 'Brace' ? -0.6 : -0.2,
  fontVertical: false,
  hasEOL
})
function cases(): PdfLayoutPage {
  return {
    page: 1,
    width: 600,
    height: 800,
    rotation: 0,
    items: [
      item(
        'An independent paragraph precedes the following native display.',
        50,
        680,
        350,
        'Body',
        true
      ),
      item('h(t) =', 160, 629.6, 35, 'Math'),
      item('\uF8F1', 200, 650, 9, 'Brace', true),
      item('\uF8F2', 200, 641, 9, 'Brace', true),
      item('\uF8F3', 200, 623, 9, 'Brace'),
      item('h(t)', 215, 641.7, 20, 'Math'),
      item('if', 245, 641.7, 7),
      item('t ∉ {a,c},', 265, 641.7, 60, 'Math', true),
      item('3', 225, 629.6, 5),
      item('if', 245, 629.6, 7),
      item('t ∈ {a,c},', 265, 629.6, 60, 'Math', true),
      item('1', 225, 617.5, 5),
      item('if', 245, 617.5, 7),
      item('t = b,', 265, 617.5, 35, 'Math', true),
      item('We return three if the flag is set, otherwise one.', 50, 580, 270, 'Body', true)
    ]
  }
}

it.each([0.5, 1, 2])('preserves complete native case rows at scale %s', (scale) => {
  const page = cases()
  page.width *= scale
  page.height *= scale
  for (const item of page.items) {
    item.width *= scale
    item.height *= scale
    item.transform = item.transform.map((value) => value * scale)
  }
  const before = structuredClone(page),
    proof = nativeCaseDisplayItems(page)
  expect([...proof].toSorted((a, b) => a - b)).toEqual(Array.from({ length: 13 }, (_, n) => n + 1))
  const result = groupPdfTranslationPages({ pages: [page] })
  for (const index of [6, 9, 12]) {
    const owner = result.units.find((u) => u.items.includes(`1:${index}`))!
    expect(owner.sourceOnly).toBe(true)
    expect(owner.preserve).toBe('formula')
  }
  expect(result.units.find((u) => u.items.includes('1:14'))?.sourceOnly).toBeUndefined()
  expect(result.units.flatMap((u) => u.items).toSorted()).toEqual(
    page.items.map((_, n) => `1:${n}`).toSorted()
  )
  expect(page).toEqual(before)
})

it.each([
  'missing brace',
  'unequal condition column',
  'foreign condition',
  'missing assignment',
  'unequal value column'
])('requires the entire case display witness: %s', (fault) => {
  const page = cases()
  if (fault === 'missing brace') page.items[4].str = '}'
  if (fault === 'unequal condition column') page.items[9].transform[4] += 4
  if (fault === 'foreign condition') page.items[10].str = 'the ordinary condition'
  if (fault === 'missing assignment') page.items[1].str = 'heading'
  if (fault === 'unequal value column') page.items[11].transform[4] -= 4
  expect(nativeCaseDisplayItems(page).size).toBe(0)
})

function twoRows(longIndex = false): PdfLayoutPage {
  const small = (str: string, x: number, y: number, width: number): PdfLayoutTextItem => ({
    ...item(str, x, y, width, 'Index'),
    height: 6.5,
    transform: [6.5, 0, 0, 6.5, x, y]
  })
  const condition = (y: number, negative: boolean): PdfLayoutTextItem[] => {
    const shift = longIndex && !negative ? -3.5 : 0
    return [
      item('t', 262 + shift, y, 5, 'Math'),
      ...(negative ? [item('\u0338', 274, y, 0, 'Negation')] : []),
      item('=', 274 + shift, y, 8),
      item('t', 288 + shift, y, 5, 'Math'),
      small('j', 293 + shift, y - 1.5, 3.5),
      ...(longIndex && !negative ? [small('−', 293, y - 1.5, 4), small('1', 297, y - 1.5, 3)] : []),
      item(',', longIndex && !negative ? 300.5 : 297, y, 3, 'Math', true)
    ]
  }
  return {
    page: 1,
    width: 600,
    height: 800,
    rotation: 0,
    items: [
      item('An ordinary paragraph introduces a mathematical display.', 50, 680, 350, 'Body', true),
      item('h', 166, 633, 5, 'Math'),
      small('′', 171, 637, 2.5),
      item('(', 174, 633, 4),
      item('t', 178, 633, 5, 'Math'),
      item(') =', 184, 633, 13),
      item('\u001a', 200, 648, 8, 'Brace'),
      item('g', 214, 640, 5, 'Math'),
      item('(', 219, 640, 4),
      item('t', 223, 640, 5, 'Math'),
      item(')', 228, 640, 4),
      item('if', 242, 640, 7),
      ...condition(640, true),
      item(longIndex ? '4' : 'q', 220.5, 626, 5, longIndex ? 'Body' : 'Math'),
      item('if', 242, 626, 7),
      ...condition(626, false),
      item('An ordinary paragraph resumes after the display.', 50, 580, 300, 'Body', true)
    ]
  }
}

it.each([false, true])(
  'retains opaque native conditional displays without decoding their symbol: %s',
  (longIndex) => {
    const page = twoRows(longIndex),
      before = structuredClone(page),
      end = page.items.length - 1
    expect([...nativeCaseDisplayItems(page)].toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: end - 1 }, (_, n) => n + 1)
    )
    const grouped = groupPdfTranslationPages({ pages: [page] })
    for (const [index, value] of page.items.entries()) {
      const owner = grouped.units.find((u) => u.items.includes(`1:${index}`))!
      if (index > 0 && index < end) {
        expect(owner.sourceOnly).toBe(true)
        expect(owner.preserve).toBe('formula')
      } else expect(owner.sourceOnly).toBeUndefined()
      if (value.str === '\u001a') expect(owner.originalStrings).toContain('\u001a')
    }
    expect(grouped.units.flatMap((u) => u.items).toSorted()).toEqual(
      page.items.map((_, n) => `1:${n}`).toSorted()
    )
    expect(page).toEqual(before)
  }
)

it.each([
  'missing assignment',
  'ordinary value',
  'ordinary condition',
  'condition column',
  'value column',
  'if column',
  'foreign source',
  'foreign overlapping source',
  'detached mark',
  'mark size',
  'nonfinite mark',
  'missing relation',
  'extra row',
  'decoded symbol',
  'unknown geometry'
])('declines incomplete opaque conditional evidence: %s', (fault) => {
  const page = twoRows(),
    connectors = page.items.filter((i) => i.str === 'if'),
    marker = page.items.find((i) => i.str === '\u0338')!
  if (fault === 'missing assignment') page.items.find((i) => i.str === ') =')!.str = ') +'
  if (fault === 'ordinary value') page.items.find((i) => i.str === 'q')!.str = 'ordinary'
  if (fault === 'ordinary condition')
    page.items[page.items.indexOf(connectors[1]) + 1].str = 'the ordinary condition'
  if (fault === 'condition column')
    for (const part of page.items.slice(page.items.indexOf(connectors[1]) + 1, -1))
      part.transform[4] += 2
  if (fault === 'value column') page.items.find((i) => i.str === 'q')!.transform[4] += 2
  if (fault === 'if column') connectors[1].transform[4] += 2
  if (fault === 'foreign source')
    page.items.splice(page.items.indexOf(connectors[1]), 0, item('foreign', 50, 590, 40))
  if (fault === 'foreign overlapping source')
    page.items.splice(-1, 0, item('foreign', 270, 633, 40))
  if (fault === 'detached mark') marker.transform[4] += 1
  if (fault === 'mark size') marker.height = 9
  if (fault === 'nonfinite mark') marker.transform[4] = NaN
  if (fault === 'missing relation') page.items[page.items.indexOf(marker) + 1].str = '+'
  if (fault === 'extra row')
    page.items.splice(
      -1,
      0,
      item('2', 220.5, 612, 5),
      item('if', 242, 612, 7),
      item('t = a,', 262, 612, 38, 'Math', true)
    )
  if (fault === 'decoded symbol') page.items.find((i) => i.str === '\u001a')!.str = '{'
  if (fault === 'unknown geometry') page.items.find((i) => i.str === '\u001a')!.fontDescent = 1
  expect(nativeCaseDisplayItems(page).size).toBe(0)
})

it('rechecks changed source instead of retaining a prior conditional witness', () => {
  const page = twoRows()
  expect(nativeCaseDisplayItems(page).size).toBeGreaterThan(0)
  page.items.find((i) => i.str === 'q')!.str = 'changed source'
  expect(nativeCaseDisplayItems(page).size).toBe(0)
})
