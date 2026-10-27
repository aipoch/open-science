import { expect, it } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import type { PdfLayoutTextItem } from '../../src/reader/layout.js'

const paragraph =
  'The independent construction gives a complete mathematical explanation for the stated domain and its boundary. These ordinary explanatory sentences describe the geometric method and preserve each original source position without introducing any new model or external material.'
function fixture(fault = ''): PDFDocumentProxy {
  const text = (
    str: string,
    x: number,
    y: number,
    width: number,
    height = 10,
    fontName = 'Body',
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
  const pages = [
    [
      ...Array.from({ length: 6 }, (_, n) => text(paragraph, 60, 70 + n * 55, 470)),
      text('R', 60, 500, 8, 11.9552, 'Body', false),
      text('EFERENCES', 68, 500, 90, 9.5641)
    ],
    [
      text(
        'Writer A, Writer C and Author B. Independent methods in the Journal of Examples',
        60,
        60,
        450
      ),
      text('2015.', 80, 72, 35, 10, 'Italic'),
      text('A', 60, 160, 8, 11.9552, 'Body', false),
      text('C', 80, 160, 8, 11.9552, 'Body', false),
      text('ONSERVATIVE NATIVE', 88, 160, 145, 9.5641, 'Body', false),
      text('G', 250, 160, 8, 11.9552, 'Body', false),
      text('EOMETRY AND CONTINUOUS BOUNDARIES OF THE', 258, 160, 270, 9.5641),
      text('AND CONTINUOUS SOURCE DOMAINS', 80, 174, 240, 9.5641),
      text(
        'The construction introduced in Section 3.2 defines the following complete native source domain.',
        60,
        205,
        450
      ),
      text(paragraph, 60, 250, 470),
      text(paragraph.replace('The independent', 'This independent'), 60, 310, 470),
      text(paragraph.replace('The independent', 'Another independent'), 60, 370, 470),
      text('u = v + w', 220, 420, 70, 10, 'Math'),
      text('docker load -i archive.tar', 60, 465, 150, 10, 'Code')
    ],
    [
      text(paragraph.replace('The independent', 'A further independent'), 60, 80, 470),
      text('B', 60, 160, 8, 11.9552, 'Body', false),
      text('N', 80, 160, 8, 11.9552, 'Body', false),
      text('EXT INDEPENDENT ESTIMATES', 88, 160, 240, 9.5641),
      text(paragraph, 60, 205, 470)
    ]
  ]
  if (fault === 'author-initial') pages[1][2].str = 'A.'
  if (fault === 'no-body') pages[1].splice(8)
  if (fault === 'foreign-title-owner')
    pages[1].splice(7, 0, text('An independent foreign explanation.', 190, 160, 150))
  if (fault === 'foreign-tail-owner') pages[1][7].str += ' An independent ordinary explanation.'
  if (fault === 'unfinished-bibliography') pages[1][1].str = '2015,'
  if (fault === 'missing-B') pages[2].splice(1, 3)
  if (fault === 'different-B-font')
    for (const item of pages[2].slice(1, 4)) item.fontName = 'OtherHead'
  if (fault === 'missing-native-font') pages[1][8].fontName = 'Missing'
  if (fault === 'missing-tail-eol') pages[1][7].hasEOL = false
  if (fault === 'no-body-after-B') pages[2].pop()
  const font = {
    missingFile: false,
    isType3Font: false,
    isInvalidPDFjsFont: false,
    systemFontInfo: null,
    ascent: 0.8,
    descent: -0.2,
    vertical: false
  }
  return {
    numPages: pages.length,
    fingerprints: ['anonymous-wrapped-native-section'],
    getPage: async (n: number) => ({
      getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
      getTextContent: async () => ({
        items: pages[n - 1],
        styles: Object.fromEntries(
          ['Body', 'Italic', 'Math', 'Code', 'OtherHead'].map((name) => [
            name,
            { ascent: 0.8, descent: -0.2, vertical: false }
          ])
        )
      }),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      commonObjs: { get: () => font }
    })
  } as unknown as PDFDocumentProxy
}

it('restores complete prose below a native two-line A section without releasing its code or mathematics', async () => {
  const result = await extractPdfTranslationSource({
    document: fixture(),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  const title = result.source.units.find((u) => u.source.startsWith('A CONSERVATIVE'))
  const body = result.source.units.find(
    (u) => u.fragments[0].pageNumber === 2 && u.source === paragraph
  )
  expect(title).toBeDefined()
  expect(title?.sourceOnly).not.toBe(true)
  expect(body?.sourceOnly).not.toBe(true)
  for (const source of ['u = v + w', 'docker load -i archive.tar', '2015.']) {
    const unit = result.source.units.find((u) => u.source === source)
    expect(unit?.sourceOnly).toBe(true)
    expect(unit?.preserve).toBe('reference')
  }
  expect(result.coverage.includedItemCount).toBe(27)
  expect(result.coverage.excludedItemCount).toBe(0)
})

it.each([
  'author-initial',
  'no-body',
  'foreign-title-owner',
  'foreign-tail-owner',
  'unfinished-bibliography',
  'missing-B',
  'different-B-font',
  'missing-native-font',
  'missing-tail-eol',
  'no-body-after-B'
])(
  'retains reference protection without a complete independent A/B section proof: %s',
  async (fault) => {
    const result = await extractPdfTranslationSource({
      document: fixture(fault),
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    const title = result.source.units.find(
      (u) => u.source.startsWith('A CONSERVATIVE') || u.source.startsWith('A. CONSERVATIVE')
    )
    expect(title?.sourceOnly).toBe(true)
    expect(title?.preserve).toBe('reference')
  }
)
