import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  PDFDocument,
  PDFNumber,
  PDFRawStream,
  PDFOperator,
  PDFOperatorNames,
  pushGraphicsState,
  setLineWidth,
  moveTo,
  lineTo,
  stroke,
  popGraphicsState,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  setFillingColor,
  showText,
  rgb,
  type PDFPage
} from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readNativeReferenceEvidence } from '../../src/reader/native-reference-evidence.js'
import { expect, it } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { applyPdfContentFirstPolicy } from '../../src/reader/content-policy.js'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([false, true])(
  'retains compact references across the last two columns (numbering gap=%s)',
  (gap) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      height = 9,
      fontName = 'Reference',
      hasEOL = true
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height,
      hasEOL,
      fontName,
      transform: [height, 0, 0, height, x, y],
      fontAscent: 0.75,
      fontDescent: -0.25,
      fontVertical: false
    })
    const records = (start: number, x: number, y: number): PdfLayoutTextItem[] =>
      Array.from({ length: 6 }, (_, n) => {
        const baseline = y - n * 10.5
        const number = start + n + (gap && start > 1 && n >= 3 ? 1 : 0)
        return [
          item(`[${number}] A. Reader and T. Writer,`, x, baseline, 104, 9, 'Reference', false),
          item('Journal of Examples', x + 108, baseline, 75, 9, 'Journal', false),
          item('14', x + 187, baseline, 10, 9, 'Volume', false),
          item('(2021) 26.', x + 200, baseline, 42)
        ]
      }).flat()
    const items = [
      item('1', 557, 756, 5, 10, 'Body'),
      item('Data availability', 139, 385, 76, 9, 'Title'),
      item(
        'The material associated with these experiments is included in',
        64,
        359,
        235,
        10,
        'Body'
      ),
      item(
        'the project archive alongside our checks and source notes and is',
        54,
        347,
        245,
        10,
        'Body'
      ),
      item('openly available [2].', 54, 335, 92, 10, 'Body'),
      ...records(1, 58.6, 280),
      ...records(7, 317, 730),
      item('3', 319, 76, 4, 6, 'Note'),
      item('Please see ROR ID: https://ror.org/anonymous', 326, 73, 170, 8, 'Footer')
    ]
    const pages = [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    const { units } = groupPdfTranslationPages({ pages, pageCount: 1 })
    const refs = units.filter((unit) => unit.source.includes('Journal of Examples'))
    expect(refs).toHaveLength(12)
    expect(refs.filter((unit) => unit.sourceOnly && unit.preserve === 'reference')).toHaveLength(
      gap ? 0 : 12
    )
    expect(
      units.find((unit) => unit.source.includes('openly available'))?.sourceOnly
    ).toBeUndefined()
    expect(
      units.find((unit) => unit.source.includes('Please see ROR ID'))?.sourceOnly
    ).toBeUndefined()
  }
)

it.each([false, true])(
  'retains a full-width bibliography after run-in acknowledgments (numbering gap=%s)',
  (gap) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      height: number,
      fontName: string,
      hasEOL = true
    ): PdfLayoutTextItem => ({
      str,
      width,
      height,
      fontName,
      hasEOL,
      dir: 'ltr',
      transform: [height, 0, 0, height, x, y],
      fontAscent: 0.74,
      fontDescent: -0.24,
      fontVertical: false
    })
    const entries = (start: number, y: number): PdfLayoutTextItem[] =>
      Array.from({ length: 6 }, (_, offset) => {
        const n = start + offset,
          top = y - offset * 21
        return [
          row(
            `[${gap && n === 11 ? 15 : n}] A. Writer, Simple methods for monitoring a collection of signals,`,
            n < 10 ? 58.6 : 54,
            top,
            300,
            9,
            'Reference'
          ),
          row('Examples in Measurement', 72.3, top - 10.5, 120, 9, 'Reference', false),
          row('12', 195, top - 10.5, 12, 9, 'Volume', false),
          row(', 37 (2021).', 208, top - 10.5, 64, 9, 'Reference')
        ]
      }).flat()
    const pages = [
      [
        row('1', 556, 291, 5, 10, 'Body'),
        row('Acknowledgments.', 64, 275, 91, 10, 'Italic', false),
        row(
          'We thank the readers of the draft for suggesting refinements',
          159,
          275,
          365,
          10,
          'Body'
        ),
        row(
          'to the interpretation. The project was supported by independent research.',
          54,
          263.5,
          480,
          10,
          'Body'
        ),
        row(
          'All observations were reviewed by the authors before drawing conclusions.',
          54,
          252,
          483,
          10,
          'Body'
        ),
        row(
          'Each test was evaluated using the data described in the study.',
          54,
          240.5,
          479,
          10,
          'Body'
        ),
        row('We take responsibility for the final manuscript.', 54, 229, 224, 10, 'Body'),
        ...entries(1, 166)
      ],
      [row('2', 556, 291, 5, 10, 'Body'), ...entries(7, 275)]
    ].map((items, index) => ({ page: index + 1, width: 600, height: 300, rotation: 0, items }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    const bibliography = units.filter((unit) =>
      /A\. Writer|Examples in Measurement/u.test(unit.source)
    )
    expect(bibliography).toHaveLength(24)
    expect(
      bibliography.filter((unit) => unit.sourceOnly && unit.preserve === 'reference')
    ).toHaveLength(gap ? 0 : 24)
    expect(
      units.find((unit) => unit.source.startsWith('Acknowledgments.'))?.sourceOnly
    ).toBeUndefined()
  }
)

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

function ordinalFixture(fault = ''): PDFDocumentProxy {
  const row = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName = 'Reference',
    size = 10
  ): PdfLayoutTextItem => ({
    str,
    width,
    height: size,
    dir: 'ltr',
    transform: [size, 0, 0, size, x, 800 - y],
    fontName,
    hasEOL: true
  })
  const citation = (number: number, y: number): PdfLayoutTextItem[] => {
    const title = row(
      `${number}. A. Writer, Complete independent methods for measuring a native construction.`,
      60,
      y,
      445
    )
    const journal = row('Journal of Examples', 82, y + 12, 125, 'Italic')
    journal.hasEOL = false
    return [title, journal, row(', 10, 30–40 (2020).', 210, y + 12, 130)]
  }
  const pages = [
    [
      row('References and Notes', 60, 50, 180, 'Heading', 14),
      ...[1, 2, 3].flatMap((n, i) => citation(n, 100 + i * 55)),
      row('1', 295, 760, 6)
    ],
    [
      ...[4, 5, 6].flatMap((n, i) => citation(n, 90 + i * 55)),
      row('An independent foreign symbol.', 60, 650, 150, 'Foreign'),
      row('2', 295, 760, 6)
    ],
    [...[7, 8, 9].flatMap((n, i) => citation(n, 90 + i * 55)), row('3', 295, 760, 6)],
    [
      ...[10, 11, 12].flatMap((n, i) => citation(n, 90 + i * 55)),
      row('Acknowledgments', 60, 310, 150, 'Heading', 14),
      row(
        'We thank colleagues for useful discussions about this independent example and its ordinary measurements.',
        60,
        345,
        465
      ),
      row('Software', 60, 400, 50, 'Heading'),
      row(
        'The ordinary analysis uses independent software and a reproducible procedure that remains eligible.',
        60,
        425,
        465
      ),
      row('4', 295, 760, 6)
    ]
  ]
  if (fault === 'spacing-diacritic')
    pages[2][0].str = pages[2][0].str.replace('A. Writer,', 'A. W ˛riter,')
  if (fault === 'missing-terminal') pages[2][8].str = pages[2][8].str.slice(0, -1)
  if (fault === 'number-gap') pages[3][0].str = pages[3][0].str.replace('10.', '20.')
  if (fault === 'ordinary-note')
    pages[2][3].str =
      '8. We measured this ordinary experiment and explain its observations to readers.'
  if (fault === 'foreign-text') pages[2].push(row('An ordinary intrusive note.', 150, 155, 180))
  if (fault === 'missing-boundary') pages[3][9].str = 'An ambiguous continuation'
  if (fault === 'foreign-page-font')
    pages[2].push(row('Another independently used font.', 60, 650, 180, 'Foreign'))
  return {
    numPages: pages.length,
    fingerprints: ['anonymous-ordinal-bibliography'],
    getPage: async (n: number) => ({
      getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
      getTextContent: async () => ({
        items: pages[n - 1],
        styles: Object.fromEntries(
          ['Reference', 'Italic', 'Heading', 'Foreign'].map((name) => [
            name,
            { ascent: name === 'Foreign' ? 1.01 : 0.8, descent: -0.2, vertical: false }
          ])
        )
      }),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      commonObjs: {
        has: () => true,
        get: (name: string) => ({
          missingFile: false,
          isType3Font: false,
          isInvalidPDFjsFont: false,
          systemFontInfo: null,
          vertical: false,
          ascent: name === 'Foreign' ? 1.01 : 0.8,
          descent: -0.2
        })
      }
    })
  } as unknown as PDFDocumentProxy
}

