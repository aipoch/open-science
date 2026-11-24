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
  expect(snapshot.parserVersion).toBe('pdfjs-paragraph-layout-316')
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

it.each([true, false])(
  'joins a centered caption ending before a separate acknowledgments heading (%s)',
  (heading) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Body',
      hasEOL = true
    ): PdfLayoutTextItem => ({
      str,
      width,
      height: 11,
      dir: 'ltr',
      fontName,
      fontVertical: false,
      fontAscent: 0.75,
      fontDescent: -0.2,
      hasEOL,
      transform: [11, 0, 0, 11, x, y]
    })
    const items = [
      row(
        'Measurements were recorded using the same procedures throughout the session.',
        65,
        405,
        465
      ),
      row(
        'Figure 3. The samples are on the left, the reference is in the middle, and the',
        75,
        306,
        450
      ),
      row('output is on the right.', 230, 293.3, 140, 'Body', false),
      row(
        heading ? 'Acknowledgments' : 'An independent observation begins here.',
        65,
        268,
        126,
        'Heading',
        false
      ),
      row('We thank the field staff who maintained the instruments.', 65, 255, 360)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 792, rotation: 0, items }]
    })
    const caption = units.find((unit) => unit.items.includes('1:1'))
    expect(caption?.source.endsWith('output is on the right.')).toBe(heading)
    expect(caption?.items).toEqual(heading ? ['1:1', '1:2'] : ['1:1'])
    expect(units.filter((unit) => unit.items.includes('1:2'))).toHaveLength(1)
    expect(caption?.items.includes('1:3')).toBe(false)
  }
)

it.each([true, false])(
  'joins a centered series of captions around lowered symbols (%s)',
  (aligned) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL = true,
      height = 10,
      fontName = 'Text'
    ): PdfLayoutTextItem => ({
      str,
      width,
      height,
      dir: 'ltr',
      fontName,
      fontVertical: false,
      fontAscent: 0.69,
      fontDescent: -0.19,
      transform: [height, 0, 0, height, x, y],
      hasEOL
    })
    const pages = Array.from({ length: 3 }, (_, page) => {
      const center = !aligned && page === 2 ? 430 : 438
      return {
        page: page + 1,
        width: 600,
        height: 800,
        rotation: 0,
        items: [
          row('A separate paragraph begins in the left column.', 54, 700, 240),
          row('Its final sentence explains the protocol.', 54, 688.5, 190),
          row(`FIG. ${page + 1}: A diagram records the device settings.`, center - 112, 541, 224),
          row('The teams compared the two measured quantities', center - 114, 529.5, 228),
          row('Read the first setting as:', center - 106, 518, 124, false),
          row('V', center + 22, 518, 6, false, 10, 'Math'),
          row('C', center + 28, 516.5, 6, false, 7, 'Subscript'),
          row('(the range', center + 40, 518, 66),
          row('recorded across channel C) and', center - 109, 506.5, 138, false),
          row('V', center + 34, 506.5, 6, false, 10, 'Math'),
          row('D', center + 40, 505, 6, false, 7, 'Subscript'),
          row('(the range', center + 52, 506.5, 57),
          row('recorded across channel D)', center - 58, 495, 116),
          row('The next complete paragraph reports measurements.', 317, 452, 240),
          row('This sentence remains separate from the figure.', 317, 440.5, 225)
        ]
      }
    })
    const { units } = groupPdfTranslationPages({ pages })
    const captions = units.filter((unit) => unit.source.startsWith('FIG. '))
    expect(captions).toHaveLength(3)
    expect(captions.every((unit) => unit.source.endsWith('recorded across channel D)'))).toBe(
      aligned
    )
    expect(
      units
        .filter((unit) => unit.source.includes('The next complete paragraph'))
        .every((unit) => !unit.source.includes('diagram records'))
    ).toBe(true)
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      pages.flatMap((page) => page.items.map((_, index) => `${page.page}:${index}`)).sort()
    )
  }
)

