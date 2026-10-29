import { describe, expect, it } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import type { PdfLayoutTextItem } from '../../src/reader/layout.js'
import { applyPdfContentFirstPolicy } from '../../src/reader/content-policy.js'

const text = (
  str: string,
  x: number,
  y: number,
  width: number,
  size = 10,
  fontName = 'Body'
): PdfLayoutTextItem & { fontName: string } => ({
  str,
  width,
  height: size,
  dir: 'ltr',
  transform: [size, 0, 0, size, x, 800 - y],
  fontName,
  hasEOL: true
})
const explanation =
  'This independent appendix explains the complete implementation and its reproducible procedure. The ordinary explanation remains separate from the preceding bibliography and the following code.'
function lastCommand(pages: ReturnType<typeof text>[][]): ReturnType<typeof text> {
  return pages.at(-1)!.find((i) => i.str.startsWith('docker load'))!
}
function fixture(
  kind: 'stacked' | 'overlapping',
  fault = ''
): { document: PDFDocumentProxy; pages: ReturnType<typeof text>[][] } {
  const pages = [
    [
      text('1.', 180, 80, 10, 11, 'Number'),
      text('Earlier construction', 195, 80, 210, 11, 'Section'),
      text(explanation, 60, 110, 480),
      text('2.', 180, 170, 10, 11, 'Number'),
      text('Independent measurements', 195, 170, 210, 11, 'Section'),
      text(explanation, 60, 200, 480)
    ],
    [
      text('References', 60, 90, 110, 12, 'Section'),
      text(
        '[1] A. Writer. A complete independent publication. Journal 12, 1–8 (2020).',
        60,
        120,
        230,
        8,
        'Citation'
      ),
      text(
        '[2] B. Author. Another complete publication. Journal 13, 2–9 (2021).',
        60,
        140,
        230,
        8,
        'Citation'
      )
    ]
  ]
  if (kind === 'stacked') {
    pages.push([
      text(
        '[3] C. Writer. Complete publication. Journal 14, 4–8 (2022).',
        60,
        120,
        230,
        8,
        'Citation'
      ),
      text(
        '[4] D. Author. Complete publication. Journal 15, 5–9 (2023).',
        60,
        140,
        230,
        8,
        'Citation'
      ),
      text('A', 400, 60, 7),
      text('PPENDIX', 408, 60, 37, 8),
      text('A', 382.5, 72, 7),
      text('UDIT', 390.5, 72, 22, 8),
      text('A', 417.5, 72, 7),
      text('PPENDIX', 425.5, 72, 37, 8),
      text('A. Overview', 320, 88, 80, 10, 'Subsection'),
      text(explanation, 320, 110, 230),
      text('B. Procedure', 320, 170, 90, 10, 'Subsection'),
      text(
        'A further independent paragraph describes the complete procedure and all ordinary implementation details.',
        320,
        195,
        230
      )
    ])
  } else {
    pages.push([
      text('Running title', 220, 35, 160, 8),
      text('Independent calculation details', 85, 70, 210, 18, 'Title'),
      text('Appendix', 150, 74, 50, 11, 'Section'),
      text('A.', 205, 74, 12, 11, 'Number'),
      text('Independent calculations', 222, 74, 225, 11, 'Section'),
      text('The polynomial profile.', 110, 110, 100, 10, 'Label'),
      text('In[1]:=', 85, 140, 25, 6, 'CodeLabel'),
      text('Expand[(u + 1)^2]', 115, 140, 120, 8, 'Code'),
      text('Out[1]=', 85, 170, 25, 6, 'CodeLabel'),
      text('1 + 2 u + u^2', 115, 170, 90, 8, 'Code')
    ])
  }
  if (kind === 'stacked') {
    pages
      .at(-1)!
      .push(
        text(
          'docker load -i archive.tar',
          320,
          225,
          'docker load -i archive.tar'.length * 8 * 0.6,
          8,
          'Code'
        ),
        text(
          'An ordinary monospaced sentence.',
          320,
          fault === 'mixed-code-prose' ? 250 : 300,
          31 * 8 * 0.6,
          8,
          'Code'
        )
      )
  }
  if (fault === 'command-prefixed-prose') {
    const item = lastCommand(pages)
    item.str = 'docker load uses a local archive.'
    item.width = item.str.length * 8 * 0.6
  }
  if (fault === 'unfinished-command') lastCommand(pages).str += ' \\'
  if (fault === 'output-explanation')
    pages
      .at(-1)!
      .push(
        text(
          'engine: *** exit detected ***',
          320,
          370,
          'engine: *** exit detected ***'.length * 8 * 0.6,
          8,
          'Code'
        ),
        text(
          'Assertion src == dst failed.',
          320,
          382,
          'Assertion src == dst failed.'.length * 8 * 0.6,
          8,
          'Code'
        ),
        text('Aborted', 320, 394, 7 * 8 * 0.6, 8, 'Code'),
        text('A separate explanation follows the diagnostic output.', 320, 430, 230)
      )
  if (kind === 'overlapping') pages.splice(1, 0, pages[0].splice(2))
  const last = pages.at(-1)!
  if (fault === 'citation-title')
    for (const item of last) if (item.str === 'Appendix') item.str = 'A study'
  if (fault === 'missing-section-witness')
    pages[0] = pages[0].filter((i) => i.fontName !== 'Section')
  if (fault === 'ordinary-title')
    for (const item of last) if (item.str === 'PPENDIX') item.str = 'NALYSIS'
  if (fault === 'foreign-prose')
    last.push(text('An unrelated native sentence shares the heading domain.', 320, 66, 190))
  if (fault === 'body-subsection')
    for (const item of last) if (item.fontName === 'Subsection') item.fontName = 'Body'
  const document = {
    numPages: pages.length,
    fingerprints: ['anonymous-compound-boundary'],
    getPage: async (number: number) => ({
      rotate: 0,
      commonObjs: {
        get: (id: string) =>
          id === 'Code' && fault !== 'missing-native-advance'
            ? {
                isMonospace: fault !== 'non-monospace',
                widths: Array.from({ length: 96 }, (_, n) =>
                  fault === 'variable-native-advance' && n === 4 ? 700 : 600
                )
              }
            : undefined
      },
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
      getTextContent: async () => ({
        items: pages[number - 1],
        styles: Object.fromEntries(
          [
            'Body',
            'Section',
            'Number',
            'Citation',
            'Subsection',
            'Title',
            'Label',
            'CodeLabel',
            'Code'
          ].map((name) => [
            name,
            {
              ascent: fault === 'missing-metrics' && name === 'Body' ? undefined : 0.8,
              descent: -0.2,
              vertical: false
            }
          ])
        )
      })
    })
  } as unknown as PDFDocumentProxy
  return { document, pages }
}

