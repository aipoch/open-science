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
import {
  findCaptionCandidates,
  projectPdfTextLines
} from '../../resources/literature-pdf-caption-group.mjs'

export async function wholeHyphenatedHeaderFixture(mode = 'base') {
  const domainMode = mode.startsWith('domain-') ? mode.slice('domain-'.length) : undefined,
    pageHeight = domainMode ? 300 : 260,
    document = await PDFDocument.create({ updateMetadata: false }),
    font = await document.embedFont(StandardFonts.TimesRoman),
    other = await document.embedFont(StandardFonts.TimesRomanBold),
    page = document.addPage([600, pageHeight]),
    scale = 1.5,
    fontName = page.node.newFontDictionary('Main', font.ref),
    otherName = page.node.newFontDictionary('Other', other.ref)
  const center = (c) => 50 + ((c + 0.5) * 500) / 11
  const text = (value, c, y, alternate = false, leftAligned = false) => {
    const f = alternate ? other : font,
      name = alternate ? otherName : fontName,
      size = 8.9664,
      x = leftAligned ? 50.5 : center(c) - f.widthOfTextAtSize(value, size) / 2
    page.pushOperators(
      beginText(),
      setFillingRgbColor(0, 0, 0),
      setFontAndSize(name, size),
      setTextMatrix(1, 0, 0, 1, x, pageHeight - y),
      showText(f.encodeText(value)),
      endText()
    )
  }
  text('Region-', 4, 80, mode === 'different-face')
  for (const [c, value] of [
    'Domain',
    'Code',
    'Area',
    'Count',
    'periods',
    'Rate',
    mode === 'existing-wrapped-family' ? 'Interval' : '[CI]',
    mode === 'existing-wrapped-family' ? 'Lower' : '90%',
    'Upper',
    'Score',
    'Panel'
  ].entries())
    text(value, c, 89.5)
  if (domainMode) drawPairedDomainRecords(text, domainMode)
  else
    for (let i = 0; i < 6; i++) {
      const fields = [
        String.fromCharCode(65 + i),
        'Zone',
        String(100 + i),
        String(20 + i),
        '0.5',
        '[.1,.2]',
        '0.1',
        '0.2',
        '0.3',
        'Group'
      ]
      for (let c = 1; c < 11; c++) text(fields[c - 1], c, 110 + i * 20)
      if (i % 2 === 0) text('Section', 0, 110 + i * 20)
    }
  const rail = (y) =>
    page.pushOperators(
      pushGraphicsState(),
      setStrokingRgbColor(0, 0, 0),
      setLineWidth(0.4),
      setDashPattern([], 0),
      moveTo(50, pageHeight - y),
      lineTo(550, pageHeight - y),
      stroke(),
      popGraphicsState()
    )
  const rails = domainMode
    ? domainMode === 'missing-rail'
      ? [70, 275]
      : domainMode === 'extra-rail'
        ? [70, 94, 145, 275]
        : [70, 94, 275]
    : mode === 'missing-rail'
      ? [70, 220]
      : [70, 94, 220]
  for (const y of rails) rail(y)
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
    tokens = sourceContent.items
      .filter((r) => r.str?.trim())
      .map((r) => tableTextToken(r, viewport, 0)),
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
    }
  const top = 70 * scale,
    left = 50 * scale,
    width = 500 * scale,
    headerTop = (89.5 - 8.9664) * scale,
    headerBottom = 93.9 * scale,
    body = Array.from({ length: 6 }, (_, i) => [(100 + i * 20) * scale, (116 + i * 20) * scale]),
    objects = [
      ...Array.from({ length: 11 }, (_, c) => ({
        label: 'table column',
        score: 1,
        rect: [(c * width) / 11, 0, ((c + 1) * width) / 11, 150 * scale]
      })),
      { label: 'table row', score: 1, rect: [0, headerTop - top, width, headerBottom - top] },
      {
        label: 'table column header',
        score: 1,
        rect: [0, headerTop - top, width, headerBottom - top]
      },
      ...body.map(([a, b]) => ({
        label: 'table row',
        score: 1,
        rect: [0, a - top, width, b - top]
      }))
    ]
  const table = domainMode
    ? pairedDomainTable(scale, domainMode)
    : {
        id: 'anonymous-native-header',
        readingRotation: 0,
        cropRect: [left, top, left + width, 220 * scale],
        rowCount: 7,
        columnCount: 11,
        grid: Array.from({ length: 7 }, () => Array(11).fill('')),
        spans: [],
        unassigned: [],
        structure: { objects }
      }
  return {
    table,
    tokens: domainMode === 'foreign-native-atom' ? tokens.filter((t) => t.text !== 'Z') : tokens,
    captions: [],
    rules,
    paint,
    context,
    bytes,
    dispose: async () => {
      canvas.width = canvas.height = 1
      await task.destroy()
    }
  }
}

function drawPairedDomainRecords(text, mode) {
  const baselines = [125, 136, 163, 196, 234, 256],
    count = mode === 'short-record-set' ? 5 : 6
  for (let i = 0; i < count; i++) {
    const fields = [
      ['AAA', 'BBB', 'CCC'][i >> 1],
      i % 2 ? 'Later' : 'First',
      String(100 + i),
      i % 2 ? '42' : '–',
      '0.5',
      '[.1,.2]',
      '0.1',
      '0.2',
      '0.3',
      'Fixed'
    ]
    for (let c = 1; c < 11; c++) text(fields[c - 1], c, baselines[i])
  }
  text('Alpha and', 0, 114, false, true)
  text('category', 0, 125, false, true)
  const second = mode === 'variable-three-plus-one' ? 196 : 163
  if (mode === 'three-line-wrap') text('Another', 0, second - 22, false, true)
  text('Beta and', 0, second - 11, mode === 'different-stub-face', mode !== 'centered-label')
  text('measures', 0, second, false, true)
  text('Control', 0, 234, false, true)
  if (mode === 'foreign-native-atom') text('Z', 5, 143)
  if (mode === 'numeric-leaf-in-phantom') text('0.7', 5, 114)
}

function pairedDomainTable(scale, mode) {
  const top = 70 * scale,
    width = 500 * scale,
    bands = [
      [89.5 - 8.9664, 93.9],
      [104.2, 116.5],
      [116, 128],
      [128, 148],
      [151, 184],
      [184, 220],
      [225, 245],
      [245, 267]
    ],
    objects = [
      ...Array.from({ length: 11 }, (_, c) => ({
        label: 'table column',
        score: 1,
        rect: [(c * width) / 11, 0, ((c + 1) * width) / 11, 205 * scale]
      })),
      ...bands.map(([a, b]) => ({
        label: 'table row',
        score: 1,
        rect: [0, a * scale - top, width, b * scale - top]
      })),
      {
        label: 'table column header',
        score: 1,
        rect: [0, bands[0][0] * scale - top, width, bands[0][1] * scale - top]
      },
      {
        label: 'table projected row header',
        score: 1,
        rect: [0, 104.2 * scale - top, width, 116.5 * scale - top]
      },
      {
        label: 'table spanning cell',
        score: 1,
        rect: [
          0,
          225 * scale - top,
          width / 11,
          (mode === 'partial-physical-span' ? 234 : 267) * scale - top
        ]
      }
    ]
  return {
    id: 'anonymous-native-domain',
    readingRotation: 0,
    cropRect: [50 * scale, top, 550 * scale, 275 * scale],
    rowCount: 8,
    columnCount: 11,
    grid: Array.from({ length: 8 }, () => Array(11).fill('')),
    spans: [],
    unassigned: [],
    structure: { objects }
  }
}
