import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { resolve } from './paths'
const { nativeRasterGridCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-raster-grid.mjs')).href
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
  const width = 600,
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
    image = (top: number, left = 50): void => {
      add(OPS.save, null)
      add(OPS.transform, [200, 0, 0, 150, left, height - top - 150])
      const operationIndex = operators.fnArray.length
      add(OPS.paintImageXObject, ['image-' + operationIndex, 800, 600])
      graphicsBounds.push({
        operationIndex,
        kind: 'image',
        normalizedRect: [left / width, top / height, (left + 200) / width, (top + 150) / height],
        paintedNormalizedRect: [
          (left + 5) / width,
          (top + 5) / height,
          (left + 195) / width,
          (top + 145) / height
        ]
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
  image(70, 260)
  image(221)
  image(221, 260)
  const title =
    'Figure 1. Complete original raster panels arranged in rows and two separate columns.'
  text('Figure 1.', 48, 393)
  text('Complete original raster panels arranged in rows and two separate columns.', 98, 393)
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
  nativeRasterGridCrop(f.page, f.figure, f.captions, f.tables, f.tokens, f.context)
it('restores a complete native raster grid with a fragmented whole caption and no new owners', () => {
  const f = fixture(),
    before = JSON.stringify(f)
  expect(prove(f)?.rect).toEqual([50, 70, 460, 371])
  expect(prove(f)?.formCropRaster.ownedRects).toHaveLength(4)
  expect(JSON.stringify(f)).toBe(before)
})
it('refuses an incomplete row or an ambiguous duplicate image slot', () => {
  const f = fixture()
  f.image(70, 260)
  expect(prove(f)).toBeUndefined()
})
it('refuses an old crop extending beyond its uniquely owned raster panel', () => {
  const f = fixture()
  f.figure.rect[0] = 49
  expect(prove(f)).toBeUndefined()
})
it('refuses a native caption literal not fully covered by its independent source interval', () => {
  const f = fixture()
  f.figure.caption.lines[0] += ' Extra'
  expect(prove(f)).toBeUndefined()
})
it('refuses missing full font metrics or a foreign source over the completed grid', () => {
  const missing = fixture()
  delete (missing.context.content.styles.F as { descent?: number }).descent
  expect(prove(missing)).toBeUndefined()
  const foreign = fixture()
  foreign.text('Independent text', 90, 110)
  expect(prove(foreign)).toBeUndefined()
})
it('refuses hidden caption paint without relaxing the ordinary packet contract', () => {
  const f = fixture(),
    o = f.context.operators,
    i = o.fnArray.indexOf(OPS.beginText)
  o.fnArray.splice(i, 0, OPS.setFillRGBColor)
  o.argsArray.splice(i, 0, ['#ffffff'])
  expect(
    nativePlotPacketInventory(f.page, f.figure, f.captions, [], [], f.tokens, f.context)
  ).toBeDefined()
  expect(prove(f)).toBeUndefined()
})
it('requires the actual encoded PNG to preserve all raster halos and foreign domains', () => {
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
