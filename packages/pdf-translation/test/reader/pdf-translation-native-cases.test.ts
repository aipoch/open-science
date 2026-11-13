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

function annotatedCases(): PdfLayoutPage {
  return {
    page: 1,
    width: 600,
    height: 800,
    rotation: 0,
    items: [
      item('An ordinary paragraph introduces the display.', 50, 690, 300, 'Body', true),
      item('q(t) =', 160, 634, 35, 'Math'),
      item('\uF8F1', 200, 658, 9, 'Brace'),
      item('\uF8F4', 200, 649, 9, 'Brace'),
      item('\uF8F2', 200, 646, 9, 'Brace'),
      item('\uF8F4', 200, 628, 9, 'Brace'),
      item('\uF8F3', 200, 623, 9, 'Brace'),
      ...[647, 632.5, 618].flatMap((y, n) => [
        item(`${[4, 9, 6][n]} (${['north', 'west', 'south'][n]})`, 210, y, 45),
        item(',', 255, y, 3, 'Math'),
        item('t', 275, y, 5, 'Math'),
        item(n ? '≡ ±' : '≡', 285, y, n ? 18 : 8, 'Math'),
        item(`${n + 2} (mod 11)`, n ? 306 : 296, y, 50),
        item(n === 2 ? '.' : ',', n ? 356 : 346, y, 3, 'Math', true)
      ]),
      item('An ordinary paragraph resumes.', 50, 580, 250, 'Body', true)
    ]
  }
}

it('keeps annotated native modular branches out of a free-flow translation fragment', () => {
  const page = annotatedCases(),
    before = structuredClone(page),
    grouped = groupPdfTranslationPages({ pages: [page] })
  for (let index = 1; index < page.items.length - 1; index++) {
    const owner = grouped.units.find((u) => u.items.includes(`1:${index}`))!
    expect(owner.sourceOnly, `native case item ${index}`).toBe(true)
    expect(owner.preserve).toBe('formula')
  }
  expect(grouped.units.filter((u) => !u.sourceOnly).map((u) => u.source)).toEqual([
    page.items[0].str,
    page.items.at(-1)!.str
  ])
  expect(grouped.units.flatMap((u) => u.items).toSorted()).toEqual(
    page.items.map((_, n) => `1:${n}`).toSorted()
  )
  expect(page).toEqual(before)
})

it.each([
  'brace',
  'assignment',
  'alignment',
  'condition',
  'label',
  'foreign',
  'overlap',
  'metrics',
  'rotation'
])('does not claim an unclosed annotated display: %s', (fault) => {
  const page = annotatedCases()
  if (fault === 'brace') page.items[3].str = 'ordinary'
  if (fault === 'assignment') page.items[1].str = 'List of categories'
  if (fault === 'alignment') page.items[13].transform[4] += 3
  if (fault === 'condition') page.items[11].str = 'ordinary explanation'
  if (fault === 'label') page.items[7].str = 'a paragraph starts here'
  if (fault === 'foreign') page.items.splice(12, 0, item('foreign', 50, 600, 40))
  if (fault === 'overlap') page.items.splice(-1, 0, item('foreign', 280, 640, 40))
  if (fault === 'metrics') page.items[3].fontDescent = undefined
  if (fault === 'rotation') page.rotation = 90
  expect(nativeCaseDisplayItems(page).size).toBe(0)
})

it.each([0.5, 2])('recognizes annotated case geometry at scale %s', (scale) => {
  const page = annotatedCases(),
    expected = [...nativeCaseDisplayItems(page)]
  page.width *= scale
  page.height *= scale
  for (const i of page.items) {
    i.width *= scale
    i.height *= scale
    i.transform = i.transform.map((v) => v * scale)
  }
  expect([...nativeCaseDisplayItems(page)]).toEqual(expected)
  page.items[7].str = 'changed source prose'
  expect(nativeCaseDisplayItems(page).size).toBe(0)
})
