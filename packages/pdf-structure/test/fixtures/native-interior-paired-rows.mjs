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

export async function interiorPairFixture(mode = 'base') {
  const document = await PDFDocument.create({ updateMetadata: false }),
    font = await document.embedFont(StandardFonts.TimesRoman),
    page = document.addPage([600, 240]),
    scale = 1.5,
    fontName = page.node.newFontDictionary('Main', font.ref),
    baselines =
      mode === 'aggregate-next' ? [100, 110.46, 120.921, 131.382] : [100, 110.46, 120.921],
    fields = baselines.map((_, i) => [
      'Entry ' + String.fromCharCode(65 + i),
      mode === 'plain-prose'
        ? 'Value ' + String.fromCharCode(65 + i)
        : 'Author ' + String.fromCharCode(65 + i) + ' 200' + (i + 1) + '[' + (i + 1) + ']'
    ])
  const text = (value, x, y, size = 8.9664) => {
    const white = mode === 'white-source' && (value === fields[1][0] || value === fields[1][1])
    page.pushOperators(
      beginText(),
      setFillingRgbColor(...(white ? [1, 1, 1] : [0, 0, 0])),
      setFontAndSize(fontName, size),
      setTextMatrix(1, 0, 0, 1, x, 240 - y)
    )
    if (mode === 'multi-show') {
      const cut = Math.floor(value.length / 2)
      page.pushOperators(
        showText(font.encodeText(value.slice(0, cut))),
        showText(font.encodeText(value.slice(cut)))
      )
    } else page.pushOperators(showText(font.encodeText(value)))
    page.pushOperators(endText())
  }
  if (mode === 'column-major') {
    for (let col = 0; col < 2; col++)
      for (let row = 0; row < baselines.length; row++)
        text(fields[row][col], col ? 300 : 60, baselines[row])
  } else
    for (let row = 0; row < baselines.length; row++)
      for (let col = 0; col < 2; col++) text(fields[row][col], col ? 300 : 60, baselines[row])
  text('Entry', 60, 86)
  text('Reference', 300, 86)
  const rail = (y) =>
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
      moveTo(50, 240 - y),
      lineTo(550, 240 - y),
      stroke(),
      popGraphicsState()
    )
  if (mode !== 'no-rails')
    for (const y of [74, 91, mode === 'aggregate-next' ? 140 : 129.5]) rail(y)
  if (mode === 'foreign-leading') text('z', 270, 102.6, 1)
  if (mode === 'same-text-unassigned') text(fields[1][1], 300, 128)
  if (mode === 'foreign-zero') {
    const ref = document.context.register(
        document.context.obj({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: 'Times-Roman',
          Encoding: 'WinAnsiEncoding',
          FirstChar: 88,
          LastChar: 88,
          Widths: [0]
        })
      ),
      name = page.node.newFontDictionary('Zero', ref)
    page.pushOperators(
      beginText(),
      setFontAndSize(name, 8.9664),
      setTextMatrix(1, 0, 0, 1, 270, 240 - 110.46),
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
    bands =
      mode === 'gap'
        ? [
            [140.0915925960541, 156.7571356754303, 1],
            [160.922182844162, 178.0494549732208, 1]
          ]
        : mode === 'aggregate-next'
          ? [
              [140.0915925960541, 156.7571356754303, 1],
              [160.922182844162, 208, 1]
            ]
          : mode === 'occupied-next-band'
            ? [
                [129.8332528591156, 146.5251602649689, 0.6910713271653107],
                [146.13593311309813, 162.5957529067993, 0.6976552739605127],
                [154.8932246685028, 178.5, 0.6950569711389021]
              ]
            : [
                [129.8332528591156, 146.5251602649689, 0.6910713271653107],
                [146.13593311309813, 162.5957529067993, 0.6976552739605127],
                [154.8932246685028, 171.0265345096588, 0.6950569711389021],
                [163.5460237979889, 179.69689173698424, 0.7382677678161123]
              ],
    table = {
      id: 'page-1-anonymous-interior',
      readingRotation: 0,
      cropRect: [75, 105, 825, mode === 'aggregate-next' ? 211 : 195],
      rowCount: bands.length + 1,
      columnCount: 2,
      grid: [['Entry', 'Reference'], ...bands.map(() => ['', ''])],
      spans: [],
      unassigned: [],
      structure: {
        objects: [
          { label: 'table column', score: 1, rect: [0, 0, 300, 100] },
          { label: 'table column', score: 1, rect: [300, 0, 750, 100] },
          { label: 'table row', score: 1, rect: [0, 6, 750, 30.75] },
          { label: 'table column header', score: 1, rect: [0, 6, 750, 30.75] },
          ...bands.map(([top, bottom, score]) => ({
            label: 'table row',
            score,
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