it.each(['', 'spacing-diacritic'])(
  'keeps independent ordinal bibliography components within complete native owners: %s',
  async (fault) => {
    const result = await extractPdfTranslationSource({
      document: ordinalFixture(fault),
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    const numbered = (n: number): (typeof result.source.units)[number] | undefined =>
      result.source.units.find((u) => u.source.startsWith(`${n}. `))
    for (const n of [1, 2, 3, 7, 8, 9, 10, 11, 12]) {
      expect(numbered(n)).toBeDefined()
      expect(numbered(n)?.sourceOnly).toBe(true)
      expect(numbered(n)?.preserve).toBe('reference')
    }
    for (const n of [4, 5, 6]) expect(numbered(n)?.sourceOnly).not.toBe(true)
    for (const prefix of [
      'Acknowledgments',
      'We thank colleagues',
      'Software',
      'The ordinary analysis'
    ])
      expect(result.source.units.find((u) => u.source.startsWith(prefix))?.sourceOnly).not.toBe(
        true
      )
    const origins = result.source.units.flatMap((u) =>
      u.fragments.flatMap((f) => f.items.map((i) => `${f.pageNumber}:${i.index}`))
    )
    expect(new Set(origins).size).toBe(origins.length)
    expect(result.coverage.excludedItemCount).toBe(0)
    const optIn = applyPdfContentFirstPolicy(result.source)
    expect(
      optIn.units.find((u) => u.source.startsWith('The ordinary analysis'))?.sourceOnly
    ).not.toBe(true)
  }
)

it.each([
  'missing-terminal',
  'number-gap',
  'ordinary-note',
  'foreign-text',
  'missing-boundary',
  'foreign-page-font'
])('keeps an unclosed ordinal bibliography component eligible: %s', async (fault) => {
  const result = await extractPdfTranslationSource({
    document: ordinalFixture(fault),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  expect(result.source.units.find((u) => u.source.startsWith('7. A. Writer'))?.sourceOnly).not.toBe(
    true
  )
  expect(result.source.units.find((u) => u.source.startsWith('1. A. Writer'))?.preserve).toBe(
    'reference'
  )
})

it.each(['complete', 'foreign-form', 'diagonal-rule', 'occluding-fill'] as const)(
  'keeps native next-line text movement separate from actual paint: %s',
  async (fault) => {
    const require = createRequire(import.meta.url),
      assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/',
      pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf')),
      page = pdf.addPage([600, 800]),
      key = page.node.newFontDictionary(font.name, font.ref)
    page.pushOperators(
      pushGraphicsState(),
      beginText(),
      setFontAndSize(key, 10),
      setTextMatrix(1, 0, 0, 1, 60, 700),
      PDFOperator.of(PDFOperatorNames.SetTextLineHeight, [pdf.context.obj(14)])
    )
    for (let n = 4; n <= 6; n++)
      page.pushOperators(
        showText(font.encodeText('[' + n + '] A. Writer. A complete original publication.')),
        PDFOperator.of(PDFOperatorNames.NextLine),
        PDFOperator.of(PDFOperatorNames.MoveText, [pdf.context.obj(12), pdf.context.obj(0)]),
        showText(font.encodeText('Independent Journal volume ' + (n + 10) + ' (200' + n + ').')),
        PDFOperator.of(PDFOperatorNames.NextLine),
        PDFOperator.of(PDFOperatorNames.MoveText, [pdf.context.obj(-12), pdf.context.obj(0)])
      )
    page.pushOperators(endText(), popGraphicsState())
    page.drawText('1', { font, size: 10, x: 296, y: 45 })
    if (fault === 'foreign-form') {
      const formPdf = await PDFDocument.create(),
        formPage = formPdf.addPage([40, 40])
      formPage.drawLine({ start: { x: 1, y: 1 }, end: { x: 35, y: 35 } })
      const [form] = await pdf.embedPdf(await formPdf.save())
      page.drawPage(form, { x: 500, y: 50 })
    }
    if (fault === 'diagonal-rule')
      page.drawLine({ start: { x: 60, y: 700 }, end: { x: 400, y: 600 } })
    if (fault === 'occluding-fill')
      page.drawRectangle({ x: 55, y: 650, width: 280, height: 70, color: rgb(1, 1, 1) })
    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl: assets
    })
    try {
      const document = await loading.promise,
        nativePage = await document.getPage(1),
        content = await nativePage.getTextContent(),
        operators = await nativePage.getOperatorList(),
        evidence = await readNativeReferenceEvidence(nativePage, content)
      expect(operators.fnArray.filter((op) => op === OPS.nextLine)).toHaveLength(7)
      expect(evidence.complete).toBe(fault === 'complete')
      const extraction = await extractPdfTranslationSource({
          document,
          resourceRequestKey: 'generated-native-next-line',
          signal: new AbortController().signal
        }),
        references = extraction.source.units.filter((u) => /^\[[4-6]\]/u.test(u.source))
      expect(references).toHaveLength(3)
      expect(
        references.every((u) => u.sourceOnly && u.preserve === 'reference'),
        JSON.stringify({ evidence, items: content.items, references })
      ).toBe(fault === 'complete')
      expect(extraction.coverage.excludedItemCount).toBe(0)
      expect(
        extraction.source.units.flatMap((u) => u.fragments.flatMap((f) => f.items))
      ).toHaveLength(7)
    } finally {
      await loading.destroy()
    }
  }
)

const ownedReferenceApi = await import('../../src/reader/unheaded-reference-packets.js')
const referenceRoleApi = await import('../../src/reader/native-reference-evidence.js')
const referenceLayoutApi = await import('../../src/reader/layout.js')

async function generatedOwnedReferenceDocument(
  fault = '',
  embedded = false
): Promise<PDFDocumentProxy> {
  const require = createRequire(import.meta.url),
    assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/',
    pdf = await PDFDocument.create()
  pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
  const regular = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf')),
    bold = await pdf.embedFont(await readFile(assets + 'LiberationSans-Bold.ttf')),
    splitEtAl = fault.endsWith('-et-al'),
    wrappedWeb = fault.endsWith('-web'),
    terminal = wrappedWeb || (splitEtAl && fault !== 'nonterminal-et-al'),
    pages = Array.from({ length: terminal ? 2 : 3 }, () => pdf.addPage([600, 800])),
    line = (page: number, text: string, x: number, top: number, heading = false): void => {
      pages[page - 1].drawText(text, {
        font: heading ? bold : regular,
        size: heading ? 12 : 9,
        x,
        y: 800 - top
      })
    },
    start = (page: number, number: number, text: string, x: number, top: number): void => {
      if (embedded) {
        line(page, `[${number}] ${text}`, x, top)
        return
      }
      pages[page - 1].drawText(`[${number}]`, { font: bold, size: 9, x, y: 800 - top })
      line(page, text, x + 20, top)
    }
  line(
    1,
    'This complete ordinary paragraph remains eligible before the publication records.',
    56,
    500,
    true
  )
  start(1, 1, 'A. Writer, Independent measurements,', 56, 630)
  line(1, 'Journal of Examples 10 (2020).', 76, 644)
  start(1, 2, 'B. Author,', 56, 770)
  line(2, 'A complete report across pages, Journal of Examples 11 (2021).', 76, 60)
  start(
    2,
    fault === 'number-gap' ? 8 : 3,
    fault === 'ordinary-instruction'
      ? 'We must review this ordinary instruction,'
      : 'C. Writer, Exact independent observations,',
    56,
    100
  )
  line(2, 'Annual Review of Comprehensive Scientific Measurements', 76, 114)
  pages[1].drawText('12 (2022).', { font: bold, size: 9, x: 315, y: 800 - 114 })
  if (wrappedWeb) {
    const page = pages[1],
      lead = '[4] Example Institute Field Guide,',
      host = 'https://manual.example.',
      suffix = fault === 'broken-web' ? 'org' : 'org/',
      urlFont = bold
    line(2, lead, 56, 750)
    page.drawText(host, {
      font: urlFont,
      size: 9,
      x: 58 + regular.widthOfTextAtSize(lead, 9),
      y: 50
    })
    page.drawText(suffix, { font: urlFont, size: 9, x: 356, y: 740 })
    line(2, '(2023).', 358 + urlFont.widthOfTextAtSize(suffix, 9), 60)
  } else {
    start(2, 4, 'D. Author,', 56, 750)
    line(2, 'A report across columns, Journal 13 (2023).', 356, 60)
  }
  if (embedded) {
    const page = pages[1],
      marker = '[5] ',
      text = 'E. Writer, Independent observations, Journal 14 (2024).',
      face = page.node.newFontDictionary(regular.name, regular.ref)
    page.pushOperators(
      pushGraphicsState(),
      beginText(),
      setFontAndSize(face, 9),
      setTextMatrix(1, 0, 0, 1, 336, 700),
      showText(regular.encodeText(marker)),
      setFillingColor(rgb(0, 0, 0)),
      ...(fault === 'matrix-reset'
        ? [setTextMatrix(1, 0, 0, 1, 336 + regular.widthOfTextAtSize(marker, 9), 700)]
        : []),
      ...(splitEtAl
        ? [
            showText(regular.encodeText('E. Writer ')),
            setFontAndSize(page.node.newFontDictionary(bold.name, bold.ref), 9),
            showText(bold.encodeText('et al.')),
            setFontAndSize(face, 9),
            showText(
              regular.encodeText(
                fault === 'undated-et-al'
                  ? ', Independent observations, Journal 14.'
                  : ', Independent observations, Journal 14 (2024).'
              )
            )
          ]
        : [showText(regular.encodeText(text))]),
      endText(),
      popGraphicsState()
    )
  } else {
    start(2, 5, 'E. Writer, Independent terminal observations,', 336, 100)
    line(
      2,
      fault === 'missing-terminal'
        ? 'Journal of Examples 14 (2024)'
        : 'Journal of Examples 14 (2024).',
      356,
      114
    )
  }
  if (fault === 'foreign-overlap') line(2, 'An independent note.', 230, 65)
  if (!terminal) {
    line(3, 'Appendix A', 56, 60, true)
    line(
      3,
      'This independent appendix paragraph remains eligible for ordinary translation.',
      56,
      90
    )
  }
  const loading = getDocument({
    data: await pdf.save(),
    fontExtraProperties: true,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    standardFontDataUrl: assets
  })
  return loading.promise
}

async function generatedOwnedReferenceProof(
  fault = '',
  embedded = false
): Promise<{
  document: PDFDocumentProxy
  pages: import('../../src/reader/layout.js').PdfLayoutPage[]
  native: Awaited<ReturnType<PDFDocumentProxy['getPage']>>[]
  contents: Awaited<
    ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['getTextContent']>
  >[]
  units: import('../../src/reader/layout.js').PdfTranslationLayout['units']
  proof: object | undefined
  unreliable: Set<string>
}> {
  const document = await generatedOwnedReferenceDocument(fault, embedded),
    pages: import('../../src/reader/layout.js').PdfLayoutPage[] = [],
    native: Awaited<ReturnType<PDFDocumentProxy['getPage']>>[] = [],
    unreliable = new Set<string>(),
    contents: Awaited<
      ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['getTextContent']>
    >[] = []
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number),
      content = await page.getTextContent()
    await page.getOperatorList()
    native.push(page)
    contents.push(content)
    pages.push({
      page: number,
      width: 600,
      height: 800,
      rotation: 0,
      items: content.items.flatMap((item) =>
        'str' in item
          ? [
              {
                ...item,
                fontAscent: content.styles[item.fontName].ascent,
                fontDescent: content.styles[item.fontName].descent,
                fontVertical: content.styles[item.fontName].vertical
              }
            ]
          : []
      )
    })
  }
  const units = referenceLayoutApi.groupPdfTranslationPages({ pages }).units
  for (let index = 0; index < pages.length; index++) {
    if (fault === 'missing-eof' && index === 1) {
      const original = native[index].getOperatorList.bind(native[index])
      native[index].getOperatorList = async (...args) => ({
        ...(await original(...args)),
        lastChunk: false
      })
    }
    if (fault === 'font-get-failure' && index === 1)
      native[index].commonObjs.get = () => {
        throw new Error('Anonymous unavailable native font')
      }
    await referenceRoleApi.bindNativeReferenceRolePage(
      pages[index],
      native[index],
      contents[index],
      document,
      new AbortController().signal,
      unreliable
    )
  }
  const proof = ownedReferenceApi.nativeOwnedUnheadedReferenceRoles(units, pages)
  return { document, pages, native, contents, units, proof, unreliable }
}

it.each(['complete-web', 'broken-web'])(
  'checks completeness of a terminal cross-column bibliography URL (%s)',
  async (fault) => {
    const f = await generatedOwnedReferenceProof(fault, true)
    try {
      const selected = f.units.filter((unit) =>
        ownedReferenceApi.hasNativeOwnedReferenceRole(f.proof, unit)
      )
      expect(selected.some((unit) => unit.source.includes('Field Guide'))).toBe(
        fault === 'complete-web'
      )
      expect(selected.some((unit) => unit.source.startsWith('This complete ordinary'))).toBe(false)
    } finally {
      await f.document.destroy()
    }
  }
)

it('binds complete native crosspage and crosscolumn reference owners without changing their content', async () => {
  const f = await generatedOwnedReferenceProof()
  try {
    const selected = f.units.filter((unit) =>
        ownedReferenceApi.hasNativeOwnedReferenceRole(f.proof, unit)
      ),
      original = JSON.stringify(f.units),
      nativeItems = f.pages.flatMap((page) =>
        page.items.filter((item) => item.str.trim()).map((item) => item.str)
      )
    expect(f.proof).toBeDefined()
    expect(selected.length).toBeGreaterThan(0)
    expect(selected.some((unit) => /Review/u.test(unit.source))).toBe(true)
    expect(
      selected.every((unit) =>
        unit.items.every((key) => {
          const [page, index] = key.split(':').map(Number)
          return (
            f.pages[page - 1].items[index].str === unit.originalStrings[unit.items.indexOf(key)]
          )
        })
      )
    ).toBe(true)
    expect(selected.some((unit) => unit.items.some((key) => key.startsWith('1:')))).toBe(true)
    expect(selected.some((unit) => unit.items.some((key) => key.startsWith('2:')))).toBe(true)
    expect(selected.every((unit) => !unit.sourceOnly && !unit.preserve)).toBe(true)
    expect(ownedReferenceApi.hasNativeOwnedReferenceRole({ ...f.proof }, selected[0])).toBe(false)
    expect(ownedReferenceApi.hasNativeOwnedReferenceRole(f.proof, { ...selected[0] })).toBe(false)
    expect(JSON.stringify(f.units)).toBe(original)
    expect(nativeItems.some((str) => str.startsWith('This complete ordinary'))).toBe(true)
  } finally {
    await f.document.destroy()
  }
})

it.each(['same text advance', 'matrix-reset', 'missing-eof'])(
  'recognizes bibliography markers printed with authors only with a closed native row: %s',
  async (mode) => {
    const f = await generatedOwnedReferenceProof(mode, true)
    try {
      const selected = f.units.filter((unit) =>
        ownedReferenceApi.hasNativeOwnedReferenceRole(f.proof, unit)
      )
      const tail = await f.native[1].getTextContent()
      expect(tail.items.findLast((item) => 'str' in item && item.str.trim())).toMatchObject({
        str: '[5] E. Writer, Independent observations, Journal 14 (2024).',
        hasEOL: false
      })
      expect(selected.some((unit) => unit.source.startsWith('[5]'))).toBe(
        mode === 'same text advance'
      )
      expect(selected.some((unit) => unit.source.startsWith('This complete ordinary'))).toBe(false)
    } finally {
      await f.document.destroy()
    }
  }
)

it.each(['split-et-al', 'undated-et-al', 'nonterminal-et-al'])(
  'binds split author punctuation only in a closed terminal native bibliography: %s',
  async (fault) => {
    const f = await generatedOwnedReferenceProof(fault, true)
    try {
      const tail = f.pages[1].items.slice(-2)
      expect(tail[0].str).toBe('et al.')
      expect(tail[1].str).toMatch(/^, Independent observations/u)
      const citation = f.units.find((unit) => unit.source.startsWith('[5]')),
        prose = f.units.find((unit) => unit.source.startsWith('This complete ordinary'))
      expect(citation).toBeDefined()
      expect(prose).toBeDefined()
      expect(ownedReferenceApi.hasNativeOwnedReferenceRole(f.proof, citation!)).toBe(
        fault === 'split-et-al'
      )
      expect(ownedReferenceApi.hasNativeOwnedReferenceRole(f.proof, prose!)).toBe(false)
    } finally {
      await f.document.destroy()
    }
  }
)

