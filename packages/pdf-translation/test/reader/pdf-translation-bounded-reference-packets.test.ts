import { expect, it } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import { applyPdfContentFirstPolicy } from '../../src/reader/content-policy.js'
import type { PdfLayoutTextItem } from '../../src/reader/layout.js'

const text = (
  str: string,
  x: number,
  y: number,
  width: number,
  size = 8,
  fontName = 'Reference'
): PdfLayoutTextItem => ({
  str,
  width,
  height: size,
  dir: 'ltr',
  transform: [size, 0, 0, size, x, 800 - y],
  fontName,
  hasEOL: true
})
function fixture(fault = ''): PDFDocumentProxy {
  const prose =
    'An independent ordinary paragraph explains the complete construction and its measurements. These explanatory sentences remain outside the following bibliography and retain their original source ownership.'
  const pages = [
    Array.from({ length: 6 }, (_, n) => text(prose, 60, 90 + n * 60, 480, 10, 'Body')),
    [
      text('References', 270, 90, 70, 12, 'Heading'),
      text(
        '[ABC20] A. Writer, B. Author, and C. Editor. A complete independent publication about geometric structures and maps in higher',
        90,
        150,
        430
      ),
      text('Algebra, 2020.', 130, 160, 60),
      text('[DEF21]', 90, 170, 32),
      text(
        'B. Author, C. Writer, and D. Editor. Complete methods for independent algebraic constructions, 2021.',
        130,
        170,
        230
      ),
      text('J. Examples.', 488, 170, 32, 8, 'Italic')
    ]
  ]
  for (const item of pages[1].slice(3, -1)) item.hasEOL = false
  if (fault === 'isolated-marker' || fault.startsWith('marker-')) {
    for (const [n, key] of ['Ghi22', 'Jkl23', 'Mno24', 'Art25'].entries()) {
      const y = 200 + n * 20,
        label = text('[' + key + ']', 90, y, 24),
        body = text(
          'A. Writer. An independent publication on complete native geometry.',
          130,
          y,
          270
        ),
        journal = text('J. Examples.', 405, y, 50, 8, 'Italic'),
        date = text(', 2025.', 455, y, 65)
      label.hasEOL = body.hasEOL = journal.hasEOL = false
      if (n === 3) date.hasEOL = false
      pages[1].push(label, body, journal, date)
    }
  }
  if (fault === 'marker-unheaded') pages[1][0].str = 'Sources'
  if (fault === 'marker-row-mismatch') pages[1].find((i) => i.str === '[Art25]')!.transform[5] += 2
  if (fault === 'marker-short-context') pages[1].splice(6, 8)
  if (fault === 'marker-foreign-source')
    pages[1].push(text('Separate note.', 300, 255, 40, 4, 'Body'))
  if (fault === 'shifted-tail') pages[1][2].transform[4] += 16
  if (fault === 'wide-gap') pages[1][2].transform[5] -= 6
  if (fault === 'missing-eol') delete pages[1][4].hasEOL
  if (fault === 'unheaded') pages[1][0].str = 'Sources'
  if (fault === 'ordinary-reset')
    pages[1][1].str = 'An ordinary explanatory sentence about geometric structures.'
  if (fault === 'foreign-prose')
    pages[1].push(text('An independent ordinary note.', 190, 155, 180, 10, 'Body'))
  if (fault === 'pending-affiliation')
    pages[1].push(
      text(
        'Institute for Independent Research. Email: example@example.org',
        100,
        220,
        390,
        8,
        'Heading'
      )
    )
  return {
    numPages: pages.length,
    fingerprints: ['anonymous-bounded-reference'],
    getPage: async (n: number) => ({
      getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
      getTextContent: async () => ({
        items: pages[n - 1],
        styles: Object.fromEntries(
          ['Body', 'Reference', 'Heading', 'Italic'].map((name) => [
            name,
            {
              ascent:
                (fault === 'missing-metrics' || fault === 'marker-missing-metrics') &&
                name === 'Reference'
                  ? undefined
                  : 0.8,
              descent: -0.2,
              vertical: false
            }
          ])
        )
      })
    })
  } as unknown as PDFDocumentProxy
}
it('keeps a complete short bibliography continuation original-only below a centered heading', async () => {
  const extraction = await extractPdfTranslationSource({
    document: fixture(),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  const tail = extraction.source.units.find((u) => u.source === 'Algebra, 2020.')
  expect(tail).toBeDefined()
  expect(tail?.sourceOnly).toBe(true)
  expect(tail?.preserve).toBe('reference')
  const displayed = applyPdfContentFirstPolicy(extraction.source)
  expect(displayed.units.find((u) => u.source === 'Algebra, 2020.')?.preserve).toBe('reference')
  const origins = extraction.source.units.flatMap((u) =>
    u.fragments.flatMap((f) => f.items.map((i) => f.pageNumber + ':' + i.index))
  )
  expect(origins).toHaveLength(12)
  expect(new Set(origins).size).toBe(12)
  expect(extraction.coverage.excludedItemCount).toBe(0)
})

it.each([
  'shifted-tail',
  'wide-gap',
  'missing-eol',
  'unheaded',
  'ordinary-reset',
  'foreign-prose',
  'missing-metrics'
])('keeps an incomplete native bibliography packet eligible: %s', async (fault) => {
  const e = await extractPdfTranslationSource({
    document: fixture(fault),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  const tail = e.source.units.find((u) => u.source === 'Algebra, 2020.')
  expect(tail).toBeDefined()
  expect(tail?.sourceOnly).not.toBe(true)
})
it('retains existing affiliation protection while its content policy is pending', async () => {
  const e = await extractPdfTranslationSource({
    document: fixture('pending-affiliation'),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  expect(
    e.source.units.find((u) => u.source.startsWith('Institute for Independent'))?.sourceOnly
  ).toBe(true)
})
function columnFixture(fault = ''): PDFDocumentProxy {
  const intro =
    'An ordinary explanation remains separate from the bibliography and describes the complete measurements and their reproducible procedure.'
  const record = (n: number, right: boolean, y: number): PdfLayoutTextItem[] => {
    const marker = text(
      `[${n}]`,
      right ? (n < 10 ? 330 : 326) : n < 10 ? 60 : 56,
      y,
      n < 10 ? 10 : 14
    )
    marker.hasEOL = false
    return [
      marker,
      text(
        `Writer and Author describe independent native reference record ${n}. Example Journal, 2020.`,
        right ? 346 : 76,
        y,
        204
      )
    ]
  }
  const pages = [
    Array.from({ length: 6 }, (_, n) => text(intro, 60, 90 + n * 60, 480, 10, 'Body')),
    [
      text(intro, 60, 60, 220, 10, 'Body'),
      text('References', 120, 500, 90, 12, 'Heading'),
      ...Array.from({ length: 3 }, (_, n) => record(n + 1, false, 530 + n * 40)).flat(),
      ...Array.from({ length: 8 }, (_, n) => record(n + 4, true, 60 + n * 40)).flat()
    ],
    [...record(12, false, 80)]
  ]
  if (fault === 'empty-native-eol') {
    pages[1][9].hasEOL = false
    pages[1].splice(10, 0, text('', 0, 0, 0, 0))
  }
  if (fault === 'discontinuous-next') pages[2][0].str = '[13]'
  if (fault === 'missing-eol') delete pages[1][9].hasEOL
  if (fault === 'misaligned-native-note')
    pages[1].push(text('An independent native note.', 360, 75, 180))
  if (fault === 'cross-lane-owner')
    pages[1].push(text('A separate native source crosses both lanes.', 280, 100, 260))
  if (fault === 'nonconsecutive') pages[1].find((i) => i.str === '[7]')!.str = '[70]'
  if (fault === 'missing-heading') pages[1][1].str = 'Sources'
  if (fault === 'foreign-prose')
    pages[1].push(text('An unrelated ordinary note.', 360, 75, 180, 10, 'Body'))
  return {
    numPages: pages.length,
    fingerprints: ['anonymous-partial-bibliography'],
    getPage: async (n: number) => ({
      getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
      getTextContent: async () => ({
        items: pages[n - 1],
        styles: Object.fromEntries(
          ['Body', 'Reference', 'Heading'].map((name) => [
            name,
            {
              ascent: fault === 'missing-metrics' && name === 'Reference' ? undefined : 0.8,
              descent: -0.2,
              vertical: false
            }
          ])
        )
      })
    })
  } as unknown as PDFDocumentProxy
}
it('protects a headed partial two-column bibliography while retaining earlier prose', async () => {
  const e = await extractPdfTranslationSource({
    document: columnFixture(),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  const right = e.source.units.filter(
    (u) =>
      u.fragments.some((f) => f.pageNumber === 2 && f.rect.x > 0.5) &&
      u.source.includes('Writer and Author')
  )
  expect(right.length).toBeGreaterThan(0)
  expect(right.every((u) => u.sourceOnly && u.preserve === 'reference')).toBe(true)
  expect(
    e.source.units.find(
      (u) => u.fragments[0].pageNumber === 2 && u.source.startsWith('An ordinary explanation')
    )?.sourceOnly
  ).not.toBe(true)
})

it('protects a detached citation marker beside its complete bibliography body', async () => {
  const e = await extractPdfTranslationSource({
    document: fixture('isolated-marker'),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  const marker = e.source.units.find((u) => u.source === '[Art25]')
  expect(marker).toBeDefined()
  expect(marker?.sourceOnly).toBe(true)
  expect(marker?.preserve).toBe('reference')
})

it.each([
  'nonconsecutive',
  'missing-heading',
  'foreign-prose',
  'missing-metrics',
  'discontinuous-next',
  'missing-eol',
  'misaligned-native-note',
  'cross-lane-owner'
])('refuses an incomplete partial bibliography column: %s', async (fault) => {
  const e = await extractPdfTranslationSource({
    document: columnFixture(fault),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  const right = e.source.units.filter(
    (u) =>
      u.fragments.some((f) => f.pageNumber === 2 && f.rect.x > 0.5) &&
      u.source.includes('Writer and Author')
  )
  expect(right.length).toBeGreaterThan(0)
  expect(right.some((u) => !u.sourceOnly)).toBe(true)
})
it.each([
  'marker-unheaded',
  'marker-row-mismatch',
  'marker-short-context',
  'marker-foreign-source',
  'marker-missing-metrics'
])('refuses an incomplete detached native citation marker: %s', async (fault) => {
  const e = await extractPdfTranslationSource({
    document: fixture(fault),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  const marker = e.source.units.find((u) => u.source === '[Art25]')
  expect(marker).toBeDefined()
  expect(marker?.sourceOnly).not.toBe(true)
})

it('uses an explicit empty native EOL item to close a bibliography row', async () => {
  const e = await extractPdfTranslationSource({
    document: columnFixture('empty-native-eol'),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  const right = e.source.units.filter(
    (u) =>
      u.fragments.some((f) => f.pageNumber === 2 && f.rect.x > 0.5) &&
      u.source.includes('Writer and Author')
  )
  expect(right.length).toBeGreaterThan(0)
  expect(right.every((u) => u.sourceOnly && u.preserve === 'reference')).toBe(true)
})
