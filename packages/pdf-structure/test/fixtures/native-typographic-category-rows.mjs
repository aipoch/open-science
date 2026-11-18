/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import {
  PDFDocument,
  StandardFonts,
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

export async function categoryFixture(mode = 'base') {
  const document = await PDFDocument.create({ updateMetadata: false }),
    font = await document.embedFont(StandardFonts.TimesRoman),
    page = document.addPage([600, 360]),
    scale = 1.5,
    fontName = page.node.newFontDictionary('Main', font.ref)
  const text = (value, x, y, size = 8.9664) =>
    page.pushOperators(
      beginText(),
      setFillingRgbColor(
        ...(mode === 'white-category' && value.includes('CATEGORIES') ? [1, 1, 1] : [0, 0, 0])
      ),
      setFontAndSize(fontName, size),
      setTextMatrix(1, 0, 0, 1, x, 360 - y),
      showText(font.encodeText(value)),
      endText()
    )
  const xs = [60, 150, 230, 310, 390, 470]
  for (let i = 0; i < 6; i++)
    text(['Method', 'Space', 'Dynamics', 'Path', 'Training', 'Generation'][i], xs[i], 86)
  text('INDEPENDENT CATEGORIES', 60, 105, 10.9091)
  if (mode !== 'single-role')
    text('DIFFERENT CATEGORIES', mode === 'shifted-role' ? 61 : 60, 165, 10.9091)
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 6; c++)
      text(
        (c ? 'Field ' + c : 'Item') + ' ' + String.fromCharCode(65 + r),
        xs[c],
        [120, 135, 180, 195][r]
      )
  for (const y of mode === 'missing-rail' ? [74, 210] : [74, 91, 210])
    page.pushOperators(
      pushGraphicsState(),
      setStrokingRgbColor(
        ...(mode === 'white-rails'
          ? [1, 1, 1]
          : mode === 'gray-rails'
            ? [0.3, 0.3, 0.3]
            : [0, 0, 0])
      ),
      setLineWidth(0.4),
      setDashPattern([], 0),
      moveTo(50, 360 - y),
      lineTo(550, 360 - y),
      stroke(),
      popGraphicsState()
    )
  if (mode === 'foreign-field') text('Separate value', 390, 105)
  if (mode === 'section-links') {
    const numberFont = await document.embedFont(StandardFonts.Helvetica),
      numberName = page.node.newFontDictionary('LinkNumber', numberFont.ref)
    for (const [heading, y, number] of [
      ['INDEPENDENT CATEGORIES', 105, '1.1'],
      ['DIFFERENT CATEGORIES', 165, '2']
    ]) {
      const x = 60 + font.widthOfTextAtSize(heading, 10.9091) + 12.06
      text('§', x, y)
      page.pushOperators(
        beginText(),
        setFillingRgbColor(0, 0, 0),
        setFontAndSize(numberName, 8.9664),
        setTextMatrix(1, 0, 0, 1, x + font.widthOfTextAtSize('§', 8.9664), 360 - y),
        showText(numberFont.encodeText(number)),
        endText()
      )
    }
  }
  if (mode === 'foreign-paint') page.drawRectangle({ x: 390, y: 360 - 104, width: 8, height: 3 })
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
    table = {
      id: 'page-1-anonymous-category',
      readingRotation: 0,
      cropRect: [75, 105, 825, 321],
      rowCount: mode === 'mixed' ? 6 : 7,
      columnCount: 6,
      grid: Array.from({ length: mode === 'mixed' ? 6 : 7 }, () => Array(6).fill('')),
      spans: [],
      unassigned: [],
      structure: {
        objects: [
          ...[
            [50, 140],
            [140, 220],
            [220, 300],
            [300, 380],
            [380, 460],
            [460, 550]
          ].map(([left, right]) => ({
            label: 'table column',
            score: 1,
            rect: [left * 1.5 - 75, 0, right * 1.5 - 75, 216]
          })),
          { label: 'table column header', score: 1, rect: [0, 10, 750, 33] },
          ...(mode === 'mixed'
            ? [
                [115, 138],
                [147, 185],
                [195, 211],
                [237, 253],
                [264, 278],
                [285, 301]
              ]
            : [
                [115, 138],
                [147, 163],
                [174, 185],
                [195, 211],
                [237, 253],
                [264, 278],
                [285, 301]
              ]
          ).map(([top, bottom]) => ({
            label: 'table row',
            score: 1,
            rect: [0, top - 105, 750, bottom - 105]
          }))
        ]
      }
    }
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