it.each([
  'missing-terminal',
  'number-gap',
  'ordinary-instruction',
  'foreign-overlap',
  'missing-eof',
  'font-get-failure'
])(
  'does not grant a complete logical reference role without independent evidence: %s',
  async (fault) => {
    const f = await generatedOwnedReferenceProof(fault)
    try {
      expect(f.proof).toBeUndefined()
      expect(
        f.units.some((unit) => ownedReferenceApi.hasNativeOwnedReferenceRole(f.proof, unit))
      ).toBe(false)
    } finally {
      await f.document.destroy()
    }
  }
)

it('revokes a native reference role after Source identity, font identity or boundary evidence changes', async () => {
  const f = await generatedOwnedReferenceProof()
  try {
    const selected = f.units.find((unit) =>
      ownedReferenceApi.hasNativeOwnedReferenceRole(f.proof, unit)
    )
    expect(selected).toBeDefined()
    const operators = await f.native[1].getOperatorList(),
      lastChunk = operators.lastChunk
    expect(referenceRoleApi.nativeReferenceRolePagesCurrent(f.pages, f.unreliable)).toBe(true)
    operators.lastChunk = false
    expect(referenceRoleApi.nativeReferenceRolePagesCurrent(f.pages, f.unreliable)).toBe(false)
    operators.lastChunk = lastChunk
    expect(referenceRoleApi.nativeReferenceRolePagesCurrent(f.pages, f.unreliable)).toBe(true)
    const item = f.pages[1].items[0]
    f.pages[1].items[0] = { ...item }
    expect(ownedReferenceApi.hasNativeOwnedReferenceRole(f.proof, selected!)).toBe(false)
    f.pages[1].items[0] = item
    expect(ownedReferenceApi.hasNativeOwnedReferenceRole(f.proof, selected!)).toBe(true)
    const originalGet = f.native[1].commonObjs.get,
      get = (key: string): ReturnType<typeof originalGet> =>
        originalGet.call(f.native[1].commonObjs, key),
      name = f.contents[1].items.find((item) => 'str' in item && item.str.trim())!
    if (!('str' in name)) throw new Error('Expected real native text')
    const font = get(name.fontName)
    f.native[1].commonObjs.get = (key: string) => (key === name.fontName ? { ...font } : get(key))
    expect(ownedReferenceApi.hasNativeOwnedReferenceRole(f.proof, selected!)).toBe(false)
    f.native[1].commonObjs.get = originalGet
    expect(ownedReferenceApi.hasNativeOwnedReferenceRole(f.proof, selected!)).toBe(true)
    const heading = f.pages[2].items[0].str
    f.pages[2].items[0].str = 'An incomplete ordinary continuation'
    expect(ownedReferenceApi.hasNativeOwnedReferenceRole(f.proof, selected!)).toBe(false)
    f.pages[2].items[0].str = heading
    expect(ownedReferenceApi.hasNativeOwnedReferenceRole(f.proof, selected!)).toBe(true)
  } finally {
    await f.document.destroy()
  }
})

it('protects only complete native reference owners through the ordinary extraction path', async () => {
  const document = await generatedOwnedReferenceDocument()
  try {
    const extraction = await extractPdfTranslationSource({
        document,
        resourceRequestKey: 'anonymous-complete-reference-owners',
        signal: new AbortController().signal
      }),
      references = extraction.source.units.filter(
        (unit) =>
          unit.fragments.some((fragment) => fragment.pageNumber === 2) ||
          /^\[[12]\]/u.test(unit.source)
      ),
      origins = extraction.source.units.flatMap((unit) =>
        unit.fragments.flatMap((fragment) =>
          fragment.items.map((item) => `${fragment.pageNumber}:${item.index}`)
        )
      )
    expect(references.length).toBeGreaterThan(0)
    expect(
      references.every(
        (unit) => unit.sourceOnly && (unit.preserve === 'reference' || unit.preserve === 'formula')
      ),
      JSON.stringify(
        references.map((unit) => ({
          text: unit.source,
          sourceOnly: unit.sourceOnly,
          preserve: unit.preserve
        }))
      )
    ).toBe(true)
    expect(references.some((unit) => unit.preserve === 'reference')).toBe(true)
    expect(references.some((unit) => /Review/u.test(unit.source))).toBe(true)
    expect(
      extraction.source.units.find((unit) => unit.source.startsWith('This complete ordinary'))
        ?.preserve
    ).toBeUndefined()
    expect(
      extraction.source.units.find((unit) => unit.source.startsWith('This independent appendix'))
        ?.sourceOnly
    ).not.toBe(true)
    expect(new Set(origins).size).toBe(origins.length)
    expect(extraction.coverage.excludedItemCount).toBe(0)
  } finally {
    await document.destroy()
  }
})

it('does not partially protect an owner that also contains ordinary native content outside the range', async () => {
  const f = await generatedOwnedReferenceProof()
  try {
    const selected = f.units.find((unit) =>
        ownedReferenceApi.hasNativeOwnedReferenceRole(f.proof, unit)
      ),
      ordinary = f.units.find((unit) => unit.source.startsWith('This complete ordinary'))
    expect(selected).toBeDefined()
    expect(ordinary).toBeDefined()
    const units = f.units.filter((unit) => unit !== ordinary)
    selected!.items.push(...ordinary!.items)
    selected!.originalStrings.push(...ordinary!.originalStrings)
    expect(ownedReferenceApi.nativeOwnedUnheadedReferenceRoles(units, f.pages)).toBeUndefined()
  } finally {
    await f.document.destroy()
  }
})

const rightColumnBibliographyShapes = [
  'closed',
  'ordinal gap',
  'centered folio',
  'shifted folio',
  'compact DOI',
  'shifted DOI',
  'terminal archive',
  'terminal archive with ordinary line',
  'terminal archive with row reset'
]

it.each(rightColumnBibliographyShapes)(
  'keeps only a closed terminal right-column native bibliography: %s',
  async (shape) => {
    const require = createRequire(import.meta.url),
      assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/',
      pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const regular = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf')),
      bold = await pdf.embedFont(await readFile(assets + 'LiberationSans-Bold.ttf')),
      withFolio = shape.endsWith('folio'),
      compact = shape.endsWith('DOI'),
      journalLane = shape.startsWith('terminal archive'),
      addFolio = (n: number): ReturnType<typeof pdf.addPage> => {
        const page = pdf.addPage([612, 792]),
          text = String(n)
        page.drawText(text, {
          font: regular,
          size: 10,
          x:
            306 -
            regular.widthOfTextAtSize(text, 10) / 2 +
            (n === 2 && shape === 'shifted folio' ? 1 : 0),
          y: 42
        })
        return page
      }
    if (withFolio) {
      addFolio(1)
      addFolio(2)
    }
    const page = pdf.addPage([612, 792])
    page.drawText('Independent prose remains readable in the left column.', {
      font: regular,
      size: 10,
      x: 52,
      y: 260
    })
    page.drawText('The preceding right column ends here.', {
      font: regular,
      size: 10,
      x: 318,
      y: 405
    })
    let compactY = 350
    if (journalLane) {
      const size = 9
      const rail = 318
      const continuation = 337
      const print = (text: string, x: number, font = regular): void =>
        page.drawText(text, { font, size, x, y: compactY })
      for (let i = 1; i <= 8; i++) {
        const author = `[${i}] ${i === 8 ? 'G. de Silva' : 'A. Reader'}, `
        const wraps = i < 5
        if (wraps) {
          print(author + 'Earlier observations,', rail)
          compactY -= 10.5
        }
        const lead = (wraps ? '' : author) + 'Journal of Examples '
        const x0 = wraps ? continuation : rail
        print(lead, x0)
        const x = x0 + regular.widthOfTextAtSize(lead, size)
        print('12', x, bold)
        print(', 100 (2020).', x + bold.widthOfTextAtSize('12', size))
        compactY -= 10.5
      }
      // Add one ordinary author after the particle witness. The journal cohort
      // still needs eight independently recognized dated records.
      const lead = '[9] A. Clerk, Journal of Examples '
      print(lead, rail)
      const volumeX = rail + regular.widthOfTextAtSize(lead, size)
      print('3', volumeX, bold)
      print(', 10 (2019).', volumeX + bold.widthOfTextAtSize('3', size))
      compactY -= 10.5
      const book = '[10] A. Reader, Handbook of Samples '
      print(book, rail)
      compactY -= 10.5
      print('(Example Press, 2020), p. 8.', continuation, bold)
      compactY -= 10.5
      print('[11] B. Clerk, Citation statement (2012), math-', rail)
      compactY -= 10.5
      print('st/0000000.', continuation)
      compactY -= 10.5
      const final = shape.endsWith('ordinary line')
          ? '[12] C. Reader, A final ordinary sentence about '
          : '[12] C. Reader, Ph.D. thesis, Example College (202',
        tail = shape.endsWith('ordinary line') ? 'cats.' : '1).',
        advance = regular.widthOfTextAtSize(final, size)
      page.pushOperators(
        beginText(),
        setFontAndSize(page.node.newFontDictionary(regular.name, regular.ref), size),
        setTextMatrix(1, 0, 0, 1, rail, compactY),
        showText(regular.encodeText(final)),
        ...(shape.endsWith('row reset')
          ? [setTextMatrix(1, 0, 0, 1, rail + advance, compactY)]
          : [
              PDFOperator.of(PDFOperatorNames.MoveText, [
                pdf.context.obj(advance),
                pdf.context.obj(0)
              ])
            ]),
        showText(regular.encodeText(tail)),
        endText()
      )
    }
    for (let i = 0; i < (journalLane ? 0 : 8); i++) {
      if (compact) {
        const x = 318,
          size = 9,
          pitch = 10.5
        if (i === 1 || i === 6) {
          page.drawText(`[${i + 1}] A. Reader and N. Clerk, arXiv:0000.0000.`, {
            font: regular,
            size,
            x,
            y: compactY
          })
        } else if (i === 5) {
          page.drawText('[6] A. Reader, DOI: 10.1234/example-', {
            font: regular,
            size,
            x,
            y: compactY
          })
          compactY -= pitch
          page.drawText('4.', {
            font: regular,
            size,
            x: 337 + (shape === 'shifted DOI' ? 2 : 0),
            y: compactY
          })
        } else {
          const journal = `[${i + 1}] A. Reader, Journal of Examples `
          page.drawText(journal, { font: regular, size, x, y: compactY })
          if (i === 7) compactY -= pitch
          const volumeX = i === 7 ? 337 : x + regular.widthOfTextAtSize(journal, size),
            volume = '12'
          page.drawText(volume, { font: bold, size, x: volumeX, y: compactY })
          page.drawText(', 100 (2020).', {
            font: regular,
            size,
            x: volumeX + bold.widthOfTextAtSize(volume, size),
            y: compactY
          })
        }
        compactY -= pitch
        continue
      }
      const n = shape === 'ordinal gap' && i === 4 ? 9 : i + 1,
        y = 350 - i * 22,
        size = 9,
        journal = 'Journal of Native Tests ',
        x = 337,
        volume = '12'
      page.drawText(`[${n}] A. Reader, Complete independent study,`, {
        font: regular,
        size,
        x: 318,
        y
      })
      page.drawText(journal, { font: regular, size, x, y: y - 11 })
      const volumeX = x + regular.widthOfTextAtSize(journal, size)
      page.drawText(volume, { font: bold, size, x: volumeX, y: y - 11 })
      page.drawText(', 100 (2020).', {
        font: regular,
        size,
        x: volumeX + bold.widthOfTextAtSize(volume, size),
        y: y - 11
      })
    }
    if (withFolio)
      page.drawText('3', {
        font: regular,
        size: 10,
        x: 306 - regular.widthOfTextAtSize('3', 10) / 2,
        y: 42
      })
    const loading = getDocument({
      data: await pdf.save(),
      disableFontFace: true,
      standardFontDataUrl: assets
    })
    try {
      const { source } = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'terminal-native-bibliography',
        signal: new AbortController().signal
      })
      const owners = source.units.filter((unit) =>
        compact || journalLane
          ? unit.fragments.every((fragment) => fragment.rect.x > 0.5 && fragment.rect.y > 0.54)
          : unit.source.includes('Complete independent study') ||
            unit.source.startsWith('Journal of Native Tests')
      )
      if (journalLane) {
        expect(owners.filter((unit) => /^\[\d+\]/u.test(unit.source))).toHaveLength(12)
        expect(owners.every((unit) => unit.sourceOnly)).toBe(shape === 'terminal archive')
      } else if (compact) {
        expect(owners.length).toBeGreaterThanOrEqual(8)
        expect(owners.filter((unit) => /^\[\d+\]/u.test(unit.source))).toHaveLength(8)
        expect(owners.some((unit) => unit.source.includes('DOI:'))).toBe(true)
        expect(owners.filter((unit) => !unit.sourceOnly).length === 0).toBe(shape === 'compact DOI')
      } else {
        expect(owners).toHaveLength(16)
        expect(
          owners.every(
            (unit) =>
              Boolean(unit.sourceOnly) === (shape === 'closed' || shape === 'centered folio')
          )
        ).toBe(true)
      }
      const nearby = source.units.filter(
        (unit) =>
          unit.source.startsWith('Independent prose') ||
          unit.source.startsWith('The preceding right column')
      )
      expect(nearby).toHaveLength(2)
      expect(nearby.every((unit) => !unit.sourceOnly)).toBe(true)
    } finally {
      await loading.destroy()
    }
  }
)

