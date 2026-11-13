/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const res = fileURLToPath(new URL('../../resources/', import.meta.url)),
  req = createRequire(import.meta.url),
  sha = (b) => createHash('sha256').update(b).digest('hex')
const {
    PDFDocument,
    StandardFonts,
    pushGraphicsState,
    popGraphicsState,
    setStrokingRgbColor,
    setStrokingGrayscaleColor,
    setStrokingCmykColor,
    setLineWidth,
    moveTo,
    lineTo,
    stroke,
    beginText,
    endText,
    setFillingRgbColor,
    setFontAndSize,
    setTextMatrix,
    showText
  } = req('pdf-lib'),
  { createCanvas } = req('@napi-rs/canvas'),
  { getDocument } = await import(pathToFileURL(req.resolve('pdfjs-dist/legacy/build/pdf.mjs'))),
  mods = await Promise.all(
    [
      'literature-pdf-render-bounds.mjs',
      'literature-pdf-graphics.mjs',
      'literature-pdf-caption-group.mjs',
      'literature-pdf-orientation.mjs',
      'literature-pdf-native-table-font-role.mjs',
      'literature-pdf-figure-crop-geometry.mjs'
    ].map((n) => import(pathToFileURL(res + n)))
  )
const [
  {
    recordPaintedOperationBounds,
    captureNativeFigureRenderContext,
    matchNativeFigureRenderContext,
    bindNativeMesh4RenderContext
  },
  { collectGraphicsBounds, collectTableRules },
  { projectPdfTextLines, findCaptionCandidates },
  { tableTextToken },
  { createNativeTableFontRoleWitness },
  { nativeFigureLabelBounds }
] = mods
export async function segmentedScientificFixture(mode = 'base') {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    stubFont = await pdf.embedFont(StandardFonts.TimesRomanBold),
    page = pdf.addPage([500, 240]),
    fontName = page.node.newFontDictionary('Main', font.ref),
    stubName = page.node.newFontDictionary('Stub', stubFont.ref),
    text = (s, x, y, size = 8.9664, strong = false) =>
      page.pushOperators(
        beginText(),
        setFillingRgbColor(...(mode === 'white-text' ? [1, 1, 1] : [0, 0, 0])),
        setFontAndSize(strong ? stubName : fontName, size),
        setTextMatrix(1, 0, 0, 1, x, 240 - y),
        showText((strong ? stubFont : font).encodeText(s)),
        endText()
      ),
    rule = (x0, y0, x1, y1) =>
      page.pushOperators(
        pushGraphicsState(),
        mode === 'gray-frame'
          ? setStrokingGrayscaleColor(1)
          : mode === 'cmyk-frame'
            ? setStrokingCmykColor(0, 0, 0, 0)
            : setStrokingRgbColor(...(mode === 'white-frame' ? [1, 1, 1] : [0, 0, 0])),
        setLineWidth(0.4),
        moveTo(x0, 240 - y0),
        lineTo(x1, 240 - y1),
        stroke(),
        popGraphicsState()
      )
  text(
    'Table 1. Neutral precision results',
    144,
    mode === 'caption-padding' ? 100 : mode === 'caption-crossing' ? 103.6 : 90
  )
  for (const [s, x] of [
    ['K', 153],
    ['A', 185],
    ['B', 243],
    ['C', 298],
    ['D', 354],
    ['P', 404],
    ['Q', 447]
  ]) {
    if (!(mode === 'missing-header' && s === 'Q'))
      text(s, x, 113.891, mode === 'tall-header' && s === 'K' ? 12 : 8.9664, s === 'K')
  }
  if (mode !== 'missing-divider') rule(144.579, 117.764, 471.516, 117.764)
  for (const x of [166.99, 388.436]) {
    rule(x, 104.825, x, 117.564)
    for (let r = 0; r < 3; r++)
      rule(
        x,
        117.963 + r * 12.792,
        x,
        130.755 + r * 12.792 - (mode === 'unequal-bands' && r === 2 && x === 388.436 ? 0.5 : 0)
      )
  }
  const expected = [['K', 'A', 'B', 'C', 'D', 'P', 'Q']]
  for (let row = 0; row < 3; row++) {
    const y = 127.617 + row * 12.792,
      values = [String(32 * 2 ** row)]
    text(values[0], 151.178, y, 8.9664, true)
    for (let col = 0; col < 4; col++) {
      const x = 168.983 + col * 55.361
      const coefficient = String(2 + col) + '.222'
      text(coefficient, x, y)
      text('×', x + 23.035, y)
      text('10', x + 32.257, y)
      text('-', x + 41.469, y - 3.809, 5.9776)
      text(String(row + 1), x + 41.469 + font.widthOfTextAtSize('-', 5.9776), y - 3.809, 5.9776)
      values.push(coefficient + ' × 10-' + (row + 1))
    }
    text(String(row + 2), 400, y)
    text(String(row), 442, y)
    values.push(String(row + 2), String(row))
    expected.push(values)
  }
  if (mode === 'foreign-edge-path') rule(143.95, 125, 143.95, 130)
  if (mode.startsWith('foreign-zero')) {
    const { PDFHexString } = req('pdf-lib')
    const reference = pdf.context.register(
        pdf.context.obj({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: 'Times-Roman',
          Encoding: 'WinAnsiEncoding',
          FirstChar: 88,
          LastChar: 88,
          Widths: [0]
        })
      ),
      name = page.node.newFontDictionary('ZeroAdvance', reference),
      x = mode === 'foreign-zero-edge' ? 143 : 222
    page.pushOperators(
      beginText(),
      setFontAndSize(name, 10),
      setTextMatrix(1, 0, 0, 1, x, 240 - 140),
      showText(PDFHexString.of('58')),
      endText()
    )
  }
  const bytes = await pdf.save({ useObjectStreams: false })
  const assets = dirname(req.resolve('pdfjs-dist/package.json')),
    task = getDocument({
      data: new Uint8Array(bytes),
      fontExtraProperties: true,
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
      standardFontDataUrl: join(assets, 'standard_fonts') + '/',
      cMapUrl: join(assets, 'cmaps') + '/',
      cMapPacked: true,
      wasmUrl: join(assets, 'wasm') + '/'
    }),
    document = await task.promise
  try {
    const native = await document.getPage(1),
      content = await native.getTextContent(),
      operators = await native.getOperatorList(),
      v = native.getViewport({ scale: 1 }),
      viewport = native.getViewport({ scale: 1.5 }),
      canvas = createCanvas(viewport.width, viewport.height),
      render = native.render({
        canvas,
        canvasContext: canvas.getContext('2d'),
        viewport,
        recordOperations: true
      })
    recordPaintedOperationBounds(render)
    await render.promise
    const graphics = collectGraphicsBounds(render, native.recordedBBoxes),
      sourcePage = {
        pageNumber: 1,
        width: v.width,
        height: v.height,
        rotation: 0,
        renderRotation: 0,
        structureRoles: {},
        lines: projectPdfTextLines(content, v),
        ...graphics
      },
      snapshot = captureNativeFigureRenderContext(
        render,
        1,
        content,
        v,
        graphics.graphicsBounds,
        sha(bytes),
        native.commonObjs
      ),
      matched = matchNativeFigureRenderContext(
        snapshot,
        1,
        content,
        v,
        graphics.graphicsBounds,
        sha(bytes)
      )
    assert(matched)
    const c = bindNativeMesh4RenderContext(
        { ...matched, pageNumber: 1, sourceSha256: sha(bytes) },
        matched
      ),
      glyph = bindNativeMesh4RenderContext({ ...c }, c),
      sourceContent = {
        ...content,
        items: content.items.map((r, index) => ({
          ...r,
          sourceItem: { pageNumber: 1, index, text: r.str }
        }))
      },
      tokens = sourceContent.items
        .filter((r) => r.str?.trim())
        .map((r) => tableTextToken(r, viewport, 0)),
      paint = new Map(),
      rules = collectTableRules(operators, viewport, paint),
      captions = findCaptionCandidates([sourcePage]).map((c) => ({
        ...c,
        rect: c.rect.map((v) => v * 1.5)
      })),
      nativeTokens = sourceContent.items
        .filter((r) => r.str?.trim())
        .map((r) => ({
          ...tableTextToken(r, v, 0),
          fontAscent: content.styles[r.fontName]?.ascent,
          fontDescent: content.styles[r.fontName]?.descent,
          nativeLabelRect: nativeFigureLabelBounds(r, content.styles[r.fontName], v)
        })),
      witness = createNativeTableFontRoleWitness(sourcePage, nativeTokens, c),
      evidence = graphics.graphicsBounds.map((g) => ({
        kind: g.kind,
        operationIndex: g.operationIndex,
        rect: g.normalizedRect.map((n, i) => n * (i % 2 ? v.height : v.width) * 1.5)
      })),
      context = {
        sourcePage,
        nativeGlyphContext: glyph,
        nativePaintIdentityGraphics: evidence,
        operators,
        viewport,
        sourceContent,
        content: sourceContent,
        captions,
        rulePaintBounds: paint,
        nativeEvidenceGraphics: evidence
      }
    // Explicit detector-like test proposals reduced from the actual six-column pattern;
    // these are anonymous fixture inputs, not a claimed ONNX inference.
    const columns = [
        [35.80487468838692, 117.75328609347343],
        [85.65265595912933, 191.04901540279388],
        [194.8462571501732, 286.3572478890419],
        [282.30017709732056, 376.10099029541016],
        [375.04047897458076, 428.47745057940483],
        [428.7142529785633, 466.28878208994865]
      ],
      table = {
        id: 'neutral-table',
        readingRotation: 0,
        cropRect: [216, 149, 708, 254],
        rowCount: 3,
        columnCount: 6,
        spans: [],
        grid: Array.from({ length: 3 }, () => Array(6).fill('')),
        unassigned: [],
        structure: {
          objects: [
            ...columns.map(([l, r]) => ({
              label: 'table column',
              score: 1,
              rect: [l, 28.8, r, 104.4]
            })),
            ...Array.from({ length: 3 }, (_, i) => ({
              label: 'table row',
              score: 1,
              rect: [35, 28.8 + i * 19.188, 466, 48 + i * 19.188]
            }))
          ]
        }
      }
    return {
      expected,
      table,
      tokens: mode.startsWith('foreign-zero') ? tokens.filter((t) => t.text !== 'X') : tokens,
      captions,
      rules,
      paint,
      context,
      witness,
      sourcePage,
      bytes,
      dispose: async () => {
        canvas.width = canvas.height = 1
        await task.destroy()
      }
    }
  } catch (e) {
    await document.destroy()
    throw e
  }
}
