import type { PDFPageProxy } from 'pdfjs-dist'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  rememberNativeCaptionTerminal,
  isNativeCaptionTerminal
} from '../../src/reader/caption-terminal.js'
import {
  rememberPdfTranslationExtraction,
  getPdfTranslationLayoutSnapshot,
  restorePdfTranslationExtraction
} from '../../src/reader/snapshot.js'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from '../../src/reader/layout.js'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'

// Anonymous embedded Noto font, shared by three native pages. Page 1 uses one
// closed caption text program; pages 2/3 draw the same terminal as a peer panel.
const data = readFileSync(
  fileURLToPath(new URL('../fixtures/native-caption-terminal.pdf', import.meta.url))
)

it('keeps a complete native panel reference on its unfinished caption', async () => {
  const task = getDocument({ data: new Uint8Array(data) })
  onTestFinished(() => task.destroy())
  const document = await task.promise
  const { source, coverage } = await extractPdfTranslationSource({
    document,
    resourceRequestKey: 'native-caption-terminal',
    signal: new AbortController().signal
  })
  const owners = source.units.filter((unit) => unit.fragments.some((f) => f.pageNumber === 1))
  expect(owners).toHaveLength(1)
  expect(owners[0].source).toMatch(/reference values in \(d\)\.$/u)
  expect(owners[0].sourceOnly).not.toBe(true)
  expect(owners[0].preserve).toBeUndefined()
  const keys = source.units.flatMap((u) =>
    u.fragments.flatMap((f) => f.items.map((i) => `${f.pageNumber}:${i.index}`))
  )
  expect(new Set(keys).size).toBe(keys.length)
  expect(coverage.excludedItemCount).toBe(0)
  expect(coverage.includedItemCount).toBe(coverage.textItemCount)
})

it.each([2, 3])(
  'keeps an independently drawn terminal label original-only on page %s',
  async (pageNumber) => {
    const task = getDocument({ data: new Uint8Array(data) })
    onTestFinished(() => task.destroy())
    const document = await task.promise
    const { source } = await extractPdfTranslationSource({
      document,
      resourceRequestKey: 'independent-native-panel',
      signal: new AbortController().signal
    })
    const owners = source.units.filter((unit) =>
      unit.fragments.some((f) => f.pageNumber === pageNumber)
    )
    expect(owners).toHaveLength(2)
    expect(owners.find((u) => u.source.startsWith('Figure 1.'))?.source).toMatch(/values in$/u)
    expect(owners.find((u) => u.source === '(d).')).toMatchObject({
      sourceOnly: true,
      preserve: 'formula'
    })
  }
)

async function nativeContext(): Promise<{
  context: Parameters<typeof rememberNativeCaptionTerminal>[0]
  ops: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>
}> {
  const task = getDocument({ data: new Uint8Array(data) })
  onTestFinished(() => task.destroy())
  const document = await task.promise,
    originalPage = await document.getPage(1)
  const content = await originalPage.getTextContent(),
    ops = structuredClone(await originalPage.getOperatorList())
  const page = Object.create(originalPage) as typeof originalPage
  page.getOperatorList = async () => ops
  page.getTextContent = originalPage.getTextContent.bind(originalPage)
  const rawPage: PdfLayoutPage = {
    page: 1,
    width: 612,
    height: 792,
    rotation: 0,
    items: content.items.map((item) => {
      if (!('str' in item)) throw new Error('Anonymous fixture contains an unexpected marked item')
      const style = content.styles[item.fontName]
      return {
        ...item,
        transform: [
          item.transform[0],
          -item.transform[1],
          item.transform[2],
          item.transform[3],
          item.transform[4],
          792 - (792 - item.transform[5])
        ],
        fontAscent: style.ascent,
        fontDescent: style.descent,
        fontVertical: style.vertical
      }
    })
  }
  return {
    context: { document, page, content, rawPage, signal: new AbortController().signal },
    ops
  }
}