it.each([
  'complete',
  'number-gap',
  'ordinary-tail',
  'embedded-note',
  'embedded-note-incomplete',
  'funded',
  'funded-gap',
  'funded-embedded-note'
] as const)(
  'protects only a complete terminal right-column superscript bibliography: %s',
  async (fault) => {
    const require = createRequire(import.meta.url),
      assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/',
      pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf')),
      page = pdf.addPage([600, 800]),
      mixed =
        fault === 'embedded-note' ||
        fault === 'embedded-note-incomplete' ||
        fault === 'funded-embedded-note',
      funded = fault === 'funded' || fault === 'funded-gap' || fault === 'funded-embedded-note'
    if (!mixed && !funded) {
      const graphic = await PDFDocument.create()
      graphic.addPage([90, 70]).drawRectangle({ x: 7, y: 9, width: 39, height: 23 })
      const [embedded] = await pdf.embedPdf(await graphic.save())
      page.drawPage(embedded, { x: 48, y: 590 })
    }
    page.drawText('Independent prose in the other column remains eligible.', {
      font,
      size: 10,
      x: 54,
      y: 701
    })
    if (funded) page.drawText('Acknowledgments', { font, size: 9, x: 54, y: 670 })
    const preceding = funded
      ? 'This work was supported by field research (Grant No. 29).'
      : 'Independent prose ends before the records.'
    page.drawText(preceding, { font, size: 10, x: 320, y: 701 })
    page.pushOperators(beginText())
    for (let n = 0; n < (mixed || funded ? 8 : 5); n++) {
      const ordinal = String(
          n === 2 && (fault === 'number-gap' || fault === 'funded-gap') ? 9 : n + 1
        ),
        y = 678 - n * 11,
        height = 6.75,
        x = 333 - font.widthOfTextAtSize(ordinal, height) - 0.2
      let record =
        funded && !mixed
          ? n === 3
            ? 'Example software (available at: https://example.test/).'
            : 'Taylor Reader, Journal of Examples 12 (2020).'
          : 'A. Writer, Journal of Examples 12 (2020).'
      if (fault === 'ordinary-tail' && n === 4) record = 'We now present ordinary observations.'
      if (mixed && n === 3) record = 'These comments explain why the values were adjusted.'
      if (mixed && n === 5) record = 'B. Writer, 2021, unpublished.'
      if (fault === 'embedded-note-incomplete' && n === 7) record = 'C. Reader, Journal of Examples'
      page.pushOperators(
        setFontAndSize(page.node.newFontDictionary(font.name, font.ref), height),
        setTextMatrix(1, 0, 0, 1, x, y + 2.8),
        showText(font.encodeText(ordinal)),
        setFontAndSize(page.node.newFontDictionary(font.name, font.ref), 9),
        setTextMatrix(1, 0, 0, 1, 333, y),
        showText(font.encodeText(record))
      )
    }
    page.pushOperators(endText())
    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl: assets
    })
    try {
      const document = await loading.promise
      const result = await extractPdfTranslationSource({
        document,
        resourceRequestKey: 'native-test',
        signal: new AbortController().signal
      })
      expect(result.coverage.excludedItemCount).toBe(0)
      const references = result.source.units.filter((unit) => unit.preserve === 'reference')
      const prose = result.source.units
        .filter((unit) => !unit.sourceOnly)
        .map((unit) => unit.source)
        .join(' ')
      expect(prose).toContain('Independent prose in the other column remains eligible.')
      expect(prose).toContain(preceding)
      const referenceItems = references.flatMap((unit) => unit.fragments.flatMap((f) => f.items))
      if (mixed) {
        const note = result.source.units.find((unit) =>
          unit.source.includes('These comments explain')
        )
        expect(note?.source).toContain('3A. Writer')
        expect(note?.sourceOnly).toBeUndefined()
        expect(references.some((unit) => unit.source.includes('unpublished'))).toBe(
          fault === 'embedded-note' || fault === 'funded-embedded-note'
        )
      }
      expect(referenceItems).toHaveLength(
        fault === 'complete'
          ? 10
          : fault === 'embedded-note' || fault === 'funded-embedded-note'
            ? 6
            : fault === 'funded'
              ? 16
              : 0
      )
      expect(references.every((unit) => unit.sourceOnly)).toBe(true)
    } finally {
      await loading.destroy()
    }
  }
)

it.each(['complete', 'tilted divider', 'number gap'])(
  'requires a closed raised bibliography below a native solid divider (%s)',
  async (shape) => {
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const page = pdf.addPage([600, 800])
    page.drawText('1', { font, size: 10, x: 540, y: 760 })
    page.drawText('Acknowledgments', { font, size: 10, x: 388, y: 663 })
    const prose = 'Independent prose remains eligible.'
    page.drawText(prose, { font, size: 10, x: 322, y: 635 })
    const mask = PDFRawStream.of(
      pdf.context.obj({
        Type: 'XObject',
        Subtype: 'Image',
        Width: 1,
        Height: 1,
        ImageMask: true,
        BitsPerComponent: 1,
        Length: 1
      }),
      Uint8Array.of(0)
    )
    const name = page.node.newXObject('Divider', pdf.context.register(mask))
    page.pushOperators(
      pushGraphicsState(),
      PDFOperator.of(
        PDFOperatorNames.ConcatTransformationMatrix,
        [240, shape === 'tilted divider' ? 2 : 0, 0, -0.8, 180, 615].map(PDFNumber.of)
      ),
      PDFOperator.of(PDFOperatorNames.DrawObject, [name]),
      popGraphicsState(),
      beginText()
    )
    const face = page.node.newFontDictionary(font.name, font.ref)
    const draw = (text: string, size: number, x: number, y: number): void =>
      page.pushOperators(
        setFontAndSize(face, size),
        setTextMatrix(1, 0, 0, 1, x, y),
        showText(font.encodeText(text))
      )
    for (let i = 0; i < 6; i++) {
      const ordinal = String(shape === 'number gap' && i === 4 ? 8 : i + 1)
      const y = 585 - (i % 3) * 22
      const rail = i < 3 ? 64 : 324
      draw(ordinal, 6, rail - font.widthOfTextAtSize(ordinal, 6) - 4.5, y + 3.8)
      draw('A. Reader, A study of the spectral response,', 9, rail, y)
      if (i === 3) {
        draw('Term X', 9, rail, y - 11)
        const script = rail + font.widthOfTextAtSize('Term X', 9)
        draw('2', 6, script, y - 12)
        draw('O, Example Journal 12 (2021)', 9, script + font.widthOfTextAtSize('2', 6), y - 11)
      } else draw('Example Journal 12 (2021)', 9, rail, y - 11)
    }
    page.pushOperators(endText())

    const loading = getDocument({
      data: await pdf.save(),
      disableFontFace: true,
      fontExtraProperties: true,
      isEvalSupported: false,
      useSystemFonts: false,
      standardFontDataUrl: assets
    })
    try {
      const document = await loading.promise
      expect((await (await document.getPage(1)).getOperatorList()).fnArray).toContain(
        OPS.paintSolidColorImageMask
      )
      const { source } = await extractPdfTranslationSource({
        document,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      })
      const citations = source.units.filter((unit) =>
        /A study of the spectral response|Example Journal/u.test(unit.source)
      )
      expect(citations).toHaveLength(8)
      expect(citations.every((unit) => Boolean(unit.sourceOnly) === (shape === 'complete'))).toBe(
        true
      )
      expect(source.units.find((unit) => unit.source === prose)?.sourceOnly).toBeUndefined()
    } finally {
      await loading.destroy()
    }
  }
)

it.each([
  'contact footer',
  'labelled contact footer',
  'classified preprint',
  'mismatched preprint year',
  'unmarked address'
])('recognizes a complete final bibliography after a marked address: %s', async (shape) => {
  const require = createRequire(import.meta.url)
  const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
  const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
  const [first, last] = [pdf.addPage([600, 800]), pdf.addPage([600, 800])]
  const line = (page: typeof first, text: string, x: number, y: number, size = 9): void =>
    page.drawText(text, { font, size, x, y })

  line(first, 'The final paragraph describes the observations.', 320, 670, 11)
  line(first, shape === 'unmarked address' ? 'x' : '*', 328, 634, 6)
  line(
    first,
    shape === 'labelled contact footer'
      ? 'Contact author: author@example.org'
      : 'author@example.org',
    339,
    630
  )
  line(first, '[1] A. Writer, An independent study,', 320, 619)
  line(first, 'Journal of Examples 11 (2020).', 339, 608)
  line(first, '[2] B. Van Dalen, Another independent study,', 320, 597)
  line(first, 'Journal of Examples 12 (2021).', 339, 586)
  line(first, '[3] C. Writer, A separate measurement,', 320, 575)
  line(first, 'Journal of Examples 13 (2022).', 339, 564)
  line(last, '[4] D. Writer, An independent replication,', 50, 730)
  line(last, 'Journal of Examples 14 (2023).', 69, 719)
  if (shape === 'classified preprint' || shape === 'mismatched preprint year') {
    const year = shape === 'classified preprint' ? 2024 : 2025
    line(last, `[5] E. Writer, A preprint describing the last study (${year}),`, 320, 730)
    line(last, 'arXiv:2401.00000 [cs.EX].', 339, 719)
  } else {
    line(last, '[5] E. Writer, The last study,', 320, 730)
    line(last, 'Journal of Examples 15 (2024).', 339, 719)
  }
  const loading = getDocument({
    data: await pdf.save(),
    fontExtraProperties: true,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    standardFontDataUrl: assets
  })
  try {
    const result = await extractPdfTranslationSource({
      document: await loading.promise,
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    const units = result.source.units
    const bibliography = units.filter((unit) =>
      /\[\d\]|Journal of Examples|arXiv:/u.test(unit.source)
    )
    expect(bibliography).toHaveLength(10)
    expect(bibliography.filter((unit) => unit.preserve === 'reference')).toHaveLength(
      shape === 'unmarked address' || shape === 'mismatched preprint year' ? 0 : 10
    )
    expect(
      units
        .filter((unit) => /The final paragraph|author@example.org/u.test(unit.source))
        .every((unit) => !unit.sourceOnly && !unit.preserve)
    ).toBe(true)
  } finally {
    await loading.destroy()
  }
})

it.each(['continuous', 'number gap'])(
  'recognizes a closed pair of reference columns below prose: %s',
  async (shape) => {
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const page = pdf.addPage([600, 800])
    const line = (text: string, x: number, y: number, size = 9): void =>
      page.drawText(text, { font, size, x, y })

    line('The final paragraph reports the measured changes.', 50, 280, 10)
    line('The other paragraph explains the reported values.', 315, 280, 10)
    for (const [column, x] of [50, 315].entries()) {
      for (let row = 0; row < 3; row++) {
        const number = column * 3 + row + 1
        const marker = shape === 'number gap' && number === 4 ? 8 : number
        const y = 210 - row * 21
        line(`[${marker}] A. Writer, Field Records ${number},`, x, y)
        line(
          number === 2 ? 'Press (2004) ISBN 1234567890.' : 'Volume 12, 23, 2006.',
          x + 14,
          y - 10.5
        )
      }
    }
    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl: assets
    })
    try {
      const { source } = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      })
      const records = source.units.filter((unit) =>
        /Field Records|ISBN|Volume 12/u.test(unit.source)
      )
      expect(records.flatMap((unit) => unit.fragments.flatMap((f) => f.items))).toHaveLength(12)
      expect(records.filter((unit) => unit.preserve === 'reference')).toHaveLength(
        shape === 'continuous' ? records.length : 0
      )
      const prose = source.units
        .filter((unit) => !unit.sourceOnly)
        .map((unit) => unit.source)
        .join(' ')
      expect(prose).toContain('The final paragraph reports')
      expect(prose).toContain('The other paragraph explains')
    } finally {
      await loading.destroy()
    }
  }
)

