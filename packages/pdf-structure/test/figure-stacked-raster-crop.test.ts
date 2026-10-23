import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { resolve } from './paths'
const { nativeStackedRasterCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-stacked-raster.mjs')).href
)
const { nativeCompleteFormCropPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-complete-form.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { nativePlotPacketInventory } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  const width = 400,
    height = 500,
    operators = { fnArray: [] as number[], argsArray: [] as unknown[] },
    graphicsBounds = [] as object[],
    items = [] as ReturnType<typeof JSON.parse>[],
    glyphs = [] as object[],
    tokens = [] as object[],
    lines = [] as object[],
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number) => [x, height - y]
    },
    add = (op: number, args: unknown): void => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    },
    image = (top: number): void => {
      add(OPS.save, null)
      add(OPS.transform, [200, 0, 0, 150, 50, height - top - 150])
      const operationIndex = operators.fnArray.length
      add(OPS.paintImageXObject, ['image-' + operationIndex, 800, 600])
      graphicsBounds.push({
        operationIndex,
        kind: 'image',
        normalizedRect: [50 / width, top / height, 250 / width, (top + 150) / height],
        paintedNormalizedRect: [55 / width, (top + 5) / height, 245 / width, (top + 145) / height]
      })
      add(OPS.restore, null)
    },
    text = (str: string, x: number, baseline: number): void => {
      add(OPS.beginText, null)
      add(OPS.setFont, ['F', 10])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - baseline]])
      add(OPS.showText, [
        [{ unicode: str, fontChar: str, width: 500 * str.length, isInFont: true }]
      ])
      add(OPS.endText, null)
      const raw = {
        str,
        dir: 'ltr',
        width: str.length * 5,
        height: 10,
        transform: [10, 0, 0, 10, x, height - baseline],
        fontName: 'F',
        hasEOL: true,
        sourceItem: { pageNumber: 1, index: items.length, text: str }
      }
      items.push(raw)
      glyphs.push({ fontChar: str, bounds: [0, -0.1, str.length * 0.5, 0.7] })
      tokens.push(tableTextToken(raw, viewport, 0))
      lines.push({ text: str, x, y: baseline - 10, width: raw.width, height: 10, fontSize: 10 })
    }
  image(70)
  image(221)
  const title = 'Figure 1. Complete original raster panels.'
  text(title, 48, 393)
  const caption = { page: 1, lines: [title], rect: [48, 383, 48 + title.length * 5, 393] },
    figure = { rect: [55, 226, 245, 366], caption, graphicsCount: 1 },
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, lines, graphicsBounds },
    context = {
      operators,
      viewport,
      content: { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
      glyphBounds: [{ fontName: 'F', glyphs }],
      graphicsBounds
    }
  return {
    page,
    figure,
    captions: [caption],
    tables: [] as number[][],
    tokens,
    context,
    image,
    text
  }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const prove = (f: ReturnType<typeof fixture>) =>
  nativeStackedRasterCrop(f.page, f.figure, f.captions, f.tables, f.tokens, f.context)
it('completes two native raster panels without changing their source owners', () => {
  const f = fixture(),
    before = JSON.stringify(f)
  expect(prove(f)?.rect).toEqual([50, 70, 250, 371])
  expect(JSON.stringify(f)).toBe(before)
  expect(prove(f)?.formCropRaster.ownedRects).toEqual([
    [50, 70, 250, 220],
    [50, 221, 250, 371]
  ])
})
it('preserves an old crop extending beyond the two image bounds', () => {
  const f = fixture()
  f.figure.rect[0] = 49
  expect(prove(f)).toBeUndefined()
})
it('uses the complete native glyph packet for horizontally scaled caption text', () => {
  const f = fixture(),
    raw = f.context.content.items[0],
    o = f.context.operators,
    matrix = o.argsArray[o.fnArray.indexOf(OPS.setTextMatrix)] as number[][]
  matrix[0][0] = 1.01
  raw.transform[0] = 10.1
  raw.width *= 1.01
  f.tokens[0] = tableTextToken(raw, f.context.viewport, 0)
  f.figure.caption.rect[2] = raw.transform[4] + raw.width
  expect(prove(f)?.rect).toEqual([50, 70, 250, 371])
})
it('refuses duplicate sibling image evidence', () => {
  const f = fixture()
  f.image(70)
  expect(prove(f)).toBeUndefined()
})
it('refuses an incomplete native font packet', () => {
  const f = fixture()
  f.context.glyphBounds = []
  expect(prove(f)).toBeUndefined()
})
it('refuses a caption boundary intersecting the raster group', () => {
  const f = fixture()
  f.figure.caption.rect[1] = 370
  expect(prove(f)).toBeUndefined()
})
it('refuses native prose inside either complete panel boundary', () => {
  const f = fixture()
  f.text('Independent text', 90, 110)
  expect(prove(f)).toBeUndefined()
})
it('refuses a foreign stroke crossing the completed group', () => {
  const f = fixture(),
    o = f.context.operators,
    operationIndex = o.fnArray.length
  o.fnArray.push(OPS.constructPath)
  o.argsArray.push([OPS.stroke, [[0, 30, 400, 1, 270, 400]], [30, 400, 270, 400]])
  f.page.graphicsBounds.push({
    operationIndex,
    kind: 'path',
    normalizedRect: [0.07, 0.19, 0.68, 0.21]
  })
  expect(
    nativePlotPacketInventory(f.page, f.figure, f.captions, [], [], f.tokens, f.context)
  ).toBeDefined()
  expect(prove(f)).toBeUndefined()
})
it('requires actual PNG scale to preserve both image halos and foreign paint exclusion', () => {
  const f = fixture(),
    proof = prove(f)
  expect(proof).toBeDefined()
  const rect = proof.rect.map((n: number, i: number) => n + (i < 2 ? -4 / 3 : 4 / 3)),
    canvas = createCanvas(Math.ceil((rect[2] - rect[0]) * 4), Math.ceil((rect[3] - rect[1]) * 4))
  try {
    expect(nativeCompleteFormCropPngSafe(canvas.toBuffer('image/png'), rect, f.page, proof)).toBe(
      true
    )
    canvas.width = 2
    canvas.height = 3
    expect(nativeCompleteFormCropPngSafe(canvas.toBuffer('image/png'), rect, f.page, proof)).toBe(
      false
    )
  } finally {
    canvas.width = canvas.height = 1
  }
})
