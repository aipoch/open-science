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
  showText,
  rgb
} from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readNativeReferenceEvidence } from '../../src/reader/native-reference-evidence.js'
import { expect, it } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { applyPdfContentFirstPolicy } from '../../src/reader/content-policy.js'
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

async function generatedOwnedReferenceDocument(fault = ''): Promise<PDFDocumentProxy> {
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
  start(2, 5, 'E. Writer, Independent terminal observations,', 336, 100)
  line(
    2,
    fault === 'missing-terminal'
      ? 'Journal of Examples 14 (2024)'
      : 'Journal of Examples 14 (2024).',
    356,
    114
  )
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

async function generatedOwnedReferenceProof(fault = ''): Promise<{
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
  const document = await generatedOwnedReferenceDocument(fault),
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
