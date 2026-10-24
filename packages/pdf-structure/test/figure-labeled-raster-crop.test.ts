import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { resolve } from './paths'
const { nativeLabeledRasterCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-labeled-raster.mjs')).href
)
const { nativeCompleteFormCropPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-complete-form.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture(omitLabel = false) {
  const width = 600,
    height = 420,
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
    },
    image = (top: number, left: number): void => {
      add(OPS.save, null)
      add(OPS.transform, [100, 0, 0, 80, left, height - top - 80])
      const operationIndex = operators.fnArray.length
      add(OPS.paintImageXObject, ['image-' + operationIndex, 400, 320])
      graphicsBounds.push({
        operationIndex,
        kind: 'image',
        normalizedRect: [left / width, top / height, (left + 100) / width, (top + 80) / height],
        paintedNormalizedRect: [
          (left + 2) / width,
          (top + 2) / height,
          (left + 98) / width,
          (top + 78) / height
        ]
      })
      add(OPS.restore, null)
    }
  for (const [n, title] of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'].entries()) {
    const top = n < 3 ? 50 : 144.6,
      left = 50 + (n % 3) * 100
    image(top, left)
    if (!omitLabel || n !== 4) text(title, left + 50 - title.length * 2.5, top + 92)
  }
  const title = 'Figure 1. Original illustrated panels.',
    caption = { page: 1, lines: [title], rect: [105, 248, 295, 258] }
  text(title, 105, 258)
  const figure = {
      rect: [65, 55, 335, 220],
      caption,
      graphicsCount: 6,
      reason: 'native-raster-composite-grid'
    },
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, lines, graphicsBounds },
    context = {
      operators,
      viewport,
      content: { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
      glyphBounds: [{ fontName: 'F', glyphs }],
      graphicsBounds
    }
  return { page, figure, captions: [caption], tables: [] as number[][], tokens, context, text }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const prove = (f: ReturnType<typeof fixture>) =>
  nativeLabeledRasterCrop(f.page, f.figure, f.captions, f.tables, f.tokens, f.context)
it('restores all six interleaved whole labels and raster panels without changing ownership', () => {
  const f = fixture(),
    before = JSON.stringify(f),
    proof = prove(f)
  expect(proof?.rect).toEqual([50, 50, 350, 237.6])
  expect(proof?.formCropRaster.ownedRects).toHaveLength(12)
  expect(proof?.formCropRaster.paintSeparations.length).toBeGreaterThan(0)
  expect(proof?.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
it('refuses missing or nonunique whole label-to-image evidence', () => {
  const missing = fixture(true)
  expect(prove(missing)).toBeUndefined()
  const duplicate = fixture()
  duplicate.text('Other', 87.5, 142)
  expect(prove(duplicate)).toBeUndefined()
})
it('refuses incomplete font or source evidence and independent text crossing the completed crop', () => {
  const missing = fixture()
  delete (missing.context.content.styles.F as { descent?: number }).descent
  expect(prove(missing)).toBeUndefined()
  const source = fixture()
  source.context.content.items[4].sourceItem.text += ' absent'
  expect(prove(source)).toBeUndefined()
  const foreign = fixture()
  foreign.text('Independent paragraph', 70, 90)
  expect(prove(foreign)).toBeUndefined()
})
it('refuses invisible native label paint', () => {
  const f = fixture(),
    o = f.context.operators,
    i = o.fnArray.indexOf(OPS.beginText)
  o.fnArray.splice(i, 0, OPS.setGState)
  o.argsArray.splice(i, 0, [[['ca', 0]]])
  expect(prove(f)).toBeUndefined()
})
it('refuses a later foreign paint covering a native label', () => {
  const f = fixture(),
    o = f.context.operators
  o.fnArray.push(OPS.constructPath)
  o.argsArray.push([
    OPS.fill,
    [new Float32Array([0, 90, 277, 1, 110, 277, 1, 110, 280, 1, 90, 280, 4])],
    [90, 277, 110, 280]
  ])
  expect(prove(f)).toBeUndefined()
})
it('checks internal paint separation at the actual PNG scale and rejects malformed extra facts', () => {
  const f = fixture(),
    proof = prove(f)
  expect(proof).toBeDefined()
  const rect = proof.rect.map((n: number, i: number) => n + (i < 2 ? -4 / 3 : 4 / 3)),
    png = (scale: number): Buffer =>
      createCanvas(
        Math.ceil((rect[2] - rect[0]) * scale),
        Math.ceil((rect[3] - rect[1]) * scale)
      ).toBuffer('image/png')
  expect(nativeCompleteFormCropPngSafe(png(3), rect, f.page, proof)).toBe(true)
  expect(nativeCompleteFormCropPngSafe(png(2), rect, f.page, proof)).toBe(false)
  proof.formCropRaster.paintSeparations[0].laterPaintRect[0] = NaN
  expect(nativeCompleteFormCropPngSafe(png(3), rect, f.page, proof)).toBe(false)
})
