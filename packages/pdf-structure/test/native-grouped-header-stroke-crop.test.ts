import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import * as fontkit from 'fontkit'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument, PDFName } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectGraphicsBounds, collectTableRules } from '../resources/literature-pdf-graphics.mjs'
import {
  recordPaintedOperationBounds,
  captureNativeFigureRenderContext,
  matchNativeFigureRenderContext
} from '../resources/literature-pdf-render-bounds.mjs'
import { tableTextToken } from '../resources/literature-pdf-orientation.mjs'
import {
  refineNativeTableBoundaryInk,
  getNativeOwnedGlyphOverhangCropProof,
  validateNativeOwnedGlyphOverhangCropPng
} from '../resources/literature-pdf-native-table-boundary-ink.mjs'
import { recoverOwnedTableCrop } from '../resources/literature-pdf-table-geometry.mjs'
import { reviewNativeTableSources } from '../resources/literature-pdf-table-source-integrity.mjs'
type Fixture = ReturnType<typeof JSON.parse>

// Invented grouped-header PDF; bundled redistributable Liberation font only.
async function groupedHeader(extra = ''): Promise<Fixture> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    page = pdf.addPage([390, 220]),
    font = await pdf.embedFont(
      await readFile(join(assets, 'standard_fonts/LiberationSans-Regular.ttf')),
      { subset: false }
    ),
    text = (s: string, x: number, y: number): string =>
      `BT /F 10 Tf 1 0 0 1 ${x} ${220 - y} Tm ${font.encodeText(s)} Tj ET`,
    line = (l: number, r: number, y: number, w: number): string =>
      `${w} w ${l} ${220 - y} m ${r} ${220 - y} l S`,
    captionText = 'Table1:GroupedComparison.',
    parents = ['GroupA', 'GroupB'],
    leaves = ['LeftA', 'RightA', 'LeftB', 'RightB'],
    xs = [45, 125, 195, 275],
    stream = [
      text(captionText, 30, 30),
      line(30, 330, 55, 0.8),
      ...parents.map((s, n) => text(s, 100 + n * 150 - font.widthOfTextAtSize(s, 10) / 2, 68)),
      line(40, 160, extra === 'moved-line' ? 97 : 73, 0.4),
      ...(extra === 'duplicate' ? [line(40, 160, 73, 0.4)] : []),
      line(190, 310, 73, 0.4),
      ...leaves.map((s, n) => text(s, xs[n], 85)),
      line(30, 330, 90, 0.8),
      ...Array.from({ length: 8 }, (_, n) =>
        text(String(10 + n), xs[n % 4], 105 + Math.floor(n / 4) * 15)
      ),
      ...(extra === 'fill'
        ? ['245 108 8 3 re f']
        : extra === 'drawing'
          ? ['250 108 m 257 108 l 254 115 l h S']
          : []),
      ...(extra === 'legend' ? [text('Note', 235, 112)] : []),
      line(30, 330, 125, 0.8)
    ].join('\n')
  page.node.set(PDFName.of('Resources'), pdf.context.obj({ Font: { F: font.ref } }))
  page.node.addContentStream(pdf.context.register(pdf.context.flateStream(stream)))
  const data = await pdf.save(),
    loading = getDocument({
      data: data.slice(),
      useSystemFonts: false,
      standardFontDataUrl: join(assets, 'standard_fonts') + '/',
      isEvalSupported: false
    })
  try {
    const doc = await loading.promise,
      native = await doc.getPage(1),
      v = native.getViewport({ scale: 1 }),
      canvas = createCanvas(390, 220),
      task = native.render({
        canvas,
        canvasContext: canvas.getContext('2d'),
        viewport: v,
        recordOperations: true
      })
    recordPaintedOperationBounds(task)
    await task.promise
    const raw = await native.getTextContent(),
      graphics = collectGraphicsBounds(task, native.recordedBBoxes),
      sha = createHash('sha256').update(data).digest('hex'),
      snapshot = captureNativeFigureRenderContext(
        task,
        1,
        raw,
        v,
        graphics.graphicsBounds,
        sha,
        native.commonObjs
      ),
      ink = matchNativeFigureRenderContext(snapshot, 1, raw, v, graphics.graphicsBounds, sha)
    expect(ink).toBeDefined()
    ink.pageNumber = 1
    ink.sourceSha256 = sha
    const viewport = native.getViewport({ scale: 1.5 }),
      tokens = ink.content.items
        .filter((i: Fixture) => i.str?.trim())
        .map((i: Fixture) => tableTextToken(i, viewport, 0)),
      pick = (s: string): Fixture => tokens.find((t: Fixture) => t.text === s),
      cells: Fixture[] = [],
      grid = Array.from({ length: 4 }, () => Array(4).fill('')),
      cell = (row: number, column: number, s: string, colSpan = 1): void => {
        const t = pick(s)
        grid[row][column] = s
        cells.push({
          row,
          column,
          rowSpan: 1,
          colSpan,
          text: s,
          sourceItems: [t.sourceItem],
          sourceRects: [t.rect]
        })
      }
    parents.forEach((s, n) => cell(0, n * 2, s, 2))
    leaves.forEach((s, n) => cell(1, n, s))
    Array.from({ length: 8 }, (_, n) => cell(2 + Math.floor(n / 4), n % 4, String(10 + n)))
    const rulePaintBounds = new Map(),
      rules = collectTableRules(ink.operators, viewport, rulePaintBounds),
      g = graphics.graphicsBounds.map((g: Fixture) => ({
        kind: g.kind,
        operationIndex: g.operationIndex,
        rect: g.normalizedRect.map(
          (n: number, i: number) => n * (i % 2 ? viewport.height : viewport.width)
        )
      })),
      table = {
        id: 'anonymous-grouped',
        page: 1,
        cropRect: [28, 55, 332, 125].map((n) => n * 1.5),
        sourceViewport: { width: viewport.width, height: viewport.height, scale: 1.5 },
        grid,
        cells,
        caption: {
          page: 1,
          text: captionText,
          rect: pick(captionText).rect.map((n: number) => n / 1.5)
        },
        unassigned: [],
        clipped: [],
        issues: [],
        notes: [],
        selectedTextItems: cells.length
      },
      context = {
        viewport,
        sourceContent: ink.content,
        content: ink.content,
        sourcePage: {
          pageNumber: 1,
          width: 390,
          height: 220,
          invalidGraphicsBounds: 0,
          graphicsBounds: graphics.graphicsBounds
        },
        nativeGlyphContext: ink,
        operators: ink.operators,
        rulePaintBounds,
        nativeEvidenceGraphics: g,
        nativePaintIdentityGraphics: g,
        captions: [table.caption]
      }
    canvas.width = canvas.height = 0
    return {
      table,
      tokens,
      rules,
      context,
      async render(rect: number[]): Promise<Buffer> {
        const sc = 4,
          c = createCanvas(Math.ceil((rect[2] - rect[0]) * sc), Math.ceil((rect[3] - rect[1]) * sc))
        await native.render({
          canvas: c,
          canvasContext: c.getContext('2d'),
          viewport: native.getViewport({ scale: sc }),
          transform: [1, 0, 0, 1, -rect[0] * sc, -rect[1] * sc]
        }).promise
        const png = c.toBuffer('image/png')
        c.width = c.height = 0
        return png
      },
      close: () => loading.destroy()
    }
  } catch (e) {
    await loading.destroy()
    throw e
  }
}
async function consumer(f: Fixture): Promise<Fixture> {
  const refined = refineNativeTableBoundaryInk(f.table, f.rules, f.context),
    proof = refined && getNativeOwnedGlyphOverhangCropProof(refined)
  if (!proof) return { safe: false, refined, proof }
  let table = {
    ...refined,
    cropRect: recoverOwnedTableCrop(
      refined,
      f.rules,
      [f.context.viewport.width, f.context.viewport.height],
      f.tokens,
      f.context.rulePaintBounds,
      [],
      f.tokens
    )
  }
  table = reviewNativeTableSources(table, f.tokens)
  table.notes = [...table.notes]
  const png = await f.render(table.cropRect.map((n: number) => n / 1.5))
  return {
    safe: validateNativeOwnedGlyphOverhangCropPng(proof, png, table),
    refined: table,
    proof,
    png
  }
}
it('preserves native grouped underlines through the actual late crop and PNG consumer', async () => {
  const f = await groupedHeader()
  try {
    const r = await consumer(f)
    expect(r.refined).toBeDefined()
    expect(r.safe).toBe(true)
    expect(r.refined.cells).toBe(f.table.cells)
    expect(r.refined.cropRect[1]).toBeLessThan(f.table.cropRect[1])
    expect(r.refined.cropRect[3]).toBeGreaterThan(f.table.cropRect[3])
  } finally {
    await f.close()
  }
})
it('keeps an independent closed fill foreign even inside the old crop', async () => {
  const f = await groupedHeader('fill')
  try {
    expect((await consumer(f)).safe).toBe(false)
  } finally {
    await f.close()
  }
})

it.each(['drawing', 'duplicate', 'moved-line', 'legend'])(
  'keeps independent or unproved native %s paint foreign',
  async (extra) => {
    const f = await groupedHeader(extra)
    try {
      expect((await consumer(f)).safe).toBe(false)
    } finally {
      await f.close()
    }
  }
)
it('requires native parent/leaf ownership rather than horizontal line appearance', async () => {
  const f = await groupedHeader()
  try {
    f.table.cells[0].colSpan = 1
    expect((await consumer(f)).safe).toBe(false)
  } finally {
    await f.close()
  }
})
it('invalidates the final native PNG when the actual operator view is replaced', async () => {
  const f = await groupedHeader()
  try {
    const r = await consumer(f)
    expect(r.safe).toBe(true)
    f.context.operators = structuredClone(f.context.operators)
    expect(validateNativeOwnedGlyphOverhangCropPng(r.proof, r.png, r.refined)).toBe(false)
  } finally {
    await f.close()
  }
})