it.each(['column wrap', 'low continuation', 'single right lane', 'unmarked right lane'])(
  'keeps reference records with a proven terminal flow after an author address: %s',
  async (placement) => {
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const page = pdf.addPage([600, 800])
    const line = (text: string, x: number, y: number, size = 9): void =>
      page.drawText(text, { font, size, x, y })
    const rightLane = placement.endsWith('right lane'),
      rail = rightLane ? 320 : 50
    line('The final paragraph describes the observations.', rail, 330, 11)
    line(placement === 'unmarked right lane' ? 'x' : '*', rail + 8, 220, 6)
    line('Electronic address: author@example.org', rail + 17, 216)
    line('[1] A. Writer, A study of regular shapes,', rail, 205)
    const top = rightLane ? 194.5 : placement === 'column wrap' ? 730 : 645
    line(rightLane ? '(Field Press, 2006), 2nd ed.' : 'Field Records 12 (2006).', 334, top)
    let y = top - (rightLane ? 10.5 : 21)
    for (let number = 2; number <= 5; number++) {
      if (rightLane && number === 2) {
        line('[2] B. Writer et al., math-xy/0099999.', 320, y)
        y -= 10.5
      } else {
        line(`[${number}] C. Writer, Observations of related shapes,`, 320, y)
        line('Field Records 13 (2007).', 334, y - 10.5)
        y -= 21
      }
    }

    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl: assets
    })
    try {
      const { source } = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      })
      const references = source.units.filter((unit) => unit.preserve === 'reference')
      expect(references.flatMap((unit) => unit.fragments.flatMap((f) => f.items))).toHaveLength(
        placement === 'column wrap' ? 10 : placement === 'single right lane' ? 9 : 0
      )
      const address = source.units.find((unit) => /author@example.org/u.test(unit.source))
      expect(address).toBeDefined()
      expect(address?.preserve).toBeUndefined()
    } finally {
      await loading.destroy()
    }
  }
)

it.each(['closed', 'missing locator'])(
  'protects a terminal bibliography that turns columns below closed prose (%s)',
  async (shape) => {
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const regular = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const italic = await pdf.embedFont(await readFile(assets + 'LiberationSans-Italic.ttf'))
    pdf
      .addPage([612, 792])
      .drawText('An independent earlier page.', { x: 54, y: 680, size: 10, font: regular })
    const last = pdf.addPage([612, 792])
    last.drawText('Measured values describe three independent controls.', {
      x: 54,
      y: 606,
      size: 10,
      font: regular
    })
    last.drawText('A review of the same measurements is provided here.', {
      x: 315,
      y: 585,
      size: 10,
      font: regular
    })
    last.drawText('The measurements were repeated.', { x: 315, y: 572, size: 10, font: regular })
    const normal = last.node.newFontDictionary(regular.name, regular.ref)
    const slanted = last.node.newFontDictionary(italic.name, italic.ref)
    const row = (text: string, x: number, y: number, venue = false): void => {
      last.pushOperators(
        setTextMatrix(1, 0, 0, 1, x, y),
        setFontAndSize(venue ? slanted : normal, 9),
        showText((venue ? italic : regular).encodeText(text))
      )
      if (venue)
        last.pushOperators(
          setFontAndSize(normal, 9),
          showText(
            regular.encodeText(
              shape === 'missing locator' && y === 434 ? ', 2023.' : ', pages 32–41, 2023.'
            )
          )
        )
      last.pushOperators(PDFOperator.of(PDFOperatorNames.NextLine))
    }
    last.pushOperators(
      beginText(),
      setFontAndSize(normal, 9),
      PDFOperator.of(PDFOperatorNames.SetTextLineHeight, [pdf.context.obj(10.5)])
    )
    for (let n = 0; n < 4; n++) {
      row(`[${n + 1}] A. Writer. The original experiment and its controls.`, 54, 518 - n * 21)
      if (n < 3) row('Proceedings of the Annual Workshop', 68.5, 507.5 - n * 21, true)
    }
    row('Proceedings of the Research Seminar', 329.5, 518, true)
    for (let n = 0; n < 4; n++) {
      row(`[${n + 5}] B. Editor. A follow-up study under similar conditions.`, 315, 507.5 - n * 21)
      row('Proceedings of the Spring Conference', 329.5, 497 - n * 21, true)
    }
    last.pushOperators(endText())
    last.drawText('2', {
      x: (612 - regular.widthOfTextAtSize('2', 10)) / 2,
      y: 42,
      size: 10,
      font: regular
    })
    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: assets
    })
    try {
      const { source } = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      })
      const refs = source.units.filter((u) => /^\[\d+\]|Proceedings of the/u.test(u.source))
      expect(refs.filter((u) => /^\[\d+\]/u.test(u.source))).toHaveLength(8)
      expect(
        refs.find((u) => u.source.startsWith('Proceedings of the Research Seminar'))
      ).toBeDefined()
      expect(refs.filter((u) => u.preserve === 'reference')).toHaveLength(
        shape === 'closed' ? refs.length : 0
      )
      expect(
        source.units.find((u) => u.source.includes('measurements were repeated'))?.sourceOnly
      ).toBeUndefined()
    } finally {
      await loading.destroy()
    }
  }
)

it.each(['acknowledgment', 'ordinary preamble', 'unclosed record'])(
  'requires an acknowledgment and closed records for a high terminal bibliography: %s',
  async (shape) => {
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const first = pdf.addPage([600, 800])
    first.drawText('Independent prose precedes the final page.', {
      font,
      size: 11,
      x: 45,
      y: 720
    })
    const final = pdf.addPage([600, 800])
    const line = (source: string, x: number, y: number, size = 9): void => {
      final.drawText(source, { font, size, x, y })
    }
    line('2', 560, 762, 10)
    line('The institute provided essential equipment.', 45, 732, 10)
    line(
      shape === 'ordinary preamble'
        ? 'This sentence describes an ordinary sequence.'
        : 'This work was supported by an academic grant.',
      320,
      732,
      10
    )
    const authors = [
      'Writer, A.',
      'B. de Winter',
      'C.-D. Writer',
      'D. Author',
      'Editor, E.',
      'F. Author'
    ]
    for (const [index, author] of authors.entries()) {
      const x = index < 3 ? 50 : 320,
        y = 676 - (index % 3) * 22
      line(`[${index + 1}] ${author}, An independent study,`, x - (index % 3 === 1 ? 0.01 : 0), y)
      line(
        shape === 'unclosed record' && index === 5
          ? 'Journal of Examples 16 (2025), continued'
          : `Journal of Examples ${index + 11} (202${index}).`,
        x + 18,
        y - 11
      )
    }
    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl: assets
    })
    try {
      const result = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      })
      const units = result.source.units
      expect(result.coverage.excludedItemCount).toBe(0)
      const references = units.filter((unit) => unit.preserve === 'reference')
      expect(references.flatMap((unit) => unit.fragments.flatMap((f) => f.items))).toHaveLength(
        shape === 'acknowledgment' ? 12 : 0
      )
      expect(references.every((unit) => unit.sourceOnly)).toBe(true)
      expect(
        units.some((unit) => unit.source.includes('essential equipment') && !unit.sourceOnly)
      ).toBe(true)
    } finally {
      await loading.destroy()
    }
  }
)

it.each(['closed', 'ordinary previous heading', 'incomplete last record'])(
  'protects a separate terminal bibliography only with complete page evidence: %s',
  async (shape) => {
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const previous = pdf.addPage([600, 800]),
      final = pdf.addPage([600, 800])
    const print = (page: typeof final, text: string, x: number, y: number, size = 9): void =>
      page.drawText(text, { font, size, x, y })
    print(
      previous,
      shape === 'ordinary previous heading' ? 'Discussion' : 'Acknowledgments',
      70,
      140
    )
    print(previous, 'The institute provided essential equipment.', 54, 117, 10)
    print(final, '2', 549, 766, 10)
    for (let n = 0; n < 8; n++) {
      const x = n < 4 ? 57 : 322,
        y = 706 - (n % 4) * 22,
        author = n ? 'Olivia Reader' : 'O. Reader'
      print(final, `[${n + 1}] ${author}, A complete independent study,`, x, y)
      print(
        final,
        shape === 'incomplete last record' && n === 7
          ? 'Journal of Examples, continued'
          : `Journal of Examples ${n + 21}, ${n + 30} (2019).`,
        x + 18,
        y - 11
      )
    }
    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl: assets
    })
    try {
      const result = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      })
      const units = result.source.units
      const referenceItems = units
        .filter((unit) => unit.sourceOnly && unit.preserve === 'reference')
        .flatMap((unit) => unit.fragments.flatMap((fragment) => fragment.items))
      expect(referenceItems).toHaveLength(shape === 'closed' ? 16 : 0)
      expect(
        units.some((unit) => unit.source.includes('essential equipment') && !unit.sourceOnly)
      ).toBe(true)
    } finally {
      await loading.destroy()
    }
  }
)

it.each([
  'closed',
  'different heading',
  'skipped ordinal',
  'unpunctuated locator',
  'unstyled locator',
  'locator without page'
])('keeps terminal bracketed records after acknowledgments across pages: %s', (shape) => {
  const line = (
    str: string,
    x: number,
    y: number,
    width: number,
    height = 9,
    fontName = 'reference'
  ): PdfLayoutTextItem => ({
    str,
    width,
    height,
    dir: 'ltr',
    transform: [height, 0, 0, height, x, y],
    fontName,
    fontAscent: 0.8,
    fontDescent: -0.2,
    fontVertical: false,
    hasEOL: true
  })
  const entries = (numbers: number[], x: number, y: number): PdfLayoutTextItem[] =>
    numbers.flatMap((number, i) => [
      line(
        `[${shape === 'skipped ordinal' && number === 8 ? 80 : number}] A. Reader, A study of alternating test procedures,`,
        x,
        y - 22 * i,
        219
      ),
      line(
        number === 1
          ? 'Example Journal 12.'
          : 'Journal of Examples 12, 77 (2025), arXiv:0000.00000.',
        x + 18,
        y - 22 * i - 11,
        199,
        9,
        number === 1 ? 'volume' : 'reference'
      )
    ])
  const body = (str: string, x: number, y: number, width: number): PdfLayoutTextItem =>
    line(str, x, y, width, 10, 'body')
  const right = entries([4, 5, 6], 317, 134)
  if (shape.endsWith('locator') || shape === 'locator without page') {
    const tail = right[3]
    const y = tail.transform[5]
    right.splice(
      3,
      1,
      { ...tail, str: 'Journal of Examples', width: 119, hasEOL: false },
      {
        ...line('12', 458, y, 9, 9, shape === 'unstyled locator' ? 'reference' : 'volume'),
        hasEOL: false
      },
      line(shape === 'locator without page' ? ', (2025)' : ', 77 (2025)', 469, y, 57)
    )
  }
  const pages = [
    Array.from({ length: 28 }, (_, index) =>
      body(
        'The field report places the measurements in their original context.',
        index < 14 ? 54 : 317,
        730 - 12 * (index % 14),
        220
      )
    ),
    [
      body('2', 557, 756, 5),
      line(
        shape === 'different heading' ? 'SUPPLEMENTARY NOTES' : 'ACKNOWLEDGMENTS',
        385,
        631,
        106,
        9,
        'heading'
      ),
      body('We thank the colleagues who supplied measurements and helped plan', 327, 604, 231),
      body(
        'the field visits and the subsequent review of the experimental material.',
        317,
        592,
        241
      ),
      body('Their comments and recordings improved the interpretation of the data.', 317, 580, 202),
      ...entries([1, 2, 3], 54, 535),
      ...right
    ],
    [body('3', 557, 756, 5), ...entries([7, 8, 9], 54, 730), ...entries([10, 11, 12], 317, 701)]
  ].map((items, index) => ({ page: index + 1, width: 612, height: 792, rotation: 0, items }))
  const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
  const refs = units.filter((unit) =>
    /^(?:\[\d+\] A\. Reader|(?:Example Journal|Journal of Examples) )/u.test(unit.source)
  )
  expect(refs).toHaveLength(24)
  expect(refs.filter((unit) => unit.sourceOnly)).toHaveLength(
    shape === 'closed' || shape === 'unpunctuated locator' ? 24 : 0
  )
  expect(units.find((unit) => unit.source.startsWith('We thank'))?.sourceOnly).toBeUndefined()
  const keys = units.flatMap((unit) => unit.items)
  expect(keys).toHaveLength(new Set(keys).size)
  expect(keys).toHaveLength(pages.reduce((count, p) => count + p.items.length, 0))
})