it.each([true, false])(
  'joins a closed figure cross-reference at its native caption wrap (%s)',
  (aligned) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL: boolean
    ): PdfLayoutTextItem => ({
      str,
      width,
      height: 9,
      dir: 'ltr',
      transform: [9, 0, 0, 9, x, y],
      fontName: 'Body',
      fontAscent: 0.7,
      fontDescent: -0.2,
      fontVertical: false,
      hasEOL
    })
    const items = [
      item(
        'Fig. 1. Measurements were recorded at three evenly spaced locations',
        42,
        404,
        215,
        true
      ),
      item(
        'The highest marker shows the measurements of the second trial (see',
        42,
        394,
        215,
        true
      ),
      item('Fig. 4).', aligned ? 42 : 61, 384, 24, false),
      item('The following narrative begins an independent paragraph.', 42, 351, 220, true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }]
    })
    const head = units.find((unit) => unit.items.includes('1:0'))
    expect(head?.items.includes('1:2')).toBe(aligned)
    expect(head?.items).not.toContain('1:3')
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(['1:0', '1:1', '1:2', '1:3'])
  }
)

it.each(['centered', 'shifted ending', 'narrow body'] as const)(
  'keeps a centered continuation after a parenthesized caption subject (%s)',
  (shape) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      height: number,
      fontName = 'Body',
      hasEOL = true
    ): PdfLayoutTextItem => ({
      str,
      width,
      height,
      dir: 'ltr',
      fontName,
      fontVertical: false,
      fontAscent: 0.75,
      fontDescent: -0.2,
      hasEOL,
      transform: [height, 0, 0, height, x, y]
    })
    const firstBody = 'The observations describe the independent response over time.'
    const items = [
      row('Figure 2.', 75, 560, 36, 9, 'CaptionLabel', false),
      row('Comparison of the adjusted measurements. The RATE(model)', 113, 560, 312, 9),
      row(
        'values decline as the records reach their stable limits.',
        shape === 'shifted ending' ? 152 : 140,
        550,
        220,
        9,
        'Body',
        false
      ),
      row(firstBody, 70, 528, shape === 'narrow body' ? 325 : 360, 10),
      row('The remaining samples were collected in the same chamber.', 70, 516, 360, 10)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 580, height: 830, rotation: 0, items }]
    })
    const caption = units.find((unit) => unit.items.includes('1:0'))!
    expect(caption.items).toEqual(shape === 'centered' ? ['1:0', '1:1', '1:2'] : ['1:0', '1:1'])
    expect(caption.source.endsWith(items[2].str)).toBe(shape === 'centered')
    expect(caption.fragments).toHaveLength(shape === 'centered' ? 2 : 1)
    expect(units.find((unit) => unit.items.includes('1:3'))?.source.startsWith(firstBody)).toBe(
      true
    )
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(items.map((_, i) => `1:${i}`))
  }
)

it.each(['centered', 'shifted tail', 'missing native break'] as const)(
  'joins an enumerated caption subject to the predicate on its shorter centered row (%s)',
  (shape) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      height: number,
      fontName: string
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
      hasEOL: false
    })
    const first =
      'Figure 7: Collecting repeated measurements, checking reference settings, comparing consecutive readings'
    const last = 'to confirm changes across the samples is a method for assessing stability.'
    const items = [
      row(first, 120, 488, 360, 9, 'Caption'),
      { ...row('', 0, 0, 0, 0, ''), hasEOL: shape !== 'missing native break' },
      row(last, shape === 'shifted tail' ? 180 : 165, 477, 270, 9, 'Caption'),
      row(
        'Independent validation uses the full native body rail below this figure.',
        66,
        453,
        468,
        11,
        'Body'
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }]
    })
    const caption = units.find((unit) => unit.items.includes('1:0'))
    expect(caption?.source).toBe(shape === 'centered' ? first + ' ' + last : first)
    expect(caption?.fragments).toHaveLength(shape === 'centered' ? 2 : 1)
    expect(units.find((unit) => unit.items.includes('1:3'))?.items).toEqual(['1:3'])
  }
)

