import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { resolve } from './paths'
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { nativeClippedGridCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-clipped-grid.mjs')).href
)
const { nativePlotPacketInventory } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { nativeCompleteFormCropPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-complete-form.mjs')).href
)

// Anonymous complete PDF operators, original text/font records and exact clips.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture({ numeric = true, count = 9, opacity = 1, foreign = false } = {}) {
  const width = 600,
    height = 600,
    items: ReturnType<typeof JSON.parse>[] = [],
    tokens: ReturnType<typeof JSON.parse>[] = [],
    glyphs: object[] = [],
    graphicsBounds: object[] = [],
    operators = { fnArray: [] as number[], argsArray: [] as unknown[] }
  const viewport = {
    width,
    height,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, height],
    convertToViewportPoint: (x: number, y: number) => [x, height - y]
  }
  const add = (op: number, a: unknown): void => {
    operators.fnArray.push(op)
    operators.argsArray.push(a)
  }
  const path = (r: number[], clip = false): void => {
    const [x0, y0, x1, y1] = r,
      index = operators.fnArray.length
    const p = clip
      ? [0, x0, height - y0, 1, x1, height - y0, 1, x1, height - y1, 1, x0, height - y1, 4]
      : [0, x0, height - y0, 1, x1, height - y1]
    add(OPS.constructPath, [
      clip ? OPS.endPath : OPS.stroke,
      [p],
      [x0, height - y1, x1, height - y0]
    ])
    graphicsBounds.push({
      operationIndex: index,
      kind: 'path',
      normalizedRect: [x0 / width, y0 / height, x1 / width, y1 / height]
    })
  }
  const text = (str: string, x: number, y: number): void => {
    add(OPS.beginText, null)
    add(OPS.setFont, ['F', 6])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - y]])
    add(OPS.setGState, [[['ca', opacity]]])
    add(OPS.showText, [
      [{ unicode: str, fontChar: str, width: 500 * str.length, isInFont: true, accent: null }]
    ])
    add(OPS.endText, null)
    if (!glyphs.some((g: ReturnType<typeof JSON.parse>) => g.fontChar === str))
      glyphs.push({ fontChar: str, bounds: [0, -0.1, 0.5 * str.length, 0.7] })
    const raw = {
      str,
      dir: 'ltr',
      width: 3 * str.length,
      height: 6,
      transform: [6, 0, 0, 6, x, height - y],
      fontName: 'F',
      hasEOL: false,
      sourceItem: { pageNumber: 1, index: items.length, text: str }
    }
    items.push(raw)
    tokens.push(tableTextToken(raw, viewport, 0))
  }
  add(OPS.paintFormXObjectBegin, [null, [40, 110, 560, 560]])
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.5])
  for (let n = 0; n < count; n++) {
    const x = 70 + (n % 3) * 160,
      y = 60 + Math.floor(n / 3) * 140
    add(OPS.save, null)
    add(OPS.clip, null)
    path([x, y, x + 120, y + 100], true)
    for (const offset of [22, 72]) path([x, y + offset, x + 120, y + offset])
    for (const offset of [21.5, 81.5]) path([x + offset, y, x + offset, y + 100])
    add(OPS.restore, null)
    text(numeric ? '0' : 'a', x - 8, y + 25)
    text(numeric ? '1' : 'b', x - 8, y + 75)
    text(numeric ? '0' : 'a', x + 20, y + 111)
    text(numeric ? '1' : 'b', x + 80, y + 111)
  }
  add(OPS.paintFormXObjectEnd, null)
  if (foreign) text('Body', 60, 100)
  text('Caption', 50, 530)
  const caption = { page: 1, rect: [40, 520, 560, 540], lines: ['Caption'] },
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, lines: [], graphicsBounds },
    figure = { caption, rect: [50, 201, 550, 490], reason: 'native-vector-chart-strip' }
  const context = {
    viewport,
    operators,
    content: { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
    glyphBounds: [{ fontName: 'F', glyphs }],
    graphicsBounds
  }
  return { page, figure, captions: [caption], tokens, context }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const crop = (f: ReturnType<typeof fixture>) =>
  nativeClippedGridCrop(f.page, f.figure, f.captions, [], f.tokens, f.context)

it('completes a leading chart row from whole Form ownership without widening ordinary text state', () => {
  const f = fixture(),
    before = JSON.stringify(f),
    result = crop(f)
  expect(
    nativePlotPacketInventory(f.page, f.figure, f.captions, [], [], f.tokens, f.context)
  ).toBeUndefined()
  expect(result.rect).toEqual([40, 40, 560, 490])
  expect(JSON.stringify(f)).toBe(before)
})
it.each([{ numeric: false }, { count: 8 }, { opacity: 0.5 }, { foreign: true }])(
  'refuses incomplete axes, panels, opacity or external prose: %j',
  (options) => {
    expect(crop(fixture(options))).toBeUndefined()
  }
)
it('retains the actual encoded PNG guard when the owned Form cannot fit a full pixel', () => {
  const f = fixture(),
    result = crop(f),
    rect = [38.666666666666664, 38.666666666666664, 561.3333333333334, 491.3333333333333]
  expect(result).toBeDefined()
  expect(
    nativeCompleteFormCropPngSafe(createCanvas(16, 16).toBuffer('image/png'), rect, f.page, result)
  ).toBe(false)
})