it.each(['closed', 'number gap', 'ordinary note'])(
  'preserves a terminal two-column bibliography after a correspondence block (%s)',
  async (mode) => {
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const normal = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const volume = await pdf.embedFont(await readFile(assets + 'LiberationSans-Bold.ttf'))
    const page = pdf.addPage([600, 800])
    const prose = 'The final measurements support the reported conclusion.'
    page.drawText(prose, { font: normal, size: 10, x: 320, y: 449 })
    page.drawText(mode === 'ordinary note' ? 'Notes for readers:' : 'Correspondence to:', {
      font: normal,
      size: 10,
      x: 330,
      y: 431
    })
    page.drawText('Avery Lane at editor@example.org', { font: normal, size: 10, x: 320, y: 420 })

    for (let index = 0; index < 8; index++) {
      const left = index < 4 ? 54 : 320
      const bottom = 370 - (index % 4) * 22
      const ordinal = mode === 'number gap' && index === 5 ? 9 : index + 1
      const lead = index === 0 ? 'A. van Reader' : 'B. Writer'
      page.drawText(`[${ordinal}] ${lead}, A complete study of sample records,`, {
        font: normal,
        size: 9,
        x: left,
        y: bottom
      })
      const name = 'Journal of Example Results,'
      const x = left + 16
      page.drawText(name, { font: normal, size: 9, x, y: bottom - 11 })
      const next = x + normal.widthOfTextAtSize(name, 9) + 3
      page.drawText('8', { font: volume, size: 9, x: next, y: bottom - 11 })
      page.drawText(', 44 (2020).', {
        font: normal,
        size: 9,
        x: next + volume.widthOfTextAtSize('8', 9),
        y: bottom - 11
      })
    }

    const open = (data: Uint8Array): ReturnType<typeof getDocument> =>
      getDocument({
        data,
        fontExtraProperties: true,
        disableFontFace: true,
        standardFontDataUrl: assets
      })
    const loading = open(await pdf.save())
    try {
      const result = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'synthetic',
        nativeDocumentFactory: ({ data }) => open(data),
        signal: new AbortController().signal
      })
      const entries = result.source.units.filter(({ source }) => /^\[\d+\] /u.test(source))
      expect(entries).toHaveLength(8)
      expect(entries.filter(({ sourceOnly }) => sourceOnly)).toHaveLength(mode === 'closed' ? 8 : 0)
      const tails = result.source.units.filter(({ source }) =>
        source.includes('Journal of Example')
      )
      expect(tails).toHaveLength(8)
      expect(tails.filter(({ sourceOnly }) => sourceOnly)).toHaveLength(mode === 'closed' ? 8 : 0)
      expect(
        result.source.units.find(({ source }) => source.includes(prose))?.sourceOnly
      ).toBeUndefined()
    } finally {
      await loading.destroy()
    }
  }
)

it.each(['heading', 'prose', 'ordinary', 'bare without acknowledgment', 'compound', 'note gap'])(
  'protects complete final right-column references after acknowledgments (%s)',
  async (context) => {
    const hasNote = context === 'compound' || context === 'note gap',
      acknowledged = context === 'heading' || context === 'prose' || context === 'compound',
      bareInitial = context === 'prose' || context === 'bare without acknowledgment',
      prose = context === 'prose' || hasNote,
      offset = hasNote ? 70 : 0
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const page = pdf.addPage([480, 600])
    const line = (source: string, x: number, y: number, size: number): void => {
      page.drawText(source, { font, size, x, y })
    }
    line('Independent prose remains in the other column.', 42, 245, 10)
    line(
      context === 'heading'
        ? 'Acknowledgments.'
        : prose
          ? 'The authors thank our colleagues,'
          : 'Closing remarks.',
      257,
      389 + offset,
      10
    )
    line(
      prose ? 'and the laboratory supported this work.' : 'The laboratory supported this work.',
      251,
      377 + offset,
      10
    )
    for (let i = 0; i < 6; i++) {
      const y = 322 + offset - i * 21
      line(
        hasNote && i === 2
          ? '[3] C. Reader. Alloy Studies 9, 75 (2020).'
          : `[${i + 1}] ${bareInitial && i < 2 ? 'A' : 'A.'} Writer, An independent study,`,
        255,
        y,
        9
      )
      line(
        i === 2
          ? hasNote
            ? 'D. Sample. Foundry Notes 3, 98 (2021).'
            : '[archive-example/9999999].'
          : 'Journal of Examples 12, 37 (2020).',
        270,
        y - 10.5,
        9
      )
    }
    if (hasNote) {
      line(
        `[${context === 'note gap' ? 8 : 7}] This independent technical estimate uses the`,
        255,
        266,
        9
      )
      line('adjacent surface area in its result.', 270, 255.5, 9)
    }
    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl: assets
    })
    try {
      const { source } = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      })
      const units = source.units
      expect(units.flatMap((unit) => unit.fragments.flatMap((f) => f.items))).toHaveLength(
        hasNote ? 17 : 15
      )
      expect(
        units
          .filter((unit) => unit.preserve === 'reference')
          .flatMap((unit) => unit.fragments.flatMap((f) => f.items))
      ).toHaveLength(acknowledged ? 12 : 0)
      expect(
        units.some((unit) => unit.source.includes('supported this work') && !unit.sourceOnly)
      ).toBe(true)
      if (hasNote) {
        expect(
          units.some((unit) => unit.source.includes('technical estimate uses') && !unit.sourceOnly)
        ).toBe(true)
        expect(
          units.some(
            (unit) => unit.source.includes('surface area in its result') && !unit.sourceOnly
          )
        ).toBe(true)
      }
    } finally {
      await loading.destroy()
    }
  }
)

it.each([false, true])(
  'preserves numbered references above a separate translation credit (%s)',
  (shifted) => {
    const item = (str: string, x: number, y: number, width: number): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height: 10,
      hasEOL: false,
      fontName: 'Journal',
      transform: [10, 0, 0, 10, x, y],
      fontAscent: 0.75,
      fontDescent: -0.25,
      fontVertical: false
    })
    const items = [item('The independent explanatory note ends here.', 80, 306, 236)]
    let baseline = 276
    for (let n = 1; n <= 6; n++) {
      if (n === 3) {
        items.push(item('3A. Reader, Notes from the Archive of Examples,', 90, baseline, 403))
        baseline -= 12
        items.push(item('volume three, pp. 12-15.', 100, baseline, 150))
      } else {
        items.push(item(String(n), 90, baseline + 3, 5))
        items.push(item('A. Reader, Journal of Examples 18, 26 (1992).', 95, baseline, 267))
      }
      baseline -= 12
    }
    items.push(
      item(
        'Translated by A. Smith (1994), revised by B. Jones (2024).',
        shifted ? 115 : 100,
        baseline - 12,
        282
      )
    )
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }],
      pageCount: 1
    })
    const references = units.filter((unit) => unit.source.includes('Journal of Examples'))
    expect(references.length).toBeGreaterThan(0)
    expect(references.every((unit) => unit.preserve === 'reference')).toBe(!shifted)
    const note = units.find((unit) => unit.source === items[0].str)
    const credit = units.find((unit) => unit.source === items.at(-1)?.str)
    expect(note?.items).toEqual(['1:0'])
    expect(credit?.items).toEqual([`1:${items.length - 1}`])
    expect(note?.sourceOnly).toBeUndefined()
    expect(credit?.sourceOnly).toBeUndefined()
  }
)

it.each(['complete', 'renumbered'])(
  'retains a terminal bibliography below paired author notes only with complete numbering (%s)',
  async (shape) => {
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const first = pdf.addPage([600, 800])
    const last = pdf.addPage([600, 800])
    first.drawText('The ordinary conclusion remains eligible.', {
      x: 56,
      y: 480,
      size: 12,
      font
    })
    first.drawText('*', { x: 323, y: 746, size: 6, font })
    first.drawText('These authors contributed equally to this work.', {
      x: 335,
      y: 742,
      size: 9,
      font
    })
    first.drawText('†', { x: 323, y: 735, size: 6, font })
    first.drawText('reader@example.org', { x: 335, y: 731, size: 9, font })
    const records = (page: typeof first, x: number, y: number, numbers: number[]): void => {
      for (const number of numbers) {
        page.drawText(`[${number}] A. Example, A study of rivers,`, { x, y, size: 9, font })
        page.drawText('Review of Geography 7 (2024).', { x: x + 18, y: y - 11, size: 9, font })
        y -= 22
      }
    }
    records(first, 317, 720, [1, 2])
    records(last, 54, 738, [3, shape === 'complete' ? 4 : 7])
    records(last, 317, 738, [5, 6])
    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl: assets
    })
    const document = await loading.promise
    try {
      const { source } = await extractPdfTranslationSource({
        document,
        resourceRequestKey: 'sample-author-notes',
        signal: new AbortController().signal
      })
      const conclusion = source.units.find((unit) => unit.source.includes('ordinary conclusion'))
      expect(conclusion?.sourceOnly).toBeUndefined()
      const firstRecord = source.units.find((unit) => unit.source.startsWith('[1] A. Example'))
      expect(firstRecord?.sourceOnly).toBe(shape === 'complete' ? true : undefined)
    } finally {
      await loading.destroy()
    }
  }
)

it.each([true, false])(
  'keeps a complete bibliography with a carried publication suffix original-only (%s)',
  async (complete) => {
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const page = pdf.addPage([600, 800])
    page.drawText('1', { font, x: 551, y: 756, size: 11 })
    const key = page.node.newFontDictionary(font.name, font.ref)
    page.pushOperators(
      pushGraphicsState(),
      PDFOperator.of(PDFOperatorNames.SetLineWidth, [pdf.context.obj(0.8)]),
      PDFOperator.of(PDFOperatorNames.MoveTo, [pdf.context.obj(185), pdf.context.obj(730)]),
      PDFOperator.of(PDFOperatorNames.LineTo, [pdf.context.obj(415), pdf.context.obj(730)]),
      PDFOperator.of(PDFOperatorNames.StrokePath),
      popGraphicsState(),
      beginText(),
      setFontAndSize(key, 9)
    )
    const row = (text: string, x: number, y: number): void => {
      page.pushOperators(setTextMatrix(1, 0, 0, 1, x, y), showText(font.encodeText(text)))
    }
    for (const [x, start, offset] of [
      [54, 1, 0],
      [317, 5, 1]
    ]) {
      if (offset) row('12(4):145–151, 2020.', x + 18, 700)
      for (let n = 0; n < 4; n++) {
        const ordinal = !complete && start === 5 && n === 1 ? 12 : start + n,
          y = 700 - (n * 2 + offset) * 10.5
        row(`[${ordinal}] A. Reader. Notes on measuring samples,`, x, y)
        row(
          ordinal === 4
            ? 'Journal of Sample Records,'
            : 'Journal of Sample Records, 8(2):22–27, 2021.',
          x + 18,
          y - 10.5
        )
      }
    }
    page.pushOperators(endText())
    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      disableFontFace: true,
      standardFontDataUrl: assets
    })
    try {
      const { source } = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      })
      const records = source.units.filter((unit) => unit.source.includes('A. Reader'))
      expect(records).toHaveLength(8)
      expect(records.filter((unit) => unit.preserve === 'reference')).toHaveLength(complete ? 8 : 0)
      expect(records.every((unit) => !!unit.sourceOnly === complete)).toBe(true)
    } finally {
      await loading.destroy()
    }
  }
)

it.each([false, true])(
  'retains a two-column bibliography ending before acknowledgments (numbering gap=%s)',
  async (gap) => {
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const regular = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const bold = await pdf.embedFont(await readFile(assets + 'LiberationSans-Bold.ttf'))
    const page = pdf.addPage([600, 800])
    const line = (text: string, x: number, y: number, size = 9, font = regular): void =>
      page.drawText(text, { font, size, x, y })

    line('1', 554, 757, 10)
    line('The results from the experiment are shown below.', 50, 714, 10)
    line('The final paragraph explains the measurement conditions.', 320, 714, 10)
    page.pushOperators(
      beginText(),
      setFontAndSize(page.node.newFontDictionary(regular.name, regular.ref), 9),
      PDFOperator.of(PDFOperatorNames.SetTextLineHeight, [pdf.context.obj(11)])
    )
    const reference = (text: string, x: number, y: number): void => {
      page.pushOperators(
        setTextMatrix(1, 0, 0, 1, x, y),
        showText(regular.encodeText(text)),
        PDFOperator.of(PDFOperatorNames.NextLine)
      )
    }
    for (const i of [0, 1, 2]) {
      reference(`[${i + 1}] A. B. Reader, Independent measurement ${i + 1}.`, 50, 560 - i * 22)
      reference(`Journal of Examples ${i + 2} (2021).`, 67, 549 - i * 22)
    }
    reference('[4] Writer, B. A study of repeated measure-', 50, 494)
    reference('ments. Journal of Examples 5 (2022).', 337, 560)
    for (const i of [0, 1, 2, 3]) {
      const number = i + 5 + Number(gap && i > 1)
      reference(`[${number}] Editor, C. Experimental confirmation ${i + 1}.`, 320, 549 - i * 22)
      reference(`Journal of Examples ${i + 6} (2023).`, 337, 538 - i * 22)
    }
    page.pushOperators(endText())
    line('Acknowledgments', 325, 452, 11, bold)
    line('We appreciate the facility staff.', 433, 452, 11)
    line('The equipment was supported by local funds.', 320, 440, 11)

    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl: assets
    })
    try {
      const { source } = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      })
      const references = source.units.filter((u) => /Journal of Examples|^\[\d+\]/u.test(u.source))
      expect(references).toHaveLength(16)
      expect(references.filter((u) => u.preserve === 'reference')).toHaveLength(gap ? 0 : 16)
      expect(source.units.find((u) => u.source.startsWith('Acknowledgments'))).toMatchObject({
        source: expect.stringContaining('We appreciate')
      })
      expect(
        source.units.find((u) => u.source.startsWith('Acknowledgments'))?.sourceOnly
      ).toBeUndefined()
    } finally {
      await loading.destroy()
    }
  }
)

