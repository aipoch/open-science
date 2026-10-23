import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { resolve } from './paths'
const { nativePairedRasterTailCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-paired-raster-tail.mjs')).href
)
const { nativeCompleteFormCropPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-complete-form.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture(unequalColumn = false) {
  const width = 600,
    height = 400,
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
      if (!glyphs.some((g) => (g as { fontChar: string }).fontChar === str))
        glyphs.push({ fontChar: str, bounds: [0, -0.2, str.length * 0.5, 0.7] })
      tokens.push(tableTextToken(raw, viewport, 0))
      lines.push({ text: str, x, y: baseline - 10, width: raw.width, height: 10, fontSize: 10 })
    },
    image = (left: number): void => {
      add(OPS.save, null)
      add(OPS.transform, [160, 0, 0, 100, left, height - 150])
      const operationIndex = operators.fnArray.length
      add(OPS.paintImageXObject, ['image-' + operationIndex, 640, 400])
      graphicsBounds.push({
        operationIndex,
        kind: 'image',
        normalizedRect: [left / width, 50 / height, (left + 160) / width, 150 / height],
        paintedNormalizedRect: [(left + 2) / width, 52 / height, (left + 158) / width, 148 / height]
      })
      add(OPS.restore, null)
    }
  for (const [n, left] of [50, 285].entries()) {
    image(left)
    text(
      '(' +
        String.fromCharCode(97 + n) +
        ') Independent complete column label tex' +
        (n === 1 && unequalColumn ? '' : 't'),
      left,
      163
    )
    text('continued description on one native line.', left, 175)
  }
  const title = 'Figure 1. Complete independent diagram panels.',
    caption = { page: 1, lines: [title], rect: [160, 190, 390, 200] }
  text(title, 160, 200)
  const figure = { rect: [50, 52, 500, 163], caption, graphicsCount: 2 },
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, lines, graphicsBounds },
    context = {
      operators,
      viewport,
      content: { items, styles: { F: { ascent: 0.8, descent: -0.2, vertical: false } } },
      glyphBounds: [{ fontName: 'F', glyphs }],
      graphicsBounds
    }
  return { page, figure, captions: [caption], tables: [] as number[][], tokens, context, text }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const prove = (f: ReturnType<typeof fixture>) =>
  nativePairedRasterTailCrop(f.page, f.figure, f.captions, f.tables, f.tokens, f.context)
it('restores complete paired native text columns beyond the image margin without adding owners', () => {
  const f = fixture(),
    before = JSON.stringify(f),
    proof = prove(f)
  expect(proof?.rect).toEqual([50, 52, 500, 177])
  expect(proof?.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
it('refuses additional native lines and a competing parent', () => {
  const third = fixture()
  third.text('another unresolved continuation', 50, 187)
  expect(prove(third)).toBeUndefined()
  const competitor = fixture()
  competitor.text('(a) Other independently printed label', 50, 163)
  expect(prove(competitor)).toBeUndefined()
})
it('refuses missing font or source evidence and unequal independent text columns', () => {
  const font = fixture()
  delete (font.context.content.styles.F as { descent?: number }).descent
  expect(prove(font)).toBeUndefined()
  const source = fixture()
  source.context.content.items[1].sourceItem.text += ' absent'
  expect(prove(source)).toBeUndefined()
  const width = fixture(true)
  expect(prove(width)).toBeUndefined()
})
it('refuses invisible source text and foreign paint crossing a completed tail', () => {
  const hidden = fixture(),
    o = hidden.context.operators,
    i = o.fnArray.indexOf(OPS.beginText)
  o.fnArray.splice(i, 0, OPS.setGState)
  o.argsArray.splice(i, 0, [[['ca', 0]]])
  expect(prove(hidden)).toBeUndefined()
  const foreign = fixture()
  foreign.context.operators.fnArray.push(OPS.constructPath)
  foreign.context.operators.argsArray.push([
    OPS.fill,
    [new Float32Array([0, 80, 225, 1, 100, 225, 1, 100, 229, 1, 80, 229, 4])],
    [80, 225, 100, 229]
  ])
  expect(prove(foreign)).toBeUndefined()
})
it('checks the fixed actual PNG certificate and refuses unsafe low scale', () => {
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
  expect(nativeCompleteFormCropPngSafe(png(0.25), rect, f.page, proof)).toBe(false)
})