it.each([
  'unknown',
  'clip',
  'font',
  'size',
  'literal',
  'internal whitespace',
  'raw index',
  'leading',
  'unclosed',
  'image payload',
  'character budget',
  'glyph width'
])('declines native caption evidence with %s without breaking extraction', async (fault) => {
  const { context: c, ops } = await nativeContext(),
    show = ops.fnArray.findLastIndex((op) => op === OPS.showText)
  const item = c.content.items[1]
  if (!('str' in item)) throw new Error('Expected native text')
  if (fault === 'unknown' || fault === 'clip') {
    ops.fnArray.splice(show, 0, fault === 'clip' ? OPS.clip : 999999)
    ops.argsArray.splice(show, 0, [])
  }
  if (fault === 'font' || fault === 'size') {
    ops.fnArray.splice(show, 0, OPS.setFont)
    ops.argsArray.splice(show, 0, [
      fault === 'font' ? 'foreign-font' : item.fontName,
      fault === 'size' ? 10 : 9
    ])
  }
  if (fault === 'literal' || fault === 'internal whitespace') {
    item.str =
      fault === 'literal'
        ? item.str.replace('Panels', 'Foreign')
        : item.str.replace('Panels', 'Pan els')
    c.rawPage.items[1].str = item.str
  }
  if (fault === 'raw index')
    [c.rawPage.items[1], c.rawPage.items[2]] = [c.rawPage.items[2], c.rawPage.items[1]]
  if (fault === 'leading') c.rawPage.items[3].transform[5] -= 20
  if (fault === 'unclosed') {
    const at = ops.fnArray.indexOf(OPS.endText)
    ops.fnArray.splice(at, 1)
    ops.argsArray.splice(at, 1)
  }
  if (fault === 'image payload') {
    ops.fnArray.unshift(OPS.paintImageXObject)
    ops.argsArray.unshift([{ pixels: new Uint8Array(1024) }, 2, 2])
  }
  if (fault === 'character budget') {
    item.str = 'x'.repeat(65537)
    c.rawPage.items[1].str = item.str
  }
  if (fault === 'glyph width') ops.argsArray[show][0][0].width += 1
  expect(await rememberNativeCaptionTerminal(c)).toBeUndefined()
  expect(isNativeCaptionTerminal(c.rawPage, [0, 1, 2], 3)).toBe(false)
})

it.each(['raw literal', 'canonical literal', 'operator argument', 'fingerprint', 'item identity'])(
  'invalidates current native caption ownership after %s mutation',
  async (mutation) => {
    const { context: c, ops } = await nativeContext(),
      current = await rememberNativeCaptionTerminal(c)
    expect(current?.()).toBe(true)
    expect(isNativeCaptionTerminal(c.rawPage, [0, 1, 2], 3)).toBe(true)
    if (mutation === 'raw literal') c.rawPage.items[3].str = '(c).'
    if (mutation === 'canonical literal') {
      const item = c.content.items[1]
      if ('str' in item) item.str = item.str.replace('Panels', 'Pan els')
    }
    if (mutation === 'operator argument') ops.argsArray[ops.fnArray.indexOf(OPS.setFont)][1] = 10
    if (mutation === 'fingerprint') c.document.fingerprints[0] = 'changed-native-document'
    if (mutation === 'item identity') c.rawPage.items = [...c.rawPage.items]
    expect(current?.()).toBe(false)
    expect(isNativeCaptionTerminal(c.rawPage, [0, 1, 2], 3)).toBe(false)
  }
)

it('declines unavailable native metrics and propagates cancellation', async () => {
  const { context: c } = await nativeContext()
  c.page.getOperatorList = async () => {
    throw new Error('Native operator evidence unavailable')
  }
  await expect(rememberNativeCaptionTerminal(c)).resolves.toBeUndefined()
  const abort = new AbortController()
  abort.abort()
  await expect(rememberNativeCaptionTerminal({ ...c, signal: abort.signal })).rejects.toThrow()
})

it('serializes fresh sources without proof and restores historical snapshots unchanged', async () => {
  const task = getDocument({ data: new Uint8Array(data) })
  onTestFinished(() => task.destroy())
  const extraction = await extractPdfTranslationSource({
    document: await task.promise,
    resourceRequestKey: 'caption-snapshot',
    signal: new AbortController().signal
  })
  rememberPdfTranslationExtraction(extraction)
  const snapshot = getPdfTranslationLayoutSnapshot(extraction.source)!
  expect(snapshot.parserVersion).toBe('pdfjs-paragraph-layout-130')
  const saved = JSON.parse(JSON.stringify(snapshot))
  expect(Object.keys(saved).sort()).toEqual(
    ['version', 'parserVersion', 'fingerprint', 'pages', 'units', 'coverage'].sort()
  )
  expect(JSON.stringify(saved)).not.toMatch(/current|nativeCaption|program|proof/u)
  saved.parserVersion = 'pdfjs-paragraph-layout-6'
  const historical = restorePdfTranslationExtraction(saved, 'historical-caption')
  expect(getPdfTranslationLayoutSnapshot(historical.source)?.parserVersion).toBe(
    'pdfjs-paragraph-layout-6'
  )
  expect(historical.source.units).toEqual(saved.units)
})