it.each([
  ['contact', false],
  ['contact', true],
  ['availability', false],
  ['availability', true],
  ['two contacts', false],
  ['two contacts', true],
  ['wrapped contacts', false],
  ['wrapped contacts', true],
  ['separate pages', false],
  ['separate pages', true],
  ['centered divider', false],
  ['centered divider', true]
] as const)(
  'retains a continuous terminal bibliography while keeping its numbered explanatory note (%s, invalid evidence=%s)',
  async (boundary, gap) => {
    const availability = boundary === 'availability'
    const wrapped = boundary === 'wrapped contacts'
    const pairedContacts = boundary === 'two contacts' || wrapped
    const divided = boundary === 'centered divider'
    const separate = boundary === 'separate pages'
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const bold = await pdf.embedFont(await readFile(assets + 'LiberationSans-Bold.ttf'))
    const page = (number: number, rows: [string, number, number, number?, boolean?][]): PDFPage => {
      const p = pdf.addPage([600, 800])
      if (!separate) p.drawText(String(number), { x: 554, y: 755, size: 10, font })
      p.pushOperators(
        beginText(),
        PDFOperator.of(PDFOperatorNames.SetTextLineHeight, [pdf.context.obj(10.35)])
      )
      for (const [text, x, y, size = 9, heading = false] of rows) {
        const face = heading ? bold : font
        p.pushOperators(
          setFontAndSize(p.node.newFontDictionary(face.name, face.ref), size),
          setTextMatrix(1, 0, 0, 1, x, y),
          showText(face.encodeText(text)),
          PDFOperator.of(PDFOperatorNames.NextLine)
        )
      }
      p.pushOperators(endText())
      if (separate) {
        const folio = String(number)
        p.drawText(folio, {
          x: (600 - font.widthOfTextAtSize(folio, 10)) / 2,
          y: 43,
          size: 10,
          font
        })
      }
      return p
    }
    const record = (n: number, x: number, y: number): [string, number, number] => [
      `[${n}] R. Reader, Workshop Papers ${n}, 21 (2021).`,
      x,
      y
    ]
    if (separate) {
      page(1, [
        ['IV.', 385, 125, 9, true],
        [gap ? 'OBSERVATIONS' : 'ACKNOWLEDGMENTS', 401, 125, 9, true],
        ['The authors appreciate the instruments and facilities', 331, 99, 10],
        ['provided by the measurement team.', 321, 87.5, 10]
      ])
      page(2, [
        record(1, 54, 720),
        record(2, 54, 709.65),
        record(3, 329, 720),
        record(4, 329, 709.65)
      ])
      page(3, [
        record(5, 54, 720),
        ['[6] We applied the same calibration to the remaining experiments.', 54, 709.65],
        record(7, 329, 720),
        record(8, 329, 709.65)
      ])
    } else if (divided) {
      const citation = (n: number, x: number, y: number): [string, number, number] => [
        `[${n}] Rosa Reader, “Sample Study,” Workshop Papers (2021).`,
        x,
        y
      ]
      const first = page(1, [
        ['Unrelated readings appear at the top of this page.', 54, 670, 10],
        ['They were tested against independent estimates.', 54, 658, 10],
        ['We appreciate the facilities used for measurement.', 54, 430, 10],
        ['Support was provided by the analysis team.', 320, 430, 10],
        citation(1, 58.5, 345),
        citation(2, 58.5, 334.65),
        ['[3] Rosa Reader, “Measurements in a', 58.5, 324.3],
        ['sample chamber,” in the open', 72, 313.95],
        ['study archive (2021).', 338, 345],
        citation(4, 324.5, 334.65),
        citation(5, 324.5, 324.3)
      ])
      const rule = (left: number, right: number, y: number): void =>
        first.pushOperators(setLineWidth(0.4), moveTo(left, y), lineTo(right, y), stroke())
      rule(54, 550, 680)
      if (!gap) {
        rule(185, 300, 375)
        rule(300, 415, 375)
      }
      page(2, [
        citation(6, 54, 730),
        ['[7] We repeated the same calibration.', 54, 719.65],
        citation(8, 320, 730),
        citation(9, 320, 719.65)
      ])
    } else if (pairedContacts) {
      const markerRight = 339
      const offset = wrapped ? 432 : 0
      page(1, [
        ['The measurements agree with the earlier estimates.', 322, 205 + offset, 10],
        ['*', markerRight - font.widthOfTextAtSize('*', 6), 154 + offset, 6],
        ['reader@example.test', 343, 150 + offset],
        ['†', markerRight - font.widthOfTextAtSize('†', 6), 143.65 + offset, 6],
        ['writer@example.test', 343, 139.65 + offset],
        record(1, 329, 129.3 + offset),
        record(2, 329, 118.95 + offset),
        wrapped
          ? [`[3] R. Reader, Signals and ${gap ? 'Methods' : 'Mea-'}`, 329, 78]
          : record(3, 329, 108.6)
      ])
      page(2, [
        ...(wrapped ? [['surements 11, 24 (2021).', 72, 730] as [string, number, number]] : []),
        record(4, 54, wrapped ? 719.65 : 730),
        [
          '[5] We applied the same calibration to the remaining experiments.',
          54,
          wrapped ? 709.3 : 719.65
        ],
        record(6, 329, 730),
        record(gap && !wrapped ? 8 : 7, 329, 719.65),
        record(gap && !wrapped ? 9 : 8, 329, 709.3)
      ])
    } else if (availability) {
      page(1, [
        ['We repeated the measurements under uniform conditions.', 320, 440, 10],
        ['Data availability', 321, 390, 9, true],
        ['See the complete archive online', 329, 379.65],
        ['at https://doi.org/10.0000/example.', 320, 369.3],
        record(1, 329, 349.5),
        record(2, 329, 328.8),
        record(3, 329, 308.1)
      ])
      page(2, [
        record(4, 54, 730),
        ['[5] We applied the same calibration to the remaining experiments.', 54, 709.3],
        record(6, 329, 730),
        [
          `[${gap ? 8 : 7}] Id., in Collected Observations, p. 82 (Sample Press, 2022).`,
          329,
          709.3
        ],
        record(gap ? 9 : 8, 329, 688.6)
      ])
    } else {
      page(1, [
        ['The subsequent measurements confirm the estimates.', 320, 230, 10],
        ['Acknowledgments', 320, 205, 10],
        ['We appreciate the facility staff.', 320, 190, 10],
        ['*', 329, 154, 7],
        ['example-one@example.com', 337, 150],
        ['†', 329, 143.65, 7],
        ['example-two@example.com', 337, 139.65],
        record(1, 320, 129.3),
        record(2, 320, 118.95)
      ])
      page(2, [
        record(3, 54, 730),
        ['[4] We applied the same calibration to the remaining experiments.', 54, 719.65],
        record(5, 320, 730),
        record(6, 320, 699)
      ])
      page(3, [record(gap ? 8 : 7, 54, 730), record(gap ? 9 : 8, 54, 719.65)])
    }
    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl: assets
    })
    try {
      const { source } = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      })
      const references = source.units.filter((unit) =>
        divided
          ? /Rosa Reader|sample chamber|study archive/u.test(unit.source)
          : unit.source.includes('R. Reader')
      )
      if (divided) {
        expect(references.length).toBeGreaterThanOrEqual(8)
        expect(references.filter((unit) => unit.preserve === 'reference')).toHaveLength(
          gap ? 0 : references.length
        )
        expect(source.units.find((unit) => unit.source.includes('same calibration'))).toMatchObject(
          {
            source: expect.stringContaining('repeated the same calibration')
          }
        )
        expect(
          source.units.find((unit) => unit.source.includes('same calibration'))?.sourceOnly
        ).toBeUndefined()
        return
      }
      if (wrapped) {
        expect(source.units.find((unit) => unit.source.includes('surements 11'))?.preserve).toBe(
          gap ? undefined : 'reference'
        )
      }
      expect(references).toHaveLength(availability ? 6 : 7)
      expect(references.filter((unit) => unit.preserve === 'reference')).toHaveLength(
        gap ? 0 : availability ? 6 : 7
      )
      if (availability)
        expect(
          source.units.find((unit) => unit.source.includes('Collected Observations'))?.preserve
        ).toBe(gap ? undefined : 'reference')
      expect(
        source.units.find((unit) => unit.source.includes('same calibration'))?.sourceOnly
      ).toBeUndefined()
    } finally {
      await loading.destroy()
    }
  }
)

it.each(['closed', 'numbering gap', 'different heading'])(
  'retains both columns of a closed bibliography below acknowledgments (%s)',
  async (shape) => {
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const regular = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const bold = await pdf.embedFont(await readFile(assets + 'LiberationSans-Bold.ttf'))
    const page = pdf.addPage([600, 800])
    page.drawText('The measurements agree within the uncertainty.', {
      x: 320,
      y: 390,
      size: 10,
      font: regular
    })
    const heading = shape === 'different heading' ? 'Examples' : 'Acknowledgement'
    page.drawText(heading, { x: 398, y: 330, size: 9, font: bold })
    page.pushOperators(
      beginText(),
      setFontAndSize(page.node.newFontDictionary(regular.name, regular.ref), 9),
      PDFOperator.of(PDFOperatorNames.SetTextLineHeight, [pdf.context.obj(10.5)])
    )
    const reference = (text: string, x: number, y: number): void => {
      page.pushOperators(
        setTextMatrix(1, 0, 0, 1, x, y),
        showText(regular.encodeText(text)),
        PDFOperator.of(PDFOperatorNames.NextLine)
      )
    }
    for (const i of [0, 1, 2]) {
      reference(`[${i + 1}] A. Reader and B. Writer, Journal of Samples`, 55, 230 - 21 * i)
      reference(`${i + 11}, 42 (2022).`, 69, 219.5 - 21 * i)
    }
    reference('[4] C. Editor and D.', 55, 167)
    reference('Author, Journal of Examples', 335, 230)
    reference('15, 52 (2023).', 335, 219.5)
    for (const i of [0, 1, 2, 3]) {
      const ordinal = i + 5 + Number(shape === 'numbering gap' && i > 1)
      reference(
        `[${ordinal}] A. Reader and B. Writer, Journal of Samples 12, 42 (2024).`,
        317,
        209 - 10.5 * i
      )
    }
    page.pushOperators(endText())

    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: assets
    })
    try {
      const { source } = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      })
      const references = source.units.filter((unit) =>
        /^\[\d+\]|Journal of Examples/u.test(unit.source)
      )
      expect(references).toHaveLength(9)
      expect(references.filter((unit) => unit.preserve === 'reference')).toHaveLength(
        shape === 'closed' ? 9 : 0
      )
      expect(source.units.find((unit) => unit.source === heading)?.sourceOnly).toBeUndefined()
      expect(
        source.units.find((unit) => unit.source.startsWith('The measurements'))?.sourceOnly
      ).toBeUndefined()
    } finally {
      await loading.destroy()
    }
  }
)

it.each(['centered', 'shifted', 'incomplete'] as const)(
  'protects closed references below a repeated native divider (%s)',
  async (kind) => {
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const page = pdf.addPage([612, 792])
    const line = (text: string, x: number, y: number, size = 9): void =>
      page.drawText(text, { font, size, x, y })
    line('1', 557, 756, 10)
    line('This study received equipment support from the local institute.', 54, 713, 10)
    line('The authors are responsible for all remaining errors.', 317, 713, 10)
    for (const width of [244, 128]) {
      const center = kind === 'shifted' ? 324 : 306
      page.pushOperators(
        pushGraphicsState(),
        setLineWidth(width === 244 ? 0.4 : 0.7),
        moveTo(center - width / 2, 670),
        lineTo(center + width / 2, 670),
        stroke(),
        popGraphicsState()
      )
    }
    for (const [offset, x] of [58.5, 317].entries()) {
      const n = 1 + offset * 3
      line(`[${n}] A. Writer, Experiments in controlled measurement,`, x, 640)
      line(`Test Reports, 2019, pp. 1–8.`, x + 14, 629.5)
      line(`[${n + 1}] B. Reed, Lab Reports 4, 22 (2020).`, x, 619)
      line(
        kind === 'incomplete' && offset === 1
          ? '[6] C. Stone, See the other document for an explanation.'
          : `[${n + 2}] C. Stone, Records 8, 36 (2021).`,
        x,
        608.5
      )
    }
    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl: assets
    })
    try {
      const { source } = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      })
      expect(
        source.units
          .filter((unit) => unit.preserve === 'reference')
          .flatMap((unit) => unit.fragments.flatMap((fragment) => fragment.items))
      ).toHaveLength(kind === 'centered' ? 8 : 0)
      expect(
        source.units.find((unit) => unit.source.includes('equipment support'))?.sourceOnly
      ).toBeUndefined()
    } finally {
      await loading.destroy()
    }
  }
)

