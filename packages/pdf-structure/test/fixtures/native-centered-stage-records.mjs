/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  PDFDocument,
  StandardFonts,
  moveTo,
  lineTo,
  stroke,
  setLineWidth,
  setCharacterSqueeze
} from 'pdf-lib'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
import {
  collectGraphicsBounds,
  collectTableRules
} from '../../resources/literature-pdf-graphics.mjs'
import {
  recordPaintedOperationBounds,
  captureNativeFigureRenderContext,
  matchNativeFigureRenderContext
} from '../../resources/literature-pdf-render-bounds.mjs'

// Simplified native PDF: two independent stages and one genuinely shared value.
// PDF.js extracts and renders the same bytes; no glyph or operator stubs.
export async function centeredStageRecords(separated = false, heading = 'Phase A') {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([300, 200]),
    rows = [
      ['Setting', heading, 'Phase B'],
      ['Mode', '-', 'Linear'],
      ['Module', 'Shared module'],
      ['Count', '4', '8'],
      ['Variant', 'Alpha', 'Beta']
    ]
  const text = (value, x, baseline) =>
    page.drawText(value, { x, y: 200 - baseline, size: 10, font })
  rows.forEach((row, r) => {
    const baseline = 35 + r * 22
    text(row[0], 20, baseline)
    row.slice(1).forEach((value, c) => {
      const center = row.length === 2 ? 200 : 150 + c * 100,
        naturalWidth = font.widthOfTextAtSize(value, 10),
        width = r === 0 && c === 0 ? Math.min(naturalWidth, 40) : naturalWidth
      // Keep hostile heading text inside its native lane, without dropping any glyphs.
      if (width < naturalWidth)
        page.pushOperators(setCharacterSqueeze((width / naturalWidth) * 100))
      text(value, center - width / 2, baseline)
      if (width < naturalWidth) page.pushOperators(setCharacterSqueeze(100))
    })
  })
  for (const y of [18, 145])
    page.pushOperators(setLineWidth(1), moveTo(10, 200 - y), lineTo(290, 200 - y), stroke())
  const bytes = await pdf.save({ useObjectStreams: false }),
    sourceSha256 = createHash('sha256').update(bytes).digest('hex'),
    assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    loading = getDocument({
      data: bytes,
      fontExtraProperties: true,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl: join(assets, 'standard_fonts') + '/'
    }),
    document = await loading.promise,
    nativePage = await document.getPage(1),
    viewport = nativePage.getViewport({ scale: 1 }),
    canvas = createCanvas(viewport.width, viewport.height),
    render = nativePage.render({
      canvas,
      canvasContext: canvas.getContext('2d'),
      viewport,
      recordOperations: true
    })
  recordPaintedOperationBounds(render)
  await render.promise
  const raw = await nativePage.getTextContent(),
    content = {
      ...raw,
      items: raw.items.map((item, index) =>
        'str' in item ? { ...item, sourceItem: { pageNumber: 1, index, text: item.str } } : item
      )
    },
    graphics = collectGraphicsBounds(render, nativePage.recordedBBoxes),
    snapshot = captureNativeFigureRenderContext(
      render,
      1,
      content,
      viewport,
      graphics.graphicsBounds,
      sourceSha256,
      nativePage.commonObjs
    ),
    native = matchNativeFigureRenderContext(
      snapshot,
      1,
      content,
      viewport,
      graphics.graphicsBounds,
      sourceSha256
    )
  if (!native) throw Error('The rendered native source did not match')
  Object.assign(native, { pageNumber: 1, sourceSha256 })
  const tokens = content.items
      .filter((i) => i.str?.trim())
      .map((i) => ({
        ...tableTextToken(i, viewport, 0),
        fontAscent: content.styles[i.fontName].ascent,
        fontDescent: content.styles[i.fontName].descent
      })),
    cells = [],
    grid = rows.map(() => Array(separated ? 3 : 2).fill('')),
    add = (row, column, fonts, colSpan = 1) => {
      const cell = {
        row,
        column,
        rowSpan: 1,
        colSpan,
        text: fonts.map((f) => f.text).join(' '),
        sourceItems: fonts.map((f) => f.sourceItem),
        sourceRects: fonts.map((f) => f.rect)
      }
      cells.push(cell)
      grid[row][column] = cell.text
    }
  rows.forEach((row, r) => {
    const fonts = tokens.filter((t) => Math.abs(t.baseline - (35 + r * 22)) < 0.001)
    add(
      r,
      0,
      fonts.filter((t) => t.rect[0] < 100)
    )
    const values = fonts.filter((t) => t.rect[0] > 100)
    if (separated && values.length === 2) values.forEach((f, c) => add(r, c + 1, [f]))
    else add(r, 1, values, separated ? 2 : 1)
  })
  const rulePaintBounds = new Map(),
    rules = collectTableRules(native.operators, viewport, rulePaintBounds),
    context = {
      sourcePage: { pageNumber: 1 },
      sourceContent: content,
      content,
      viewport,
      operators: native.operators,
      nativeGlyphContext: native,
      rulePaintBounds,
      nativePaintIdentityGraphics: graphics.graphicsBounds.map((g) => ({
        ...g,
        rect: g.normalizedRect.map((v, a) => v * (a % 2 ? 200 : 300))
      }))
    },
    table = {
      id: 'native-stages',
      page: 1,
      cropRect: [10, 10, 290, 150],
      cells,
      grid,
      issues: [],
      unassigned: [],
      repairs: [],
      thumbnail: 'retained.png'
    }
  return {
    table,
    png: canvas.toBuffer('image/png'),
    sourceSha256,
    cells,
    grid,
    tokens,
    rules,
    context,
    async close() {
      canvas.width = canvas.height = 0
      await loading.destroy()
    }
  }
}
