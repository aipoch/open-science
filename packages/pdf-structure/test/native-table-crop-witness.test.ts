import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument, OPS, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'

const { collectGraphicsBounds, collectTableRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const {
  captureNativeFigureRenderContext,
  matchNativeFigureRenderContext,
  recordPaintedOperationBounds
} = await import(pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href)
const { captureNativeTableCropWitness: capture } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-table-crop-witness.mjs')).href
)
const {
  proveNativeTableCaptionStrip: proveHeader,
  renderNativeTableCaptionStrip: renderHeader,
  commitNativeTableCaptionStrip: commitHeader
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-table-caption-strip.mjs')).href
)
const { renderPdfCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const pdfjs = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const font = await readFile(join(pdfjs, 'standard_fonts', 'LiberationSans-Regular.ttf'))

type NativePageContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type NativeSourceContent = NativePageContent & {
  items: (NativePageContent['items'][number] & {
    sourceItem: { pageNumber: number; index: number; text: string }
  })[]
}
type NativePageEvidence = {
  page: PDFPageProxy
  viewport: ReturnType<PDFPageProxy['getViewport']>
  native: ReturnType<typeof matchNativeFigureRenderContext>
  sourceContent: NativeSourceContent
  operators: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>
  rules: ReturnType<typeof collectTableRules>
  context: {
    nativeGlyphContext: NativePageEvidence['native']
    viewport: NativePageEvidence['viewport']
    operators: NativePageEvidence['operators']
    rulePaintBounds: Map<string, number[]>
    sourceContent: NativeSourceContent
    content: NativeSourceContent
  }
  options: {
    page: ReturnType<typeof collectGraphicsBounds> & {
      pageNumber: number
      width: number
      height: number
    }
    nativePage: PDFPageProxy
    nativeContent: NativePageContent
  }
}

async function renderNativePage(
  task: ReturnType<typeof getDocument>,
  data: Uint8Array
): Promise<NativePageEvidence> {
  const checksum = createHash('sha256').update(data).digest('hex')
  const document = await task.promise
  const page = await document.getPage(1)
  const content = await page.getTextContent()
  const viewport = page.getViewport({ scale: 1, rotation: 0 })
  const canvas = createCanvas(200, 200)
  const render = page.render({
    canvas,
    canvasContext: canvas.getContext('2d'),
    viewport,
    recordOperations: true
  })
  recordPaintedOperationBounds(render)
  await render.promise
  const graphics = collectGraphicsBounds(render, page.recordedBBoxes)
  const handle = captureNativeFigureRenderContext(
    render,
    1,
    content,
    viewport,
    graphics.graphicsBounds,
    checksum,
    page.commonObjs
  )
  const native = matchNativeFigureRenderContext(
    handle,
    1,
    content,
    viewport,
    graphics.graphicsBounds,
    checksum
  )
  const sourceContent = {
    ...content,
    items: content.items.map((item, index) => ({
      ...item,
      sourceItem: { pageNumber: 1, index, text: 'str' in item ? item.str : '' }
    }))
  }
  const operators = await page.getOperatorList()
  const rulePaintBounds = new Map<string, number[]>()
  const rules = collectTableRules(operators, viewport, rulePaintBounds)
  const context = {
    nativeGlyphContext: native,
    viewport,
    operators,
    rulePaintBounds,
    sourceContent,
    content: sourceContent
  }
  const options = {
    page: { pageNumber: 1, width: 200, height: 200, ...graphics },
    nativePage: page,
    nativeContent: content
  }
  return { page, viewport, native, sourceContent, operators, rules, context, options }
}

it.each([
  'ruled',
  'ruled-caps-state',
  'ruled-clean-state-clip',
  'ruled-state-alpha',
  'ruled-state-blend',
  'ruled-clip-cut'
])(
  'preserves the complete physical ruled body with unchanged scalar evidence (%s)',
  async (scenario) => {
    const data = pdf(false, scenario)
    const task = getDocument({
      data,
      isEvalSupported: false,
      fontExtraProperties: true,
      useSystemFonts: false,
      standardFontDataUrl: join(pdfjs, 'standard_fonts') + '/'
    })
    try {
      const { page, rules, context, options } = await renderNativePage(task, data)
      const witness = capture({ page: 1 }, context, options, 'closed-ruled-body')
      if (scenario.includes('blend') || scenario.includes('cut')) {
        if (!witness) return
      }
      expect(witness).toBeTruthy()
      const captionRecord = witness.records.find((r) => r.text === 'Table 1. Values'),
        body = witness.records.filter((r) => r !== captionRecord),
        clean = scenario.includes('clean'),
        owned = clean ? body : body.slice(4),
        caption = {
          page: 1,
          text: captionRecord.text,
          lines: [captionRecord.text],
          rect: captionRecord.sourceRect
        },
        table = {
          page: 1,
          cropRect: [30, 40, 160, 140],
          sourceViewport: { width: 200, height: 200, scale: 1 },
          caption,
          grid: Array.from({ length: clean ? 4 : 3 }, () => Array(4).fill('A')),
          cells: owned.map((r, i) => ({
            row: Math.floor(i / 4),
            column: i % 4,
            rowSpan: 1,
            colSpan: 1,
            text: r.text,
            sourceItems: [{ pageNumber: 1, index: r.index, text: r.text }],
            sourceRects: [r.sourceRect]
          })),
          unassigned: clean
            ? []
            : body.slice(0, 4).map((r) => ({ text: r.text, rect: r.sourceRect })),
          clipped: [],
          selectedTextItems: body.length,
          issues: clean ? [] : ['unassigned-source-text']
        },
        proof = proveHeader(table, rules, context, {
          ...options,
          captions: [caption],
          competingRects: [],
          otherFigures: []
        })
      if (scenario.includes('alpha') || scenario.includes('blend') || scenario.includes('cut')) {
        expect(proof).toBeUndefined()
        return
      }
      expect(proof).toBeTruthy()
      expect(proof.nativeCrop[2]).toBeGreaterThanOrEqual(170)
      expect(proof.nativeCrop[3]).toBeGreaterThanOrEqual(145.2)
      expect(proof.regions[0][1]).toBeLessThan(40)
      const png = await renderHeader(proof, (rect, regions) =>
        renderPdfCrop(page, rect, 0, regions)
      )
      expect(png?.length).toBeGreaterThan(0)
      const result = commitHeader(proof, png)
      expect(result.cells).toBe(table.cells)
      expect(result.grid).toBe(table.grid)
      expect(result.issues).toBe(table.issues)
      expect(result.unassigned).toBe(table.unassigned)
      expect(result.caption).toBe(table.caption)
    } finally {
      await task.destroy()
    }
  }
)
// ASCII 32..122 advances (1000-em units) from the embedded
// pdfjs-dist standard_fonts/LiberationSans-Regular.ttf fixture above.
const panelWidths = [
  277.83203125, 277.83203125, 354.98046875, 556.15234375, 556.15234375, 889.16015625, 666.9921875,
  190.91796875, 333.0078125, 333.0078125, 389.16015625, 583.984375, 277.83203125, 333.0078125,
  277.83203125, 277.83203125, 556.15234375, 556.15234375, 556.15234375, 556.15234375, 556.15234375,
  556.15234375, 556.15234375, 556.15234375, 556.15234375, 556.15234375, 277.83203125, 277.83203125,
  583.984375, 583.984375, 583.984375, 556.15234375, 1015.13671875, 666.9921875, 666.9921875,
  722.16796875, 722.16796875, 666.9921875, 610.83984375, 777.83203125, 722.16796875, 277.83203125,
  500, 666.9921875, 556.15234375, 833.0078125, 722.16796875, 777.83203125, 666.9921875,
  777.83203125, 722.16796875, 666.9921875, 610.83984375, 722.16796875, 666.9921875, 943.84765625,
  666.9921875, 666.9921875, 610.83984375, 277.83203125, 277.83203125, 277.83203125, 469.23828125,
  556.15234375, 333.0078125, 556.15234375, 556.15234375, 500, 556.15234375, 556.15234375,
  277.83203125, 556.15234375, 556.15234375, 222.16796875, 222.16796875, 500, 222.16796875,
  833.0078125, 556.15234375, 556.15234375, 556.15234375, 556.15234375, 333.0078125, 500,
  277.83203125, 556.15234375, 500, 722.16796875, 500, 500, 500
]

it.each([
  'panel',
  'panel-clipped',
  'panel-missing-rule',
  'panel-foreign-text',
  'panel-foreign-paint',
  'panel-image-overlap',
  'panel-duplicate-title',
  'panel-font-drift',
  'panel-source-drift',
  'panel-paint-drift',
  'panel-extra-frame'
])(
  'restores only a complete native title above its independent ruled panel (%s)',
  async (scenario) => {
    const data = pdf(false, scenario),
      task = getDocument({
        data,
        isEvalSupported: false,
        fontExtraProperties: true,
        useSystemFonts: false
      })
    try {
      const { page, viewport, native, sourceContent, rules, context, options } =
        await renderNativePage(task, data)
      const tokens = sourceContent.items
          .filter((i) => i.str?.trim())
          .map((i) => tableTextToken(i, viewport, 0)),
        records = tokens.filter((r) => r.rect[1] > 40 && r.rect[3] < 130),
        table = {
          page: 1,
          cropRect: [28, scenario === 'panel-clipped' ? 29 : 38, 172, 132],
          sourceViewport: { width: 200, height: 200, scale: 1 },
          selectedTextItems: records.length,
          issues: ['native-table-structure-ambiguous'],
          unassigned: [],
          clipped: [],
          grid: [
            ['A', 'A'],
            ['A', 'A']
          ],
          cells: records.map((r, i) => ({
            row: Math.floor(i / 2),
            column: i % 2,
            rowSpan: 1,
            colSpan: 1,
            text: r.text,
            sourceRects: [r.rect],
            sourceItems: [r.sourceItem]
          }))
        },
        proof = proveHeader(table, rules, context, {
          ...options,
          captions: [],
          otherFigures: [],
          competingRects: []
        })
      if (
        [
          'panel-missing-rule',
          'panel-foreign-text',
          'panel-foreign-paint',
          'panel-image-overlap',
          'panel-duplicate-title'
        ].includes(scenario)
      ) {
        expect(proof).toBeUndefined()
        return
      }
      expect(proof).toBeTruthy()
      expect(proof.nativeCrop[1]).toBeLessThan(tokens[0].rect[3])
      const drift = scenario.endsWith('drift'),
        png = await renderHeader(proof, async (rect, regions) => {
          const bytes = await renderPdfCrop(page, rect, 0, regions)
          if (scenario === 'panel-font-drift')
            page.commonObjs.get(native.glyphBounds[0].fontName).disableFontFace = false
          if (scenario === 'panel-source-drift')
            sourceContent.items[0] = { ...sourceContent.items[0] }
          if (scenario === 'panel-paint-drift')
            native.operators.argsArray[native.operators.fnArray.indexOf(OPS.setLineWidth)][0] += 1
          return bytes
        })
      if (drift) {
        expect(png).toBeUndefined()
        return
      }
      expect(png?.length).toBeGreaterThan(0)
      const next = commitHeader(proof, png)
      for (const key of ['cells', 'grid', 'issues', 'unassigned', 'clipped'])
        expect(next[key]).toBe(table[key])
    } finally {
      await task.destroy()
    }
  }
)

it.each(['footer', 'footer-image-overlap', 'footer-foreign-text', 'footer-missing-rule'])(
  'retains a sparse terminal band only inside complete native rules (%s)',
  async (scenario) => {
    const data = pdf(false, scenario),
      task = getDocument({
        data,
        isEvalSupported: false,
        fontExtraProperties: true,
        useSystemFonts: false
      })
    try {
      const { page, viewport, native, sourceContent, rules, context, options } =
        await renderNativePage(task, data)
      const tokens = sourceContent.items
          .filter((i) => i.str?.trim())
          .map((i) => tableTextToken(i, viewport, 0)),
        caption = { page: 1, text: 'A', lines: ['A'], rect: tokens[0].rect },
        records = tokens.slice(1, 10),
        table = {
          page: 1,
          cropRect: [28, 38, 172, 121],
          sourceViewport: { width: 200, height: 200, scale: 1 },
          caption,
          selectedTextItems: 11,
          issues: ['unassigned-source-text'],
          unassigned: ['A', 'A'],
          clipped: [],
          grid: [
            ['A', 'A', 'A'],
            ['A', 'A', 'A'],
            ['A', 'A', 'A']
          ],
          cells: records.map((r, i) => ({
            row: Math.floor(i / 3),
            column: i % 3,
            rowSpan: 1,
            colSpan: 1,
            text: r.text,
            sourceRects: [r.rect],
            sourceItems: [r.sourceItem]
          }))
        },
        cropOptions = { ...options, captions: [caption], competingRects: [], otherFigures: [] },
        proof = proveHeader(table, rules, context, cropOptions)
      if (scenario !== 'footer') {
        expect(proof).toBeUndefined()
        return
      }
      expect(proof).toBeTruthy()
      expect(proof.nativeCrop.slice(0, 3)).toEqual([28, 38, 172])
      expect(proof.nativeCrop[3]).toBeGreaterThan(130)
      expect(proof.nativeCrop[3]).toBeLessThan(140)
      const png = await renderHeader(proof, (rect, regions) =>
          renderPdfCrop(page, rect, 0, regions)
        ),
        published = commitHeader(proof, png)
      expect(png?.length).toBeGreaterThan(0)
      for (const key of ['cells', 'grid', 'caption', 'unassigned', 'clipped', 'issues'])
        expect(published[key]).toBe(table[key])
      const source = table.cells[0].sourceItems[0]
      table.cells[0].sourceItems[0] = { ...source }
      expect(commitHeader(proof, png)).toBeUndefined()
      table.cells[0].sourceItems[0] = source
      const pending = proveHeader(table, rules, context, cropOptions)
      expect(pending).toBeTruthy()
      const stale = await renderHeader(pending, async (rect, regions) => {
        const bytes = await renderPdfCrop(page, rect, 0, regions)
        native.operators.argsArray[native.operators.fnArray.indexOf(OPS.paintImageXObject)] = [
          'foreign-replacement',
          1,
          1
        ]
        return bytes
      })
      expect(stale).toBeUndefined()
    } finally {
      await task.destroy()
    }
  }
)

// One original glyph and one independently rendered paint. The two PDFs differ
// only by PDF.js's q / translation / path / Q optimizer input.
function pdf(wrapped: boolean, scenario: string): Uint8Array {
  let stream = scenario.startsWith('header')
    ? [
        '30 180',
        '40 130',
        '65 145',
        '100 145',
        '140 145',
        '40 100',
        '100 100',
        '140 100',
        '40 80',
        '100 80',
        '140 80',
        '40 60',
        '100 60',
        '140 60'
      ]
        .map((p) => `BT /F1 10 Tf ${p} Td (A) Tj ET`)
        .join('\n') + '\n0.4 w 80 40 m 80 160 l S 30 150 m 80 135 l S 30 120 m 170 120 l S\n'
    : 'BT /F1 10 Tf 50 150 Td (A) Tj ET\n' +
      (wrapped ? 'q 1 0 0 1 50 60 cm 0 0 80 20 re f Q' : '50 60 80 20 re f') +
      '\n'
  if (scenario === 'header-foreign-text') stream += 'BT /F1 10 Tf 28 145 Td (A) Tj ET\n'
  if (scenario === 'header-foreign-paint') stream += '28 140 10 10 re f\n'
  if (scenario === 'header-crossing-title') stream += 'BT /F1 10 Tf 100 156 Td (A) Tj ET\n'
  if (scenario === 'header-outside-title') stream += 'BT /F1 10 Tf 100 164 Td (A) Tj ET\n'
  if (scenario === 'header-gap')
    stream = stream.replace('80 40 m 80 160 l S', '80 40 m 80 119 l S 80 121 m 80 160 l S')
  if (scenario === 'header-clipped') stream = 'q 0 0 200 150 re W n\n' + stream + 'Q\n'
  if (scenario.startsWith('footer')) {
    stream =
      [
        [30, 180],
        ...[150, 125, 105].flatMap((y) => [40, 90, 140].map((x) => [x, y])),
        [40, 76],
        [140, 76]
      ]
        .map(([x, y]) => `BT /F1 10 Tf ${x} ${y} Td (A) Tj ET`)
        .join('\n') +
      '\n0.4 w 30 160 m 170 160 l S 30 145 m 170 145 l S 30 90 m 170 90 l S 30 70 m 170 70 l S\n' +
      `q 10 0 0 10 40 ${scenario === 'footer-image-overlap' ? 65 : 40} cm /Im Do Q\n`
    if (scenario === 'footer-foreign-text') stream += 'BT /F1 10 Tf 90 76 Td (A) Tj ET\n'
    if (scenario === 'footer-missing-rule') stream = stream.replace('30 70 m 170 70 l S', '')
  }
  if (scenario.startsWith('panel')) {
    stream =
      'BT /F1 8 Tf 65 166 Td (Panel A: AAA) Tj ET\n' +
      [
        [40, 145],
        [140, 145],
        [40, 90],
        [140, 90]
      ]
        .map(([x, y]) => `BT /F1 10 Tf ${x} ${y} Td (A) Tj ET`)
        .join('\n') +
      '\n0.4 w 30 160 m 170 160 l S 30 135 m 170 135 l S 30 70 m 170 70 l S\n' +
      `q 10 0 0 10 40 ${scenario === 'panel-image-overlap' ? 161 : 40} cm /Im Do Q\n`
    if (scenario === 'panel-extra-frame')
      stream += '30 30 m 170 30 l S 30 20 m 170 20 l S 30 10 m 170 10 l S'
    if (scenario === 'panel-missing-rule') stream = stream.replace('30 70 m 170 70 l S', '')
    if (scenario === 'panel-foreign-text') stream += 'BT /F1 10 Tf 30 166 Td (A) Tj ET\n'
    if (scenario === 'panel-duplicate-title')
      stream += 'BT /F1 8 Tf 65 166 Td (Panel A: AAA) Tj ET\n'
    if (scenario === 'panel-foreign-paint') stream += '30 163 10 5 re f\n'
  }
  if (scenario.startsWith('ruled')) {
    stream = 'BT /F1 10 Tf 30 180 Td (Table 1. Values) Tj ET\n'
    if (scenario.includes('caps')) stream = 'BT /F1 12 Tf 30 162 Td (Table 1. Values) Tj ET\n'
    if (scenario.includes('state')) stream += '/GS gs\n'
    for (const y of [150, 125, 100, 75])
      for (const x of [40, 75, 110, 145]) {
        const clipped = scenario.includes('clip')
        if (clipped)
          stream += `q ${x - 1} ${y + (scenario.includes('cut') ? 1 : -0.05)} 12 12 re W n\n`
        const text =
          scenario.includes('caps') && y === 150
            ? `\\(${[40, 75, 110, 145].indexOf(x) + 1}\\)`
            : 'A'
        stream += `BT /F1 10 Tf ${x} ${y} Td (${text}) Tj ET\n`
        if (clipped) stream += 'Q\n'
      }
    stream += '0.4 w 30 160 m 170 160 l S 30 140 m 170 140 l S 30 55 m 170 55 l S\n'
    if (scenario.includes('caps'))
      stream =
        stream.replace(
          '30 160 m 170 160 l S',
          '30 159.52 30 0.96 re f 60 159.52 0.96 0.96 re f 60.96 159.52 109.04 0.96 re f'
        ) + '30 90 m 170 90 l S\n'
  }
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> /XObject << /Im 8 0 R >> /ExtGState << /GS << /BM /${scenario.includes('blend') ? 'Multiply' : 'Normal'} /ca ${scenario.includes('alpha') ? '0.5' : '1'} /CA 1 >> >> >> /Contents 5 0 R >>`,
    scenario.startsWith('panel') || scenario.startsWith('ruled')
      ? `<< /Type /Font /Subtype /TrueType /BaseFont /LiberationSans /FirstChar 32 /LastChar 122 /Widths [${panelWidths.join(' ')}] /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>`
      : '<< /Type /Font /Subtype /TrueType /BaseFont /LiberationSans /FirstChar 65 /LastChar 65 /Widths [667] /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    '<< /Type /FontDescriptor /FontName /LiberationSans /Flags 32 /FontBBox [-544 -303 1302 980] /ItalicAngle 0 /Ascent 905 /Descent -212 /CapHeight 688 /StemV 80 /FontFile2 7 0 R >>',
    `<< /Length ${font.length} /Length1 ${font.length} >>\nstream\n${font.toString('latin1')}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nff0000>\nendstream'
  ]
  let result = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(result.length)
    result += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = result.length
  result +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
      .join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Uint8Array.from(Buffer.from(result, 'latin1'))
}