it.each([false, true])(
  'retains cited journal runs while leaving the numbered explanation eligible (ordinal gap=%s)',
  async (gap) => {
    const require = createRequire(import.meta.url),
      assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/',
      pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf')),
      first = pdf.addPage([600, 800]),
      last = pdf.addPage([600, 800]),
      x = 316,
      baseline = 360,
      pitch = 10.5,
      line = (text: string, x: number, y: number): void => {
        first.drawText(text, { font, x, y, size: 9 })
      }
    first.drawText('*', { font, x: x + 3, y: baseline + pitch + 3, size: 6 })
    line('Corresponding author: reader@example.org.', x + 15, baseline + pitch)
    line('[1] A. Reader, Journal of Samples 8, 31', x, baseline)
    line('(2020).', x + 15, baseline - pitch)
    const lead = '[2] B. Ro¨'
    line(lead, x, baseline - pitch * 2)
    line(
      'rer et al., Journal of Tests 9, 42 (2021).',
      x + font.widthOfTextAtSize(lead, 9) - 3,
      baseline - pitch * 2
    )
    for (let n = 3; n <= 6; n++)
      line(
        `[${gap && n === 4 ? 9 : n}] C. Writer, Sample Letters 10, ${n + 40} (2022).`,
        x,
        baseline - n * pitch
      )
    line('[7] A second independent method shows the result', x, baseline - pitch * 7)
    last.drawText('and demonstrates its implications for the example.', {
      font,
      x: 74,
      y: 730,
      size: 9
    })

    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      useSystemFonts: false,
      disableFontFace: true,
      standardFontDataUrl: assets
    })
    const document = await loading.promise
    try {
      const page = await document.getPage(1),
        content = await page.getTextContent(),
        diacritic = content.items.findIndex((item) => 'str' in item && item.str === lead),
        split = content.items[diacritic + 1]
      expect(diacritic).toBeGreaterThanOrEqual(0)
      expect(split).toMatchObject({ str: expect.stringMatching(/^rer et al\./u) })
      const result = await extractPdfTranslationSource({
        document,
        resourceRequestKey: 'synthetic-journal-run',
        signal: AbortSignal.timeout(10_000)
      })
      const units = result.source.units,
        citations = units.filter((unit) =>
          /Journal of Samples|Journal of Tests|Sample Letters/u.test(unit.source)
        ),
        explanation = units.find((unit) => /second independent method/u.test(unit.source))
      expect(citations).toHaveLength(6)
      expect(citations.filter((unit) => unit.preserve === 'reference')).toHaveLength(gap ? 0 : 6)
      expect(explanation).toBeDefined()
      expect(explanation?.sourceOnly).toBeUndefined()
    } finally {
      await loading.destroy()
    }
  }
)

it.each([false, true])(
  'retains a singular bibliography across the terminal folio (numbering gap=%s)',
  (gap) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Citation'
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height: 12,
      fontName,
      transform: [12, 0, 0, 12, x, y],
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false,
      hasEOL: true
    })
    const opening = [
      row('An unrelated observation concludes the discussion.', 85, 165, 260, 'Body'),
      row('REFERENCE', 255, 110, 90, 'Title'),
      row('1. A. West, Studies in field measurements', 95, 85, 400),
      row('(Sample Press, 1980).', 108, 68, 122),
      row('1', 297, 36, 6)
    ]
    const continued = [
      row('2. M. North, Studies in the linear case', 95, 725, 400),
      row('(Sample Press, 1990).', 108, 708, 122),
      row(`${gap ? 4 : 3}. S. South, Journal of Results, 3, 61 (2001).`, 95, 680, 315),
      row('4. F. East, Reports in Analysis, 12, 8 (2002).', 95, 655, 300),
      row('2', 297, 36, 6)
    ]
    const pages = [opening, continued].map((items, index) => ({
      page: index + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items,
      ...(index
        ? {
            nativeSectionFontEvidence: {
              complete: true,
              fonts: {
                Citation: { nativeMetrics: true, vertical: false, ascent: 0.8, descent: -0.2 }
              }
            }
          }
        : {})
    }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    const owner = (key: string): (typeof units)[number] | undefined =>
      units.find((unit) => unit.items.includes(key))
    expect(owner('1:0')?.sourceOnly).toBeUndefined()
    for (const key of ['1:1', '1:2', '1:3', '2:0', '2:1', '2:2', '2:3']) {
      expect(owner(key)).toBeDefined()
      expect(owner(key)?.preserve).toBe(gap ? undefined : 'reference')
    }
  }
)

it.each([true, false])(
  'retains a two-page surname-first bibliography only after a closed disclosure (%s)',
  async (hasDisclosure) => {
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const body = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const bold = await pdf.embedFont(await readFile(assets + 'LiberationSans-Bold.ttf'))
    function buildPage(n: number): PDFPage {
      const page = pdf.addPage([600, 800])
      page.drawText(String(n), { x: 552, y: 755, size: 10, font: body })
      page.pushOperators(
        beginText(),
        PDFOperator.of(PDFOperatorNames.SetTextLineHeight, [pdf.context.obj(10.5)])
      )
      return page
    }
    function line(page: PDFPage, value: string, x: number, y: number, year?: string): void {
      page.pushOperators(
        setFontAndSize(page.node.newFontDictionary(body.name, body.ref), 9),
        setTextMatrix(1, 0, 0, 1, x, y),
        showText(body.encodeText(value))
      )
      if (year)
        page.pushOperators(
          setFontAndSize(page.node.newFontDictionary(bold.name, bold.ref), 9),
          showText(bold.encodeText(year)),
          setFontAndSize(page.node.newFontDictionary(body.name, body.ref), 9),
          showText(body.encodeText(', 12, 501.'))
        )
      page.pushOperators(PDFOperator.of(PDFOperatorNames.NextLine))
    }
    const first = buildPage(1)
    const heading = hasDisclosure ? 'Competing interests' : 'Our numbered examples'
    first.pushOperators(
      setFontAndSize(first.node.newFontDictionary(bold.name, bold.ref), 10),
      setTextMatrix(1, 0, 0, 1, 330, 574),
      showText(bold.encodeText(heading)),
      setFontAndSize(first.node.newFontDictionary(body.name, body.ref), 10),
      setTextMatrix(1, 0, 0, 1, 450, 574),
      showText(body.encodeText('The authors declare no com-')),
      PDFOperator.of(PDFOperatorNames.NextLine),
      setTextMatrix(1, 0, 0, 1, 320, 562.5),
      showText(body.encodeText('peting interests.')),
      PDFOperator.of(PDFOperatorNames.NextLine)
    )
    line(first, '[1] Reader, A. Studies of sample archives. Journal of Data ', 57, 507, '2020')
    line(first, '[2] Writer, B. Notes from the field archive. Journal of Data ', 57, 496.5, '2021')
    line(first, '[3] Editor, C. Design of a material archive. Journal of Data ', 320, 507, '2022')
    line(first, '[4] Recorder, D. An annotated materials archive.', 320, 496.5)
    first.pushOperators(endText())
    const second = buildPage(2)
    line(second, 'Journal of Measurements ', 72, 727, '2023')
    line(second, '[5] Reader, A. Notes on the stored samples. Journal of Data ', 54, 716.5, '2022')
    line(second, '[6] Editor, C. Storing observations in the archive.', 54, 706)
    line(second, 'Journal of Measurements ', 338, 727, '2024')
    line(second, '[7] Writer, B. Sample storage practices. Journal of Data ', 320, 716.5, '2021')
    line(second, '[8] Recorder, D. An archive report. Journal of Data ', 320, 706, '2022')
    second.pushOperators(endText())
    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: assets
    })
    try {
      const { source } = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      })
      const references = source.units.filter((unit) =>
        /^\[\d+\]|^Journal of Measurements/u.test(unit.source)
      )
      expect(references).toHaveLength(9)
      expect(references.filter((unit) => unit.preserve === 'reference')).toHaveLength(
        hasDisclosure ? 5 : 0
      )
      expect(source.units.find((unit) => unit.source.includes(heading))?.sourceOnly).toBeUndefined()
    } finally {
      await loading.destroy()
    }
  }
)

it.each([false, true])(
  'preserves a terminal superscript bibliography continued across pages (numbering gap=%s)',
  async (gap) => {
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const bold = await pdf.embedFont(await readFile(assets + 'LiberationSans-Bold.ttf'))
    const text = 'A. Reader, Journal of Examples '
    const write = (page: PDFPage, count: number, start: number, x: number, top: number): void => {
      const regular = page.node.newFontDictionary(font.name, font.ref)
      const strong = page.node.newFontDictionary(bold.name, bold.ref)
      page.pushOperators(beginText())
      for (let i = 0; i < count; i++) {
        const label = String(start + i + (gap && start > 1 && i >= 2 ? 1 : 0))
        const y = top - i * 9.2
        const authorX = x + font.widthOfTextAtSize(label, 4.8) + 2
        const volumeX = authorX + font.widthOfTextAtSize(text, 8)
        page.pushOperators(
          setFontAndSize(regular, 4.8),
          setTextMatrix(1, 0, 0, 1, x, y + 3.6),
          showText(font.encodeText(label)),
          setFontAndSize(regular, 8),
          setTextMatrix(1, 0, 0, 1, authorX, y),
          showText(font.encodeText(text)),
          setFontAndSize(strong, 8),
          setTextMatrix(1, 0, 0, 1, volumeX, y),
          showText(bold.encodeText('12')),
          setFontAndSize(regular, 8),
          showText(font.encodeText(', 70 (2021).'))
        )
      }
      page.pushOperators(endText())
    }
    const first = pdf.addPage([600, 800])
    first.drawText('The authors thank the local team for work under grant M-2.', {
      font,
      size: 10,
      x: 313,
      y: 159
    })
    write(first, 3, 1, 310, 139)
    write(pdf.addPage([600, 800]), 5, 4, 52, 730)

    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: assets
    })
    try {
      const { source } = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'anonymous-bibliography',
        signal: new AbortController().signal
      })
      const citations = source.units.filter((unit) => unit.source.includes('Journal of Examples'))
      expect(
        citations.flatMap((unit) => [...unit.source.matchAll(/Journal of Examples/gu)])
      ).toHaveLength(8)
      expect(citations.every((unit) => (unit.preserve === 'reference') === !gap)).toBe(true)
      expect(
        source.units.find((unit) => unit.source.startsWith('The authors'))?.sourceOnly
      ).toBeUndefined()
    } finally {
      await loading.destroy()
    }
  }
)

it.each([false, true])(
  'preserves an unheaded hanging bibliography (nonreference tail=%s)',
  async (tail) => {
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    pdf
      .addPage([600, 800])
      .drawText('This paragraph explains how readers compare sample results.', {
        font,
        size: 11,
        x: 58,
        y: 710
      })
    const page = pdf.addPage([600, 800])
    for (let i = 0; i < 4; i++) {
      const y = 730 - i * 23
      page.drawText(String(i + 1), { font, size: 10, x: 55, y })
      page.drawText('Allen, Robin. "Notes on sample preparation". Journal of Examples (2020).', {
        font,
        size: 10,
        x: 72,
        y
      })
      page.drawText(`https://doi.org/10.9999/example-${i + 1}.`, {
        font,
        size: 10,
        x: 72,
        y: y - 11.5
      })
    }
    if (tail)
      page.drawText('Discuss these measurements with your group.', {
        font,
        size: 10,
        x: 72,
        y: 638
      })
    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: assets
    })
    try {
      const { source } = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'anonymous-bibliography',
        signal: new AbortController().signal
      })
      const citations = source.units.filter((unit) => unit.source.includes('Journal of Examples'))
      expect(
        citations.flatMap((unit) => [...unit.source.matchAll(/Journal of Examples/gu)])
      ).toHaveLength(4)
      expect(
        citations.every(
          (unit) => (unit.sourceOnly === true && unit.preserve === 'reference') === !tail
        )
      ).toBe(true)
      expect(
        source.units.find((unit) => unit.source.startsWith('This paragraph'))?.sourceOnly
      ).toBeUndefined()
    } finally {
      await loading.destroy()
    }
  }
)