it.each(['continuation', 'paragraph gap', 'different threshold'] as const)(
  'keeps the native caption comparison together when its row is continuous: %s',
  (shape) => {
    const run = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL = false,
      fontName = 'Caption'
    ): PdfLayoutTextItem => ({
      str,
      width,
      height: 10,
      dir: 'ltr',
      fontName,
      fontVertical: false,
      fontAscent: 0.79,
      fontDescent: -0.21,
      hasEOL,
      transform: [10, 0, 0, 10, x, y]
    })
    const heading = 'Figure 2: The reference curves use samples measured at steady state, with'
    const middle = 'a common reference scale and a representative profile'
    const tailY = shape === 'paragraph gap' ? 499 : 515
    const threshold = shape === 'different threshold' ? '= 5' : '= 4'
    const following = 'Samples were measured separately.'
    const items = [
      run(heading, 72, 540, 435, true),
      run(middle, 72, 527.5, 435, true),
      run('for', 72, tailY, 13),
      run('q', 88, tailY, 5, false, 'Variable'),
      run('≥', 96, tailY, 8, false, 'Operator'),
      run('4', 107, tailY, 5, false, 'Operator'),
      run('(shown for', 115, tailY, 51),
      run('q', 169, tailY, 5, false, 'Variable'),
      run(threshold, 177, tailY, 14, false, 'Operator'),
      run(').', 191, tailY, 7, true),
      run(following, 72, 484, 435, true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    expect(units.map((u) => u.source)).toEqual(
      shape === 'continuation'
        ? [`${heading} ${middle} for q ≥ 4 (shown for q = 4).`, following]
        : [`${heading} ${middle}`, 'for q ≥ 4', `(shown for q ${threshold}).`, following]
    )
    expect(units[0].sourceOnly).not.toBe(true)
    expect(units.flatMap((u) => u.items)).toEqual(items.map((_, index) => `1:${index}`))
  }
)

it.each(['continuous', 'other rail'] as const)(
  'keeps the final panel locator in its caption (%s)',
  (shape) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL = true
    ): PdfLayoutTextItem => ({
      str,
      width,
      height: 8,
      dir: 'ltr',
      fontName: 'Caption',
      fontVertical: false,
      fontAscent: 0.8,
      fontDescent: -0.2,
      hasEOL,
      transform: [8, 0, 0, 8, x, y]
    })
    const captionRows = [
      'Figure 4. Panel (a): The first measurement defines the baseline.',
      'The shaded trace shows the range of values recorded at all stations.',
      'Panel (b): the second measurement uses the same time scale.',
      'The profile at the final station is shown in the lower panel (cf. Fig.'
    ]
    const locator = '2b).'
    const items = [
      ...captionRows.map((str, index) => row(str, 305, 413 - index * 10, 243)),
      row(locator, shape === 'continuous' ? 305 : 317, 373, 13, false)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 782, rotation: 0, items }]
    })
    const owner = units.find((unit) => unit.items.includes('1:3'))
    expect(owner?.source).toBe(
      [captionRows.join(' '), ...(shape === 'continuous' ? [locator] : [])].join(' ')
    )
    expect(owner?.items.includes('1:4')).toBe(shape === 'continuous')
  }
)

it.each(['continuous', 'indent', 'paragraph gap', 'different sign font', 'complete prose'])(
  'joins a signed value only on its native caption wrap (%s)',
  (shape) => {
    const run = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Caption',
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      width,
      height: str ? 9 : 0,
      dir: 'ltr',
      transform: [9, 0, 0, 9, x, y],
      fontName,
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false,
      hasEOL
    })
    const x = shape === 'indent' ? 66 : 54,
      y = shape === 'paragraph gap' ? 455 : 476
    const items = [
      run(
        'FIG. 7. These images record the different settings of the training instrument.',
        54,
        509,
        502,
        'Caption',
        true
      ),
      run(
        'The first two experimental panels compare the simulated responses under steady conditions.',
        54,
        498,
        502,
        'Caption',
        true
      ),
      run('During the measurement phase the device applies the frequencies of', 54, 487, 450),
      run('±', 507, 487, 6, 'Symbols'),
      run('1,', 513, 487, 6),
      run('±', 522, 487, 6, 'Symbols'),
      run(shape === 'complete prose' ? '2.' : '2 and', 528, 487, 28),
      run('', x, y, 0, 'Symbols', true),
      run('±', x, y, 6, shape === 'different sign font' ? 'Other' : 'Symbols'),
      run('5.', x + 6, y, 7),
      run('', 54, 435, 0, 'Caption', true),
      run(
        'A separate report describes the operations of the control group.',
        54,
        435,
        246,
        'Prose',
        true
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const caption = units.find((unit) => unit.items.includes('1:0'))
    const tailOwners = units.filter(
      (unit) => unit.items.includes('1:8') || unit.items.includes('1:9')
    )
    expect(caption?.source.endsWith('±1, ±2 and ±5.')).toBe(shape === 'continuous')
    expect(tailOwners).toHaveLength(1)
    expect(tailOwners[0].items.includes('1:0')).toBe(shape === 'continuous')
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      items.flatMap((item, index) => (item.str ? [`1:${index}`] : [])).sort()
    )
  }
)

