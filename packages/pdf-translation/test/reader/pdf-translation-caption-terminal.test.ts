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
import type { PdfLayoutPage } from '../../src/reader/layout.js'
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
  expect(snapshot.parserVersion).toBe('pdfjs-paragraph-layout-15')
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
