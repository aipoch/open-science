import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { createCanvas } from '@napi-rs/canvas'
const { anonymousScriptedArray } = await import(
  pathToFileURL(resolve('test/fixtures/open-axis-scripted-array.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
// Keep the existing anonymous native operator fixture. Only its three zero ticks
// become complete, centered panel keys; each face retains two numeric ticks.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function keyedArray() {
  const f = anonymousScriptedArray(),
    a = f.args,
    context = a[6]
  let n = 0
  for (const raw of context.content.items) {
    if (raw.str !== '0') continue
    const label = `(${String.fromCharCode(97 + n)})`,
      x = 82.5 + n * 110,
      y = 200,
      size = 5
    const show = context.operators.argsArray.find(
      (z: unknown[], i: number) =>
        context.operators.fnArray[i] === OPS.showText &&
        z[0][0].unicode === '0' &&
        context.operators.argsArray[i - 1][0][4] === raw.transform[4]
    )
    show[0][0] = { ...show[0][0], unicode: label, fontChar: label, width: 1500 }
    const showIndex = context.operators.argsArray.indexOf(show)
    context.operators.argsArray[showIndex - 1] = [[1, 0, 0, 1, x, a[0].height - y]]
    Object.assign(raw, {
      str: label,
      width: size * 1.5,
      transform: [size, 0, 0, size, x, a[0].height - y],
      sourceItem: { ...raw.sourceItem, text: label }
    })
    context.glyphBounds[0].glyphs.push({ fontChar: label, bounds: [0, -0.1, 1.5, 0.7] })
    const index = a[5].findIndex(
      (t: { sourceItem: { index: number } }) => t.sourceItem.index === raw.sourceItem.index
    )
    a[5][index] = tableTextToken(raw, context.viewport, 0)
    n++
  }
  return f
}
it('completes the original bounded plot Form without adding graph text owners', () => {
  const { args: a } = keyedArray(),
    before = JSON.stringify(a)
  const figures = associateFigures(...a)
  expect(figures).toHaveLength(1)
  expect(figures[0].rect).toEqual([30, 60, 370, 215])
  expect(figures[0].sourceItems).toEqual(figures[0].fallbackFigure.sourceItems)
  expect(figures[0].fallbackFigure.rect).toEqual([50, 80, 350, 185])
  expect(JSON.stringify(a)).toBe(before)
})
const { nativeCompleteFormCrop, nativeCompleteFormCropPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-complete-form.mjs')).href
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function stackedArrays() {
  const first = anonymousScriptedArray(),
    second = anonymousScriptedArray(),
    height = 500,
    page = { ...first.args[0], height, graphicsBounds: [], lines: [] },
    context = {
      ...first.args[6],
      viewport: {
        ...first.args[6].viewport,
        height,
        transform: [1, 0, 0, -1, 0, height],
        convertToViewportPoint: (x: number, y: number) => [x, height - y]
      },
      operators: { fnArray: [], argsArray: [] },
      content: { items: [], styles: first.args[6].content.styles },
      graphicsBounds: []
    },
    tokens = [],
    rules = []
  for (const [n, source] of [first, second].entries()) {
    const a = source.args,
      delta = n * 190,
      translation = 200 - delta,
      offset = context.operators.fnArray.length + 2,
      label = `(${String.fromCharCode(97 + n)})`
    const captionGlyph = a[6].operators.argsArray.find(
      (z: unknown[], i: number) =>
        a[6].operators.fnArray[i] === OPS.showText && z[0][0].unicode === 'C'
    )[0][0]
    Object.assign(captionGlyph, { unicode: label, fontChar: label, width: 1500 })
    context.operators.fnArray.push(OPS.save, OPS.transform, ...a[6].operators.fnArray, OPS.restore)
    context.operators.argsArray.push(
      [],
      [1, 0, 0, 1, 0, translation],
      ...a[6].operators.argsArray,
      []
    )
    for (const raw of a[6].content.items) {
      raw.transform[5] += translation
      if (raw.str === 'C') Object.assign(raw, { str: label, width: 12 })
      raw.sourceItem = { pageNumber: 1, index: context.content.items.length, text: raw.str }
      context.content.items.push(raw)
      tokens.push(tableTextToken(raw, context.viewport, 0))
    }
    context.glyphBounds[0].glyphs.push({ fontChar: label, bounds: [0, -0.1, 1.5, 0.7] })
    const graphics = a[0].graphicsBounds.map(
      (g: { operationIndex: number; normalizedRect: number[] }) => ({
        ...g,
        operationIndex: g.operationIndex + offset,
        normalizedRect: g.normalizedRect.map((v: number, i: number) =>
          i % 2 ? (v * 300 + delta) / height : v
        )
      })
    )
    page.graphicsBounds.push(...graphics)
    rules.push(...a[3].map((r: number[]) => r.map((v, i) => v + (i % 2 ? delta : 0))))
  }
  context.graphicsBounds = page.graphicsBounds
  const caption = { page: 1, lines: ['Figure 1. Two rows.'], rect: [30, 445, 370, 460] },
    figure = { rect: [25, 227, 375, 426], caption },
    args = [page, [caption], [], rules, [], tokens, context]
  return { args, figure }
}
it('completes both matching native rows with complete external panel keys', () => {
  const { args: a, figure } = stackedArrays(),
    before = JSON.stringify(a)
  expect(nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6])?.rect).toEqual([
    25, 60, 375, 426
  ])
  expect(JSON.stringify(a)).toBe(before)
})
it('refuses a Form without the complete repeated panel-key witnesses', () => {
  const { args: a, figure } = anonymousScriptedArray()
  expect(nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
})
it('refuses missing native font evidence rather than using source boxes alone', () => {
  const { args: a, figure } = keyedArray()
  a[6].glyphBounds = []
  expect(nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
})
it('refuses external source ink inside the completed Form', () => {
  const { args: a, figure } = keyedArray(),
    raw = a[6].content.items.at(-1),
    o = a[6].operators
  raw.transform[4] = 35
  raw.transform[5] = a[0].height - 70
  const show = o.fnArray.lastIndexOf(OPS.showText)
  o.argsArray[show - 1] = [[1, 0, 0, 1, 35, a[0].height - 70]]
  a[5][a[5].length - 1] = tableTextToken(raw, a[6].viewport, 0)
  expect(nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
})
it('refuses a competing table at the new boundary', () => {
  const { args: a, figure } = keyedArray()
  expect(nativeCompleteFormCrop(a[0], figure, a[1], [[31, 61, 39, 69]], a[5], a[6])).toBeUndefined()
})
it.each(['white', 'transparent'])('refuses an invisible external panel key: %s', (kind) => {
  const { args: a, figure } = stackedArrays(),
    o = a[6].operators,
    show = o.fnArray.findIndex(
      (op: number, i: number) => op === OPS.showText && o.argsArray[i][0][0].unicode === '(a)'
    ),
    start = o.fnArray.lastIndexOf(OPS.beginText, show),
    end = o.fnArray.indexOf(OPS.endText, show),
    op = kind === 'white' ? OPS.setFillRGBColor : OPS.setGState,
    before = kind === 'white' ? ['#ffffff'] : [[['ca', 0]]],
    after = kind === 'white' ? ['#000000'] : [[['ca', 1]]]
  o.fnArray.splice(end + 1, 0, op)
  o.argsArray.splice(end + 1, 0, after)
  o.fnArray.splice(start, 0, op)
  o.argsArray.splice(start, 0, before)
  for (const g of a[0].graphicsBounds)
    g.operationIndex += (g.operationIndex >= start ? 1 : 0) + (g.operationIndex > end ? 1 : 0)
  expect(nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
})
it('refuses independent foreign paint inside the completed Form', () => {
  const { args: a, figure } = keyedArray(),
    o = a[6].operators,
    index = o.fnArray.length
  o.fnArray.push(OPS.constructPath)
  o.argsArray.push([
    OPS.fill,
    [[0, 31, 239, 1, 39, 239, 1, 39, 231, 1, 31, 231, 4]],
    [31, 231, 39, 239]
  ])
  a[0].graphicsBounds.push({
    operationIndex: index,
    kind: 'path',
    normalizedRect: [31 / 400, 61 / 300, 39 / 400, 69 / 300]
  })
  expect(nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
})
it('checks the actual PNG scale and refuses a byte-retry footprint or malformed image', () => {
  const { args: a, figure } = keyedArray(),
    proof = nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6]),
    rect = proof.rect.map((v: number, i: number) => v + (i < 2 ? -4 / 3 : 4 / 3)),
    png = (scale: number): Buffer =>
      createCanvas(
        Math.ceil((rect[2] - rect[0]) * scale),
        Math.ceil((rect[3] - rect[1]) * scale)
      ).toBuffer('image/png'),
    candidate = { formCropRaster: proof.formCropRaster }
  expect(nativeCompleteFormCropPngSafe(png(4), rect, a[0], candidate)).toBe(true)
  expect(nativeCompleteFormCropPngSafe(png(0.5), rect, a[0], candidate)).toBe(false)
  expect(nativeCompleteFormCropPngSafe(Buffer.from('invalid'), rect, a[0], candidate)).toBe(false)
})