it.each([0, -4])('merges a caption only around a native subscript (base offset %s)', (offset) => {
  const rows = [
    [
      'Fig. 1. Overview of controlled sensor measurements. (a)',
      67.15,
      191.84,
      240,
      9,
      'Body',
      true
    ],
    ['The first measurement uses a fixed-frequency', 67.15, 181.29, 245.55, 9, 'Body', true],
    ['source (', 67.15, 169.78, 21.91, 9, 'Body', false],
    ['𝑎', 88.67, 170.73, 4.95, 9, 'Math', false],
    ['1', 93.62, 169.1, 3.88, 6.5, 'Index', false],
    [') illuminates the target, and the output signal (', 97.67, 169.78, 182.57, 9, 'Body', false],
    ['𝑎', 279.85, 170.73, 4.95, 9, 'Math', false],
    ['+', 290.83, 170.73, 6.72, 9, 'Index', false],
    ['𝑏)', 299.54, 170.73, 4.95, 9, 'Math', false],
    [
      'is divided between two channels. (b) The second trace',
      67.15,
      159.23,
      245.55,
      9,
      'Body',
      true
    ],
    ['remains stable through a second run at each sample,', 67.15, 146.45, 245.55, 9, 'Body', true],
    [
      'while a second source passes through the same reference',
      67.15,
      135.9,
      245.55,
      9,
      'Body',
      true
    ],
    [
      'filter and is recorded with the detector at each step,',
      67.15,
      125.34,
      245.55,
      9,
      'Body',
      true
    ],
    ['producing an averaged measurement.', 67.15, 114.79, 154.4, 9, 'Body', false]
  ] as const
  const items: PdfLayoutTextItem[] = rows.map(
    ([str, x, y, width, height, fontName, hasEOL], i) => ({
      str,
      width,
      height,
      dir: 'ltr',
      transform: [height, 0, 0, height, x, y + (i === 3 ? offset : 0)],
      fontName,
      fontFamily: fontName === 'Body' ? 'serif' : 'sans-serif',
      fontAscent: fontName === 'Body' ? 0.95 : 0.78,
      fontDescent: -0.22,
      fontVertical: false,
      hasEOL
    })
  )
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
  })
  const caption = units.find((unit) => unit.items.includes('1:0'))
  const wrapped = ['1:2', '1:3', '1:4', '1:5']
  expect(caption?.items.filter((item) => wrapped.includes(item))).toEqual(offset ? [] : wrapped)
})

