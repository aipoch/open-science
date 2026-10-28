import { expect, test } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem,
  type PdfTranslationLayout
} from '../../src/reader/layout.js'

function item(
  str: string,
  x: number,
  y: number,
  width: number,
  size = 12,
  font = 'Body',
  hasEOL = true
): PdfLayoutTextItem {
  return {
    str,
    width,
    height: size,
    dir: 'ltr',
    transform: [size, 0, 0, size, x, 800 - y],
    fontName: font,
    fontAscent: 0.7,
    fontDescent: -0.2,
    fontVertical: false,
    hasEOL
  }
}
const page = (page: number, items: PdfLayoutTextItem[]): PdfLayoutPage => ({
  page,
  width: 600,
  height: 800,
  rotation: 0,
  items
})
const group = (pages: PdfLayoutPage[]): PdfTranslationLayout =>
  groupPdfTranslationPages({ pages, pageCount: pages.length })

function singleContinuedContentsRow(): PdfLayoutPage[] {
  const titles = [
    'I. Introduction',
    'II. Methods',
    'III. Results',
    'IV. Evaluation',
    'V. Analysis',
    'VI. Discussion',
    'VII. Data',
    'VIII. Appendix'
  ]
  const title = (text: string, y: number, width = 300): PdfLayoutTextItem =>
    item(text, 60, y, width, 24, 'Navigation', false)
  const number = (n: number, y: number): PdfLayoutTextItem =>
    item(String(n), n < 10 ? 550 : 540, y, n < 10 ? 10 : 20, 24, 'Numbers')
  const body = (): PdfLayoutTextItem =>
    item(
      'The complete experimental discussion records independent measurements and compares every intervention with the control group.',
      60,
      210,
      460
    )
  return [
    page(1, [
      title('CONTENTS', 70),
      ...titles.flatMap((text, n) => [title(text, 110 + n * 88), number(n + 2, 110 + n * 88)]),
      item('1', 295, 770, 10, 24, 'Numbers')
    ]),
    page(2, [
      title('References', 70, 120),
      number(10, 70),
      title('I. INTRODUCTION', 150),
      body(),
      item('2', 295, 770, 10, 24, 'Numbers')
    ]),
    ...titles.slice(1).map((text, n) => page(n + 3, [title(text.toUpperCase(), 70), body()])),
    page(10, [
      title('REFERENCES', 70),
      item('Writer, A. A complete publication. Independent Journal, 2020.', 60, 130, 460)
    ])
  ]
}

test('does not start bibliography mode at a proved single-row contents continuation', () => {
  const result = group(singleContinuedContentsRow())
  expect(result.units.find((u) => u.source === 'References')).toMatchObject({
    referenceBoundary: true
  })
  expect(result.units.find((u) => u.source === 'I. INTRODUCTION')?.sourceOnly).toBeUndefined()
  expect(result.units.find((u) => u.source.startsWith('Writer, A.'))?.preserve).toBe('reference')
})

test.each(['missing-font', 'wrong-destination', 'missing-anchors', 'duplicate-reference'] as const)(
  'keeps reference mode without a complete continued contents proof: %s',
  (mode) => {
    const pages = singleContinuedContentsRow()
    if (mode === 'missing-font') delete pages[1].items[0].fontAscent
    if (mode === 'wrong-destination') pages[1].items[1].str = '9'
    if (mode === 'missing-anchors')
      for (const p of pages.slice(2, 9)) p.items[0].fontName = 'Unrelated'
    if (mode === 'duplicate-reference')
      pages[9].items.push({
        ...pages[9].items[0],
        transform: [24, 0, 0, 24, 60, 450]
      })
    expect(group(pages).units.find((u) => u.source === 'I. INTRODUCTION')?.preserve).toBe(
      'reference'
    )
  }
)

function headedReferences(): PdfLayoutPage[] {
  const entries = (start: number): PdfLayoutTextItem[] =>
    Array.from({ length: 4 }, (_, n) => [
      item(
        `Writer ${String.fromCharCode(65 + n)}. A complete independently published record.`,
        60,
        start + n * 52,
        450
      ),
      item(
        'Independent Journal volume twelve, pages fourteen through thirty.',
        78,
        start + n * 52 + 16,
        420
      )
    ]).flat()
  return [
    page(1, [item('References', 60, 70, 90, 12, 'Section', false), ...entries(85)]),
    page(2, entries(70)),
    page(3, [
      item('Technical Supplement', 60, 70, 180, 12, 'Section'),
      item(
        'The independent experimental discussion begins after the final complete bibliographic record. Every observation is retained and the normal narrative describes the experimental method in ordinary sentences. The remaining results use complete native measurements and compare every intervention with the control group.',
        60,
        108,
        460
      )
    ])
  ]
}

