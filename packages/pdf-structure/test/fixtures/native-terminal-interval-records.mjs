/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import {
  PDFDocument,
  StandardFonts,
  PDFHexString,
  pushGraphicsState,
  popGraphicsState,
  setStrokingRgbColor,
  setFillingRgbColor,
  setLineWidth,
  setDashPattern,
  moveTo,
  lineTo,
  stroke,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  showText
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  captureNativeFigureRenderContext,
  matchNativeFigureRenderContext,
  bindNativeMesh4RenderContext,
  recordPaintedOperationBounds
} from '../../resources/literature-pdf-render-bounds.mjs'
import {
  collectGraphicsBounds,
  collectTableRules
} from '../../resources/literature-pdf-graphics.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
import { nativeFigureLabelBounds } from '../../resources/literature-pdf-figure-crop-geometry.mjs'
import {
  findCaptionCandidates,
  projectPdfTextLines
} from '../../resources/literature-pdf-caption-group.mjs'
import { createNativeTableFontRoleWitness } from '../../resources/literature-pdf-native-table-font-role.mjs'

// A generated three-record PDF with real native text and segmented dividers.
// The detector proposals below are explicit test inputs, not ONNX predictions.
export async function terminalIntervalFixture(mode = 'base') {
  const document = await PDFDocument.create(),
    font = await document.embedFont(StandardFonts.TimesRoman),
    page = document.addPage([600, 240]),
    cuts = [50, 140, 235, 330, 420, 550],
    baselines = [114, 126.2, 138.4],
    scale = 1.5,
    fontName = page.node.newFontDictionary('Main', font.ref)
  const text = (value, x, y, size = 10) =>
    page.pushOperators(
      beginText(),
      setFillingRgbColor(...(mode === 'white-text' && y > 128 ? [1, 1, 1] : [0, 0, 0])),
      setFontAndSize(fontName, size),
      setTextMatrix(1, 0, 0, 1, x, 240 - y),
      showText(font.encodeText(value)),
      endText()
    )
  const rule = (x0, y0, x1, y1) =>
    page.pushOperators(
      pushGraphicsState(),
      setStrokingRgbColor(...(mode === 'white-dividers' ? [1, 1, 1] : [0, 0, 0])),
      setLineWidth(0.4),
      setDashPattern([], 0),
      moveTo(x0, 240 - y0),
      lineTo(x1, 240 - y1),
      stroke(),
      popGraphicsState()
    )
  text('Table 1: Neutral grouped examples', 50, 52)
  text('Case', 60, 94)
  for (const [x, name] of [
    [150, 'Data'],
    [250, 'Transport'],
    [350, 'Symmetry']
  ]) {
    text(name, x, 88)
    text('Group', x, 100)
  }
  text('Action', 440, 94)
  rule(50, 104, 550, 104)
  for (const x of cuts.slice(1, -1)) {
    rule(x, 80, x, 103.8)
    for (let row = 0; row < 3; row++) {
      if (mode === 'missing-divider' && row === 2 && x === 330) continue
      const cut = mode === 'shifted-divider' && row === 2 && x === 330 ? x + 2 : x,
        bottom = 116.3 + row * 12.2 - (mode === 'unequal-ends' && row === 2 && x === 330 ? 0.5 : 0)
      rule(cut, mode === 'overlap-baseline' && row === 2 ? 125 : 104.4 + row * 12.2, cut, bottom)
    }
  }
  if (mode === 'extra-divider') rule(380, 128.8, 380, 140.7)
  if (mode === 'footer') rule(50, 141.1, 550, 141.1)
  for (const [index, y] of baselines.entries()) {
    const label =
      index === 2 && mode === 'continuation'
        ? 'continued label'
        : `${index === 2 && mode === 'ordinal-gap' ? 4 : index + 1}. Case ${String.fromCharCode(65 + index)}`
    text(label, 60, y)
    text('R', 160, y)
    text('n', 168, y - 3.6, 6.7)
    text('(R', 250, y)
    text('n', 263, y - 3.6, 6.7)
    text(', +)', 268, y)
    text('S', 350, y)
    text('n', 357, y - 3.6, 6.7)
    text('Neutral action ' + String.fromCharCode(65 + index), 440, y)
  }
  if (mode === 'crossing-token') text('Crossing source', 225, 138.4)
  if (mode === 'extra-token') text('Foreign note', 440, 142.4)
  if (mode === 'competing-caption') text('Table 2: Other examples', 50, 143)
  if (mode.startsWith('foreign-zero') || mode === 'claimed-zero') {
    const reference = document.context.register(
      document.context.obj({
        Type: 'Font',
        Subtype: 'Type1',
        BaseFont: 'Times-Roman',
        Encoding: 'WinAnsiEncoding',
        FirstChar: 88,
        LastChar: 88,
        Widths: [0]
      })
    )
    const name = page.node.newFontDictionary('ZeroAdvance', reference),
      y = mode === 'foreign-zero-outside' ? 25 : 138.4
    page.pushOperators(
      beginText(),
      setFontAndSize(name, 10),
      setTextMatrix(1, 0, 0, 1, 450, 240 - y),
      showText(PDFHexString.of('58')),
      endText()
    )
  }
  const bytes = await document.save({ useObjectStreams: false }),
    checksum = createHash('sha256').update(bytes).digest('hex'),
    assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    task = getDocument({
      data: new Uint8Array(bytes),
      fontExtraProperties: true,
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
      standardFontDataUrl: join(assets, 'standard_fonts') + '/',
      cMapUrl: join(assets, 'cmaps') + '/',
      cMapPacked: true,
      wasmUrl: join(assets, 'wasm') + '/'
    })
  const nativeDocument = await task.promise,
    nativePage = await nativeDocument.getPage(1),
    content = await nativePage.getTextContent(),
    operators = await nativePage.getOperatorList(),
    nativeViewport = nativePage.getViewport({ scale: 1 }),
    viewport = nativePage.getViewport({ scale }),
    canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)),
    rendering = nativePage.render({
      canvas,
      canvasContext: canvas.getContext('2d'),
      viewport,
      recordOperations: true
    })
  recordPaintedOperationBounds(rendering)
  await rendering.promise
  const graphics = collectGraphicsBounds(rendering, nativePage.recordedBBoxes),
    sourcePage = {
      pageNumber: 1,
      width: nativeViewport.width,
      height: nativeViewport.height,
      rotation: 0,
      renderRotation: 0,
      structureRoles: {},
      lines: projectPdfTextLines(content, nativeViewport),
      ...graphics
    },
    snapshot = captureNativeFigureRenderContext(
      rendering,
      1,
      content,
      nativeViewport,
      graphics.graphicsBounds,
      checksum,
      nativePage.commonObjs
    ),
    matched = matchNativeFigureRenderContext(
      snapshot,
      1,
      content,
      nativeViewport,
      graphics.graphicsBounds,
      checksum
    )
  assert(matched, 'The anonymous fixture must have a genuine current native render')
  const nativePageContext = bindNativeMesh4RenderContext(
      { ...matched, pageNumber: 1, sourceSha256: checksum },
      matched
    ),
    nativeGlyphContext = bindNativeMesh4RenderContext({ ...nativePageContext }, nativePageContext),
    sourceContent = {
      ...content,
      items: content.items.map((item, index) =>
        'str' in item ? { ...item, sourceItem: { pageNumber: 1, index, text: item.str } } : item
      )
    },
    project = (metrics) =>
      sourceContent.items
        .filter((r) => r.str?.trim())
        .map((r) => ({
          ...tableTextToken(r, viewport, 0),
          ...(metrics
            ? {
                fontAscent: content.styles[r.fontName]?.ascent,
                fontDescent: content.styles[r.fontName]?.descent,
                nativeLabelRect: nativeFigureLabelBounds(r, content.styles[r.fontName], viewport)
              }
            : {})
        })),
    tokens = project(false),
    nativeTokens = project(true).map((t) => ({
      ...t,
      rect: t.rect.map((v) => v / scale),
      nativeLabelRect: t.nativeLabelRect?.map((v) => v / scale),
      baseline: t.baseline / scale,
      height: t.height / scale
    })),
    paint = new Map(),
    rules = collectTableRules(operators, viewport, paint),
    captions = findCaptionCandidates([sourcePage]).map((c) => ({
      ...c,
      rect: c.rect.map((v) => v * scale)
    })),
    evidence = graphics.graphicsBounds.map((g) => ({
      kind: g.kind,
      rect: g.normalizedRect.map(
        (v, n) => v * (n % 2 ? sourcePage.height : sourcePage.width) * scale
      )
    })),
    context = {
      sourcePage,
      nativeGlyphContext,
      nativePaintIdentityGraphics: evidence.map((g, n) => ({
        ...g,
        operationIndex: graphics.graphicsBounds[n].operationIndex
      })),
      operators,
      viewport,
      sourceContent,
      content: sourceContent,
      captions,
      rulePaintBounds: paint,
      nativeEvidenceGraphics: evidence
    },
    witness = createNativeTableFontRoleWitness(sourcePage, nativeTokens, nativePageContext),
    count = mode === 'detected' ? 3 : 2,
    table = {
      id: 'generated-table',
      readingRotation: 0,
      cropRect: [75, 120, 825, 221.1],
      rowCount: count,
      columnCount: 5,
      spans: [],
      grid: baselines
        .slice(0, count)
        .map((_, n) => [
          `${n + 1}. Case ${String.fromCharCode(65 + n)}`,
          'R n',
          '(R n, +)',
          'S n',
          `Neutral action ${String.fromCharCode(65 + n)}`
        ]),
      unassigned: [],
      structure: {
        objects: [
          ...cuts.slice(1).map((right, n) => ({
            label: 'table column',
            score: 1,
            rect: [(cuts[n] - 50) * scale, 24.4 * scale, (right - 50) * scale, 48.5 * scale]
          })),
          ...baselines.slice(0, count).map((_, n) => ({
            label: 'table row',
            score: 1,
            rect: [0, (24.4 + n * 12.2) * scale, 750, (36.3 + n * 12.2) * scale]
          }))
        ]
      }
    }
  if (mode === 'alias-outside-crop') {
    const original = tokens.find((t) => t.text === '3. Case C')
    tokens.push({ ...original, rect: original.rect.map((v, n) => (n % 2 ? v : v + 1000)) })
  }
  if (mode === 'spanning-cell')
    table.structure.objects.push({
      label: 'table spanning cell',
      score: 1,
      rect: [0, 36 * scale, 185 * scale, 64 * scale]
    })
  if (mode === 'stale-context')
    nativeGlyphContext.content.items.find((r) => r.str === '3. Case C').str = 'Changed source'
  return {
    bytes,
    table,
    tokens,
    captions,
    rules,
    paint,
    context,
    witness,
    sourcePage,
    nativeGlyphContext,
    dispose: async () => {
      canvas.width = canvas.height = 1
      await task.destroy()
    }
  }
}
