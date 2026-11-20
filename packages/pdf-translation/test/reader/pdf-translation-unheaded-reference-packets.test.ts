import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  PDFDocument,
  PDFOperator,
  PDFOperatorNames,
  pushGraphicsState,
  popGraphicsState,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  setFillingColor,
  showText,
  rgb
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
    pages = Array.from({ length: 3 }, () => pdf.addPage([600, 800])),
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
  start(2, 4, 'D. Author,', 56, 750)
  line(2, 'A report across columns, Journal 13 (2023).', 356, 60)
  if (embedded) {
    const page = pages[1],
      marker = '[5] ',
      text = 'E. Writer, Independent observations, Journal 14 (2024).'
    page.pushOperators(
      pushGraphicsState(),
      beginText(),
      setFontAndSize(page.node.newFontDictionary(regular.name, regular.ref), 9),
      setTextMatrix(1, 0, 0, 1, 336, 700),
      showText(regular.encodeText(marker)),
      setFillingColor(rgb(0, 0, 0)),
      ...(fault === 'matrix-reset'
        ? [setTextMatrix(1, 0, 0, 1, 336 + regular.widthOfTextAtSize(marker, 9), 700)]
        : []),
      showText(regular.encodeText(text)),
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
  line(3, 'Appendix A', 56, 60, true)
  line(3, 'This independent appendix paragraph remains eligible for ordinary translation.', 56, 90)
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

it.each(['closed', 'ordinal gap'])(
  'keeps only a closed terminal right-column native bibliography: %s',
  async (shape) => {
    const require = createRequire(import.meta.url),
      assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/',
      pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const regular = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf')),
      bold = await pdf.embedFont(await readFile(assets + 'LiberationSans-Bold.ttf')),
      page = pdf.addPage([612, 792])
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
    for (let i = 0; i < 8; i++) {
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
      const owners = source.units.filter(
        (unit) =>
          unit.source.includes('Complete independent study') ||
          unit.source.startsWith('Journal of Native Tests')
      )
      expect(owners).toHaveLength(16)
      expect(owners.every((unit) => Boolean(unit.sourceOnly) === (shape === 'closed'))).toBe(true)
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

it.each(['complete', 'number-gap', 'ordinary-tail'] as const)(
  'protects only a complete terminal right-column superscript bibliography: %s',
  async (fault) => {
    const require = createRequire(import.meta.url),
      assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/',
      pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf')),
      page = pdf.addPage([600, 800]),
      graphic = await PDFDocument.create()
    graphic.addPage([90, 70]).drawRectangle({ x: 7, y: 9, width: 39, height: 23 })
    const [embedded] = await pdf.embedPdf(await graphic.save())
    page.drawPage(embedded, { x: 48, y: 590 })
    page.drawText('Independent prose beside the figure remains eligible.', {
      font,
      size: 10,
      x: 54,
      y: 701
    })
    page.drawText('Independent prose ends before the records.', {
      font,
      size: 10,
      x: 320,
      y: 701
    })
    page.pushOperators(beginText())
    for (let n = 0; n < 5; n++) {
      const ordinal = String(n === 2 && fault === 'number-gap' ? 9 : n + 1),
        y = 678 - n * 11,
        height = 6.75,
        x = 333 - font.widthOfTextAtSize(ordinal, height) - 0.2
      page.pushOperators(
        setFontAndSize(page.node.newFontDictionary(font.name, font.ref), height),
        setTextMatrix(1, 0, 0, 1, x, y + 2.8),
        showText(font.encodeText(ordinal)),
        setFontAndSize(page.node.newFontDictionary(font.name, font.ref), 9),
        setTextMatrix(1, 0, 0, 1, 333, y),
        showText(
          font.encodeText(
            fault === 'ordinary-tail' && n === 4
              ? 'We now present ordinary observations.'
              : 'A. Writer, Journal of Examples 12 (2020).'
          )
        )
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
      expect(prose).toContain('Independent prose beside the figure remains eligible.')
      expect(prose).toContain('Independent prose ends before the records.')
      const referenceItems = references.flatMap((unit) => unit.fragments.flatMap((f) => f.items))
      expect(referenceItems).toHaveLength(fault === 'complete' ? 10 : 0)
      expect(references.every((unit) => unit.sourceOnly)).toBe(true)
    } finally {
      await loading.destroy()
    }
  }
)

it.each(['contact footer', 'unmarked address'])(
  'recognizes a complete final bibliography after a marked address: %s',
  async (shape) => {
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const [first, last] = [pdf.addPage([600, 800]), pdf.addPage([600, 800])]
    const line = (page: typeof first, text: string, x: number, y: number, size = 9): void =>
      page.drawText(text, { font, size, x, y })

    line(first, 'The final paragraph describes the observations.', 320, 670, 11)
    line(first, shape === 'contact footer' ? '*' : 'x', 328, 634, 6)
    line(first, 'author@example.org', 339, 630)
    line(first, '[1] A. Writer, An independent study,', 320, 619)
    line(first, 'Journal of Examples 11 (2020).', 339, 608)
    line(first, '[2] B. Van Dalen, Another independent study,', 320, 597)
    line(first, 'Journal of Examples 12 (2021).', 339, 586)
    line(first, '[3] C. Writer, A separate measurement,', 320, 575)
    line(first, 'Journal of Examples 13 (2022).', 339, 564)
    line(last, '[4] D. Writer, An independent replication,', 50, 730)
    line(last, 'Journal of Examples 14 (2023).', 69, 719)
    line(last, '[5] E. Writer, The last study,', 320, 730)
    line(last, 'Journal of Examples 15 (2024).', 339, 719)
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
      const bibliography = units.filter((unit) => /\[\d\]|Journal of Examples/u.test(unit.source))
      expect(bibliography).toHaveLength(10)
      expect(bibliography.filter((unit) => unit.preserve === 'reference')).toHaveLength(
        shape === 'contact footer' ? 10 : 0
      )
      expect(
        units
          .filter((unit) => /The final paragraph|author@example.org/u.test(unit.source))
          .every((unit) => !unit.sourceOnly && !unit.preserve)
      ).toBe(true)
    } finally {
      await loading.destroy()
    }
  }
)

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

it.each(['closed', 'different heading', 'skipped ordinal'])(
  'keeps terminal bracketed records after acknowledgments across pages: %s',
  (shape) => {
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
        body(
          'Their comments and recordings improved the interpretation of the data.',
          317,
          580,
          202
        ),
        ...entries([1, 2, 3], 54, 535),
        ...entries([4, 5, 6], 317, 134)
      ],
      [body('3', 557, 756, 5), ...entries([7, 8, 9], 54, 730), ...entries([10, 11, 12], 317, 701)]
    ].map((items, index) => ({ page: index + 1, width: 612, height: 792, rotation: 0, items }))
    const { units } = groupPdfTranslationPages({ pages, pageCount: pages.length })
    const refs = units.filter((unit) =>
      /^(?:\[\d+\] A\. Reader|(?:Example Journal|Journal of Examples) )/u.test(unit.source)
    )
    expect(refs).toHaveLength(24)
    expect(refs.filter((unit) => unit.sourceOnly)).toHaveLength(shape === 'closed' ? 24 : 0)
    expect(units.find((unit) => unit.source.startsWith('We thank'))?.sourceOnly).toBeUndefined()
  }
)