it.each([0, 12])(
  'joins a caption with a native parameter row and final measurement (%s)',
  (shift) => {
    const rows = [
      ['Figure 1.', 317.04, 606.12, 34.28, 'body'],
      ['Measurement of the di', 360.24, 606.12, 32.13, 'body'],
      ['erence between two reference outputs', 397.8, 606.12, 154.22, 'body'],
      ['measured with the first channel', 317.04, 595.68, 109.22, 'body'],
      ['T', 430.2, 595.68, 4.99, 'math'],
      ['for the second calibration with', 440.04, 595.68, 122.08, 'body'],
      ['a', 317.04, 585.24, 4.48, 'math'],
      ['=', 323.76, 585.24, 5.7, 'relation'],
      ['180 nm,', 331.68, 585.24, 29.72, 'body'],
      ['r', 364.2, 585.24, 3.49, 'math'],
      ['=', 370.2, 585.24, 5.7, 'relation'],
      ['65 nm and', 378.12, 585.24, 43.12, 'body'],
      ['a', 423.96, 585.24, 4.48, 'math'],
      ['=', 430.68, 585.24, 5.7, 'relation'],
      ['220 nm,', 438.6, 585.24, 29.72, 'body'],
      ['r', 471.24, 585.24, 3.49, 'math'],
      ['=', 477.12, 585.24, 5.7, 'relation'],
      ['92 nm,', 485.04, 585.24, 29.72, 'body'],
      ['h', 517.68, 585.24, 4.48, 'math'],
      ['=', 524.4, 585.24, 5.7, 'relation'],
      ['60 nm,', 532.32, 585.24, 29.72, 'body'],
      ['k', 317.04, 574.8, 3.98, 'math'],
      ['is dimensionless.', 324.72, 574.8, 57.08, 'body'],
      ['The estimated di', 388.8, 574.8, 48.45, 'body'],
      ['erence approaches a fixed value near', 442.68, 574.8, 119.39, 'body'],
      ['λ', 317.04, 564.36, 4.75, 'symbol'],
      ['=', 323.76, 564.36, 5.7, 'relation'],
      ['320 nm, corresponding to a stable reference.', 331.44, 564.36, 131.72, 'body']
    ] as const
    const items: PdfLayoutTextItem[] = rows.map(([str, x, y, width, fontName], i) => ({
      str,
      dir: 'ltr',
      width,
      height: 8.97,
      transform: [8.97, 0, 0, 8.97, x + (i === rows.length - 1 ? shift : 0), y],
      fontName,
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false,
      hasEOL: false
    }))
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const caption = units.find((unit) => unit.source.startsWith('Figure 1.'))
    expect(caption?.source.includes('λ = 320 nm, corresponding to a stable reference.')).toBe(
      !shift
    )
    if (!shift) expect(caption?.items).toHaveLength(rows.length)
  }
)

it.each([0, 4])(
  'joins an intensity caption across its coefficient and exponent (shift %s)',
  (shift) => {
    const rows = [
      ['Fig. 1.', 47.82, 603.97, 25.06, 8.52, 'label', false],
      [
        'Recorded response for the test input with intensity',
        75.81,
        603.97,
        213.27,
        8.97,
        'body',
        false
      ],
      ['I', 48.38, 593.06, 2.99, 8.97, 'math', false],
      ['(', 51.96, 593.06, 3.63, 9.34, 'relation', false],
      ['t', 55.8, 593.06, 2.99, 8.97, 'math', false],
      [',', 58.9, 593.06, 2.29, 8.97, 'body', false],
      ['z', 62.8, 593.06, 3.98, 8.97, 'math', false],
      ['=', 70.6, 593.06, 7.27, 9.34, 'relation', false],
      ['0', 81.57, 593.06, 4.57, 8.97, 'body', false],
      [') =', 86.25, 593.06, 14.71, 9.34, 'relation', false],
      ['1', 104.67, 593.06, 4.57, 8.97, 'body', false],
      ['+', 111.32, 593.06, 7.27, 9.34, 'relation', false],
      ['0.35', 120.66, 593.06, 16.01, 8.97, 'body', false],
      ['exp', 138.16, 593.06, 14.31, 8.97, 'body', false],
      ['(', 152.58, 593.06, 3.63, 9.34, 'relation', false],
      ['−', 156.43, 593.06, 7.27, 9.34, 'minus', false],
      ['0.002', 163.8, 593.06, 20.58, 8.97, 'body', false],
      ['t', 184.49, 593.06, 2.99, 8.97, 'math', false],
      ['2', 187.59, 596.32, 3.49, 6.97, 'body', false],
      [')', 191.68, 593.06, 3.63, 9.34, 'relation', false],
      [', and zero initial veloci-', 195.42, 593.06, 95.14, 8.97, 'body', true],
      ['ty in both calculated cases.', 47.82, 582.15, 235, 8.97, 'body', true],
      ['(a) Input strength. (b) Calculated response.', 47.82, 571.24, 200, 8.97, 'body', true]
    ] as const
    const items: PdfLayoutTextItem[] = rows.map(([str, x, y, width, height, fontName, hasEOL]) => ({
      str,
      dir: 'ltr',
      width,
      height,
      transform: [height, 0, 0, height, x + (str === 'exp' ? shift : 0), y],
      fontName,
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false,
      hasEOL
    }))
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const caption = units.find((unit) => unit.source.startsWith('Fig. 1.'))
    expect(caption?.source.includes('0.35 exp(−0.002t2)')).toBe(!shift)
    if (!shift) expect(caption?.items).toHaveLength(rows.length)
  }
)