function contents(): PdfLayoutPage[] {
  const headings = ['Independent observations', 'Experimental methods', 'Measured comparisons']
  const pages = headings.map((text, n) =>
    page(n + 1, [
      item(String(n + 1), 60, 70, 10, 18, 'Section', false),
      item(text, 90, 70, 320, 18, 'Section'),
      item(
        'The complete experimental discussion independently establishes ordinary body measurements and records all observations.',
        60,
        110,
        460
      )
    ])
  )
  pages.push(
    page(4, [
      item('References', 60, 70, 130, 18, 'Section'),
      item(
        'Writer, A. Complete publication metadata. Independent Journal, volume twelve, pages 1–8.',
        60,
        110,
        460
      ),
      item(
        'Writer, B. The final complete publication. Independent Journal, volume fourteen, pages 2–9.',
        60,
        150,
        460
      )
    ])
  )
  pages.push(
    page(5, [
      item('Contents', 60, 70, 100, 18, 'Section'),
      ...['1', '2', '3', 'A', 'A.1'].flatMap((label, n) => [
        item(label, n === 4 ? 78 : 60, 110 + n * 26, 20, 12, 'Navigation', false),
        item(
          n < 3
            ? headings[n]
            : n === 3
              ? 'Supporting measurements'
              : 'Further independent analysis',
          105,
          110 + n * 26,
          340,
          12,
          'Navigation',
          false
        ),
        item(String(n < 3 ? n + 1 : 6), 520, 110 + n * 26, 12, 12, 'Navigation')
      ])
    ])
  )
  pages.push(
    page(6, [
      item(
        'Supporting measurements remain ordinary narrative after the complete independently anchored navigation page.',
        60,
        70,
        460
      )
    ])
  )
  return pages
}

test('recognizes an explicit native reference heading merged with its first entry without changing ownership', () => {
  const pages = headedReferences(),
    result = group(pages)
  expect(
    result.units.filter((u) => u.fragments[0].page < 3).every((u) => u.preserve === 'reference')
  ).toBe(true)
  expect(
    result.units.find((u) => u.source.startsWith('The independent experimental discussion'))
      ?.preserve
  ).toBeUndefined()
  expect(result.units.flatMap((u) => u.items).sort()).toEqual(
    pages.flatMap((p) => p.items.map((_, n) => `${p.page}:${n}`)).sort()
  )
  expect(result.units[0].source).toContain('References Writer A.')
})

test.each(['author-led', 'missing-font', 'unknown-end', 'foreign-prose', 'no-indent'] as const)(
  'refuses incomplete native reference span: %s',
  (mode) => {
    const pages = headedReferences()
    if (mode === 'author-led') pages[0].items[0].str = 'Writer, A.'
    if (mode === 'missing-font') pages[1].items[0].fontAscent = undefined
    if (mode === 'unknown-end') pages.pop()
    if (mode === 'no-indent')
      for (const p of pages.slice(0, 2)) for (const i of p.items) i.transform[4] = 60
    if (mode === 'foreign-prose')
      pages[1].items.push({
        ...pages[1].items[0],
        str: 'An independent experimental observation outside the citation.',
        transform: [12, 0, 0, 12, 110, pages[1].items[0].transform[5]]
      })
    expect(group(pages).units.filter((u) => u.preserve === 'reference')).toEqual([])
  }
)

test('ends bibliography at a complete Contents page linked to independent native section headings', () => {
  const result = group(contents())
  expect(result.units.find((u) => u.source === 'Contents')).toMatchObject({
    referenceBoundary: true
  })
  expect(
    result.units.filter((u) => u.fragments[0].page >= 5).every((u) => u.preserve !== 'reference')
  ).toBe(true)
  expect(result.units.find((u) => u.source.startsWith('Writer, B.'))?.preserve).toBe('reference')
})

test.each([
  'book-title',
  'missing-anchor',
  'ambiguous-anchor',
  'foreign-row',
  'repeated-anchor',
  'clipped-navigation'
] as const)('retains reference mode without complete Contents proof: %s', (mode) => {
  const pages = contents()
  if (mode === 'book-title') pages[4].items[0].fontName = 'Body'
  if (mode === 'missing-anchor') pages[2].items[1].str = 'A different actual section'
  if (mode === 'ambiguous-anchor')
    pages[2].items.push(...structuredClone(pages[2].items.slice(0, 2)))
  if (mode === 'repeated-anchor') {
    for (const offset of [4, 7]) {
      pages[4].items[offset].str = '1'
      pages[4].items[offset + 1].str = 'Independent observations'
      pages[4].items[offset + 2].str = '1'
    }
  }
  if (mode === 'clipped-navigation') pages[4].items[3].transform[4] = 599
  if (mode === 'foreign-row')
    pages[4].items.splice(
      4,
      0,
      item('An independent experimental discussion occurs here.', 60, 122, 400, 12, 'Navigation')
    )
  expect(group(pages).units.find((u) => u.source === 'Contents')).toMatchObject({
    preserve: 'reference'
  })
})