describe('complete native compound appendix boundaries', () => {
  it.each([
    ['./run.sh -a -b value', true],
    ['MODE=x ./run.sh -a -- --b', true],
    [`./r.sh${'\t-A'.repeat(14)}!`, false]
  ] as const)('preserves only complete shell commands: %s', async (command, complete) => {
    const { document, pages } = fixture('stacked')
    const item = lastCommand(pages)
    item.str = command
    item.width = command.length * item.height * 0.6
    const { source } = await extractPdfTranslationSource({
      document,
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    const prepared = applyPdfContentFirstPolicy(source)
    const explanationUnit = prepared.units.find(
      (unit) => unit.source === explanation && unit.fragments[0].pageNumber === document.numPages
    )!
    expect(explanationUnit.preserve === 'reference').toBe(!complete)
    expect(prepared.units.flatMap((unit) => unit.fragments)).toEqual(
      source.units.flatMap((unit) => unit.fragments)
    )
  })

  it.each(['stacked', 'overlapping'] as const)(
    'ends reference carryover at a complete %s appendix',
    async (kind) => {
      const { document } = fixture(kind)
      const extraction = await extractPdfTranslationSource({
        document,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      })
      const prepared = applyPdfContentFirstPolicy(extraction.source)
      const unit = prepared.units.find((u) =>
        kind === 'stacked'
          ? u.source === explanation && u.fragments[0].pageNumber === document.numPages
          : u.source.includes('Appendix A.')
      )!
      expect(unit).toBeDefined()
      expect(unit.preserve).not.toBe('reference')
      expect(unit.sourceOnly).not.toBe(true)
      if (kind === 'stacked') {
        expect(
          prepared.units.find((u) => u.source === 'docker load -i archive.tar')?.preserve
        ).toBe('code')
        expect(
          prepared.units.find((u) => u.source === 'An ordinary monospaced sentence.')?.sourceOnly
        ).not.toBe(true)
      }
      expect(
        prepared.units.filter((u) => /^\[\d\]/u.test(u.source)).every((u) => u.sourceOnly)
      ).toBe(true)
      expect(
        prepared.units.flatMap((u) =>
          u.fragments.flatMap((f) => f.items.map((i) => [f.pageNumber, i.index, i.text]))
        )
      ).toEqual(
        extraction.source.units.flatMap((u) =>
          u.fragments.flatMap((f) => f.items.map((i) => [f.pageNumber, i.index, i.text]))
        )
      )
    }
  )
  it.each([
    ['stacked', 'ordinary-title'],
    ['stacked', 'foreign-prose'],
    ['stacked', 'body-subsection'],
    ['stacked', 'missing-metrics'],
    ['stacked', 'missing-native-advance'],
    ['stacked', 'variable-native-advance'],
    ['stacked', 'non-monospace'],
    ['stacked', 'unfinished-command'],
    ['stacked', 'command-prefixed-prose'],
    ['stacked', 'mixed-code-prose'],
    ['overlapping', 'citation-title'],
    ['overlapping', 'missing-section-witness']
  ] as const)('refuses an incomplete %s boundary: %s', async (kind, fault) => {
    const { document } = fixture(kind, fault)
    const extraction = await extractPdfTranslationSource({
      document,
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    const prepared = applyPdfContentFirstPolicy(extraction.source)
    const unit = prepared.units.find((u) =>
      kind === 'stacked'
        ? u.source === explanation && u.fragments[0].pageNumber === document.numPages
        : u.source.includes('Independent calculation details')
    )!
    expect(unit).toBeDefined()
    expect(unit.sourceOnly).toBe(true)
  })
})

it('keeps an independent explanation following native diagnostic output eligible', async () => {
  const { document } = fixture('stacked', 'output-explanation')
  const extraction = await extractPdfTranslationSource({
    document,
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  const source = applyPdfContentFirstPolicy(extraction.source)
  const unit = source.units.find(
    (u) => u.source === 'A separate explanation follows the diagnostic output.'
  )!
  expect(unit).toBeDefined()
  expect(unit.sourceOnly).not.toBe(true)
  expect(source.units.find((u) => u.source === 'docker load -i archive.tar')?.preserve).toBe('code')
  expect(source.units.find((u) => u.source.includes('engine: ***'))?.preserve).toBe('code')
})