it.each([
  'flat',
  'wrapped',
  'header',
  'header-foreign-text',
  'header-foreign-paint',
  'header-crossing-title',
  'header-outside-title',
  'header-clipped',
  'header-gap'
])('binds actual API and rendered paint occurrences (%s)', async (scenario) => {
  const wrapped = scenario === 'wrapped',
    header = scenario.startsWith('header')
  const data = pdf(wrapped, scenario)
  const task = getDocument({
    data,
    isEvalSupported: false,
    fontExtraProperties: true,
    useSystemFonts: false,
    standardFontDataUrl: join(pdfjs, 'standard_fonts') + '/'
  })
  try {
    const { page, native, sourceContent, operators, rules, context, options } =
      await renderNativePage(task, data)
    expect(native).toBeTruthy()
    const table = {
      page: 1,
      cells: [],
      grid: [],
      unassigned: [],
      clipped: [],
      cropRect: [40, 40, 140, 160]
    }
    if (!header)
      expect(operators.fnArray.length - native.operators.fnArray.length).toBe(wrapped ? 3 : 0)
    const witness = capture(table, context, options, 'closed-ruled-body')
    expect(witness).toBeTruthy()
    expect(witness.current()).toBe(true)

    if (header) {
      const records = witness.records.filter((r) => r.sourceRect[1] > 80)
      const caption = { page: 1, text: 'A', lines: ['A'], rect: witness.records[0].sourceRect }
      const body = {
        ...table,
        cropRect: [30, 80, 170, 160],
        sourceViewport: { width: 200, height: 200, scale: 1 },
        caption,
        selectedTextItems: records.length,
        issues: ['text-crosses-crop-boundary'],
        grid: [
          ['A', 'A', 'A'],
          ['A', 'A', 'A'],
          ['A', 'A', 'A']
        ],
        cells: records.map((r, i) => ({
          row: Math.floor(i / 3),
          column: i % 3,
          rowSpan: 1,
          colSpan: 1,
          text: r.text,
          sourceRects: [r.sourceRect],
          sourceItems: [{ pageNumber: 1, index: r.index, text: r.text }]
        }))
      }
      const headerOptions = {
        ...options,
        captions: [caption],
        otherFigures: [],
        competingRects: []
      }
      const proof = proveHeader(body, rules, context, headerOptions)
      if (!['header', 'header-outside-title'].includes(scenario)) {
        expect(proof).toBeUndefined()
        return
      }
      expect(proof).toBeTruthy()
      expect(proof.nativeCrop[1]).toBeLessThanOrEqual(40)
      expect(proof.nativeCrop[1]).toBeGreaterThan(caption.rect[3])
      expect(proof.nativeCrop[3]).toBeLessThan(162)
      const png = await renderHeader(proof, (rect, regions) =>
        renderPdfCrop(page, rect, 0, regions)
      )
      expect(png?.length).toBeGreaterThan(0)
      const published = commitHeader(proof, png)
      expect(published.cells).toBe(body.cells)
      expect(published.caption).toBe(body.caption)
      expect(published.issues).toBe(body.issues)
      expect(published.grid).toBe(body.grid)
      expect(published.cropRect).toEqual(proof.cropRect)

      // Identical replacement objects still invalidate retained native owners.
      const item = body.cells[0].sourceItems[0]
      body.cells[0].sourceItems[0] = { ...item }
      expect(commitHeader(proof, png)).toBeUndefined()
      body.cells[0].sourceItems[0] = item

      const pending = proveHeader(body, rules, context, headerOptions)
      expect(pending).toBeTruthy()
      const stale = await renderHeader(pending, async (rect, regions) => {
        const image = await renderPdfCrop(page, rect, 0, regions)
        if (scenario === 'header-outside-title')
          page.commonObjs.get(native.glyphBounds[0].fontName).disableFontFace = false
        else sourceContent.items[0].sourceItem.index = 99
        return image
      })
      expect(stale).toBeUndefined()
      expect(commitHeader(pending, png)).toBeUndefined()
      return
    }

    // A changed path, even with unchanged bbox and operation count, is foreign.
    const path = operators.fnArray.indexOf(OPS.constructPath)
    const coordinate = operators.argsArray[path][1][0][1]
    operators.argsArray[path][1][0][1] += 1
    expect(witness.current()).toBe(false)
    expect(capture(table, context, options, 'closed-ruled-body')).toBeUndefined()
    operators.argsArray[path][1][0][1] = coordinate

    const originalPath = operators.argsArray[path]
    operators.argsArray[path] = structuredClone(originalPath)
    expect(witness.current()).toBe(false)
    operators.argsArray[path] = originalPath
    if (wrapped) {
      const transform = operators.fnArray.indexOf(OPS.transform)
      operators.argsArray[transform][4] += 1
      expect(capture(table, context, options, 'closed-ruled-body')).toBeUndefined()
      operators.argsArray[transform][4] -= 1
    }
    const fontOperation = operators.fnArray.indexOf(OPS.setFont)
    const fontName = operators.argsArray[fontOperation][0]
    operators.argsArray[fontOperation][0] = 'unbound-font'
    expect(capture(table, context, options, 'closed-ruled-body')).toBeUndefined()
    operators.argsArray[fontOperation][0] = fontName

    // The bridge cannot consume an extra occurrence or changed source identity.
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push(operators.argsArray[path])
    expect(capture(table, context, options, 'closed-ruled-body')).toBeUndefined()
    operators.fnArray.pop()
    operators.argsArray.pop()
    sourceContent.items[0].sourceItem.index = 9
    expect(witness.current()).toBe(false)
    expect(capture(table, context, options, 'closed-ruled-body')).toBeUndefined()
  } finally {
    await task.destroy()
  }
})