it.each(['matching captions', 'different tail', 'different center'] as const)(
  'joins repeated centered caption endings only with a full native witness: %s',
  (mode) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      height = 8
    ): PdfLayoutTextItem => ({
      str,
      width,
      height,
      dir: 'ltr',
      fontName: height === 8 ? 'Caption' : 'Body',
      fontVertical: false,
      hasEOL: true,
      transform: [height, 0, 0, height, x, 800 - y]
    })
    const captions = (number: number, y: number): PdfLayoutTextItem[] => [
      row(`Fig. ${number}. Response estimates calculated for different`, 325, y, 200),
      row(
        number === 3 && mode === 'different tail' ? 'test samples.' : 'input ranges.',
        number === 3 && mode === 'different center' ? 413 : 404,
        y + 9.2,
        42
      )
    ]
    const body = row('Independent body prose follows the measurements.', 50, 400, 240, 10)
    const pages: PdfLayoutPage[] = [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        items: [...captions(1, 120), ...captions(2, 250), body]
      },
      { page: 2, width: 600, height: 800, rotation: 0, items: [...captions(3, 120), body] }
    ]
    const { units } = groupPdfTranslationPages({ pages })
    const heads = units.filter((unit) => unit.source.startsWith('Fig. '))
    expect(heads).toHaveLength(3)
    expect(heads.every((unit) => unit.source.endsWith('input ranges.'))).toBe(
      mode === 'matching captions'
    )
    if (mode === 'matching captions')
      expect(heads.every((unit) => unit.fragments.length === 2)).toBe(true)
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      pages.flatMap((p) => p.items.map((_, index) => `${p.page}:${index}`)).sort()
    )
  }
)

it.each(['terminal', 'different center', 'intervening prose'] as const)(
  'joins the short centered figure caption ending only at a native page boundary: %s',
  (shape) => {
    const run = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Caption'
    ): PdfLayoutTextItem => ({
      str,
      width,
      height: 8,
      dir: 'ltr',
      fontName,
      fontVertical: false,
      hasEOL: false,
      transform: [8, 0, 0, 8, x, y]
    })
    const label = run('Fig. 3:', 320, 627, 24, 'CaptionLabel')
    const lead = run('Response changes in the steady', 346, 627, 162)
    const ending = run('sampling range', shape === 'different center' ? 400 : 385, 615, 58)
    const gap = { ...run('', 0, 0, 0), height: 0, hasEOL: true }
    const body = run(
      'The earlier estimates provide a separate physical comparison.',
      309,
      310,
      220,
      'Body'
    )
    const trailing = run('An independent observation follows the caption.', 310, 580, 220, 'Body')
    const items = [
      body,
      gap,
      label,
      lead,
      gap,
      ending,
      ...(shape === 'intervening prose' ? [trailing] : [])
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 840, rotation: 0, items }]
    })
    const first = units.find((u) => u.items.includes('1:2'))!
    expect(first.source.endsWith('sampling range')).toBe(shape === 'terminal')
    expect(first.fragments.length).toBe(shape === 'terminal' ? 2 : 1)
    expect(units.flatMap((u) => u.items).sort()).toEqual(
      items.flatMap((i, n) => (i.str ? [`1:${n}`] : [])).sort()
    )
  }
)

it.each(['separate sizes', 'same size'] as const)(
  'uses native caption size and the paragraph gap to separate a completed caption: %s',
  (shape) => {
    const row = (str: string, y: number, width: number, size: number): PdfLayoutTextItem => ({
      str,
      width,
      height: size,
      dir: 'ltr',
      fontName: 'Text',
      fontVertical: false,
      hasEOL: true,
      transform: [size, 0, 0, size, 62, y]
    })
    const captionSize = shape === 'same size' ? 10 : 9
    const items = [
      row('Figure 2. Overview of the measured response across both', 520, 248, captionSize),
      row('conditions. Each curve shows a separate trial.', 510, 230, captionSize),
      row('The reference measurements remained stable during the', 493.3, 248, 10),
      row('experiment and the procedure was repeated twice to check', 482.3, 248, 10),
      row('for changes over time.', 471.3, 98, 10)
    ]
    const page: PdfLayoutPage = { page: 1, width: 610, height: 790, rotation: 0, items }
    const { units } = groupPdfTranslationPages({ pages: [page] })
    expect(units[0].items).toEqual(
      shape === 'same size' ? ['1:0', '1:1', '1:2', '1:3', '1:4'] : ['1:0', '1:1']
    )
    if (shape === 'separate sizes') {
      expect(units[0].source.endsWith('a separate trial.')).toBe(true)
      expect(units[1].items).toEqual(['1:2', '1:3', '1:4'])
      expect(units[0].fragments[0].rect.bottom).toBeLessThan(units[1].fragments[0].rect.y)
    }
    expect(units.flatMap((unit) => unit.items)).toEqual(items.map((_, i) => `1:${i}`))
  }
)
