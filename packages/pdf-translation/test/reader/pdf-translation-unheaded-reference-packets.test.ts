import { expect, it } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import type { PdfLayoutTextItem } from '../../src/reader/layout.js'

function fixture(fault = ''): PDFDocumentProxy {
  const text = (str: string, x: number, y: number, width: number): PdfLayoutTextItem => ({
    str,
    width,
    height: 10,
    dir: 'ltr',
    transform: [10, 0, 0, 10, x, 800 - y],
    fontName: 'Reference',
    hasEOL: true
  })
  const items = [
    text('[4] Writer A, Author B 2000 Geometric publication methods', 60, 90, 420),
    text('Journal of Examples 12 100–110', 90, 102, 300),
    text('[5] Writer A, Author B 2001 Geometric publication methods', 60, 140, 420),
    text('Journal of Examples 13 100–110', 90, 152, 300),
    text(
      '[6] Writer A, Author B 2002 Geometric methods Journal of Examples 14 100–110',
      60,
      190,
      480
    )
  ]
  if (fault === 'ordinary-body')
    for (const n of [0, 2, 4])
      items[n].str = `[${4 + n / 2}] We measure the ordinary experiment in 2024.`
  if (fault === 'reference-example')
    items.unshift(text('Reference examples for the following ordinary exercise.', 60, 55, 440))
  if (fault === 'isolated-marker') {
    items[0].str = '[4]'
    items[1].str = 'An independent ordinary explanatory sentence.'
  }
  if (fault === 'foreign-footnote')
    items.push(text('A separate explanatory footnote from 2024.', 90, 202, 300))
  if (fault === 'missing-first-font') items[0].fontName = 'Missing'
  if (fault === 'missing-last-eol') items[4].hasEOL = false
  if (fault === 'missing-first-marker') items[0].str = 'Writer A, Author B 2000 Geometric methods'
  if (fault === 'page-bounds') items[0].width = 600
  if (fault === 'wrong-indent') items[3].transform[4] += 35
  if (fault === 'number-gap') items[2].str = items[2].str.replace('[5]', '[15]')
  if (fault.startsWith('remove-')) items.splice(Number(fault.slice(7)), 1)
  if (fault === 'cross-column' || fault === 'two-column-example') {
    const right = structuredClone(items)
    for (const item of items) item.width = Math.min(item.width, 200)
    for (const item of right) {
      item.transform[4] += 280
      item.width = Math.min(item.width, 200)
      item.str = item.str.replace(/^\[(\d+)\]/u, (_, n: string) => `[${Number(n) + 3}]`)
    }
    items.push(...right)
    if (fault === 'cross-column') items[0].width = 300
    else items.unshift(text('Reference examples for the following ordinary exercise.', 60, 55, 440))
  }
  return {
    numPages: 1,
    fingerprints: ['anonymous-complete-native-reference-packet'],
    getPage: async () => ({
      getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
      getTextContent: async () => ({
        items,
        styles: { Reference: { ascent: 0.8, descent: -0.2, vertical: false } }
      }),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      commonObjs: {
        get: () => ({
          missingFile: false,
          isType3Font: false,
          isInvalidPDFjsFont: false,
          systemFontInfo: null,
          vertical: false,
          ascent: 0.8,
          descent: -0.2
        })
      }
    })
  } as unknown as PDFDocumentProxy
}

it('keeps a complete independently bounded unheaded native bibliography original-only', async () => {
  const result = await extractPdfTranslationSource({
    document: fixture(),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  expect(result.source.units.every((unit) => unit.sourceOnly)).toBe(true)
  expect(result.source.units.every((unit) => unit.preserve === 'reference')).toBe(true)
  expect(result.coverage.includedItemCount).toBe(5)
  expect(result.coverage.excludedItemCount).toBe(0)
  expect(
    result.source.units
      .flatMap((u) => u.fragments.flatMap((f) => f.items.map((i) => i.index)))
      .sort()
  ).toEqual([0, 1, 2, 3, 4])
})

it('retains the existing readonly policy of a complete native two-column bibliography suffix', async () => {
  const text = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName = 'Reference',
    height = 10,
    hasEOL = true
  ): PdfLayoutTextItem => ({
    str,
    width,
    height,
    dir: 'ltr',
    transform: [height, 0, 0, height, x, 800 - y],
    fontName,
    hasEOL
  })
  const records = (first: number, top: number): PdfLayoutTextItem[] =>
    Array.from({ length: 8 }, (_, n) => {
      const x = n < 4 ? 50 : 330,
        y = top + (n % 4) * 24
      return [
        text(`[${first + n}] A. Author, A complete independent study,`, x, y, 230),
        text('Journal of Testing', x + 20, y + 12, 140, 'Reference', 10, false),
        text('9', x + 166, y + 12, 10, 'Publication', 10, false),
        text(', 10 (2020).', x + 180, y + 12, 50)
      ]
    }).flat()
  const pages = [
    [
      text('1', 540, 20, 10, 'Heading', 12),
      text(
        'This complete ordinary paragraph explains the independent observations and their context.',
        50,
        470,
        500,
        'Body',
        12
      ),
      text(
        'The individual measurements remain distinct and retain their original native source order.',
        50,
        484,
        500,
        'Body',
        12
      ),
      text(
        'These sentences describe the work clearly before the final publication records below.',
        50,
        498,
        500,
        'Body',
        12
      ),
      ...records(1, 560)
    ],
    [text('2', 540, 20, 10, 'Heading', 12), ...records(9, 80)]
  ]
  const metrics = { ascent: 0.8, descent: -0.2, vertical: false }
  const document = {
    numPages: pages.length,
    fingerprints: ['anonymous-legacy-native-reference-suffix'],
    getPage: async (number: number) => ({
      getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
      getTextContent: async () => ({
        items: pages[number - 1],
        styles: Object.fromEntries(
          ['Reference', 'Publication', 'Body', 'Heading'].map((name) => [name, metrics])
        )
      }),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      commonObjs: {
        get: () => ({
          missingFile: false,
          isType3Font: false,
          isInvalidPDFjsFont: false,
          systemFontInfo: null,
          ...metrics
        })
      }
    })
  } as unknown as PDFDocumentProxy
  const result = await extractPdfTranslationSource({
    document,
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  const references = result.source.units.filter((unit) =>
    unit.fragments.some(
      (fragment) => fragment.pageNumber === 2 && fragment.items.some((item) => item.index > 0)
    )
  )
  expect(references.length).toBeGreaterThan(0)
  expect(references.every((unit) => unit.sourceOnly === true)).toBe(true)
  expect(references.every((unit) => unit.preserve === undefined)).toBe(true)
  expect(result.coverage.includedItemCount).toBe(69)
  expect(result.coverage.excludedItemCount).toBe(0)
})

it.each([
  'ordinary-body',
  'reference-example',
  'isolated-marker',
  'foreign-footnote',
  'missing-first-font',
  'missing-last-eol',
  'missing-first-marker',
  'page-bounds',
  'wrong-indent',
  'number-gap',
  'cross-column',
  'two-column-example',
  'remove-0',
  'remove-1',
  'remove-2',
  'remove-3',
  'remove-4'
])(
  'retains the ordinary source policy when the independent packet proof fails: %s',
  async (fault) => {
    const result = await extractPdfTranslationSource({
      document: fixture(fault),
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    expect(result.source.units.some((u) => u.preserve === 'reference')).toBe(false)
  }
)
