import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { createCanvas } from '@napi-rs/canvas'
const { anonymousScriptedArray } = await import(
  pathToFileURL(resolve('test/fixtures/open-axis-scripted-array.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
// Reuse the anonymous native font/operator fixture, preserving its numeric axes.
// Remove its unrelated mathematical fragments rather than weakening their guards.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function legend() {
  const f = anonymousScriptedArray(),
    a = f.args,
    c = a[6],
    o = c.operators,
    end = o.fnArray.indexOf(OPS.paintFormXObjectEnd),
    start = o.fnArray.lastIndexOf(OPS.beginText, end)
  o.fnArray.splice(start, end - start)
  o.argsArray.splice(start, end - start)
  c.content.items = c.content.items.filter((r) => !['A', 'u', 'v', 'B'].includes(r.str))
  for (const [index, raw] of c.content.items.entries())
    raw.sourceItem = { ...raw.sourceItem, index }
  a[5] = c.content.items.map((r) => tableTextToken(r, c.viewport, 0))
  const add = (op, z): void => {
      o.fnArray.push(op)
      o.argsArray.push(z)
    },
    path = (r, kind = OPS.stroke): void => {
      const [x, y, X, Y] = r,
        p =
          kind === OPS.stroke
            ? [0, x, 300 - y, 1, X, 300 - Y]
            : [0, x, 300 - y, 1, X, 300 - y, 1, X, 300 - Y, 1, x, 300 - Y, 4]
      add(OPS.constructPath, [kind, [p], [x, 300 - Y, X, 300 - y]])
    },
    show = (str, x, y): void => {
      add(OPS.beginText, null)
      add(OPS.setFont, ['F', 6])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, x, 300 - y]])
      add(OPS.showText, [
        [
          {
            unicode: str,
            fontChar: str,
            width: str.length * 500,
            isInFont: true,
            isSpace: false,
            accent: null
          }
        ]
      ])
      add(OPS.endText, null)
      const raw = {
        str,
        dir: 'ltr',
        width: str.length * 3,
        height: 6,
        transform: [6, 0, 0, 6, x, 300 - y],
        fontName: 'F',
        hasEOL: false,
        sourceItem: { pageNumber: 1, index: c.content.items.length, text: str }
      }
      c.content.items.push(raw)
      c.glyphBounds[0].glyphs.push({ fontChar: str, bounds: [0, -0.1, str.length * 0.5, 0.7] })
      a[5].push(tableTextToken(raw, c.viewport, 0))
    }
  const firstPath = o.fnArray.indexOf(OPS.constructPath)
  o.argsArray[firstPath] = [
    OPS.fill,
    [[0, 30, 240, 1, 370, 240, 1, 370, 55, 1, 30, 55, 4]],
    [30, 55, 370, 240]
  ]
  o.argsArray[0] = [null, [30, 55, 370, 240]]
  a[0].graphicsBounds[0].normalizedRect = [30 / 400, 60 / 300, 370 / 400, 245 / 300]
  const cap = c.content.items.at(-1),
    lastShow = o.fnArray.lastIndexOf(OPS.showText)
  cap.transform[5] = 30
  a[5][a[5].length - 1] = tableTextToken(cap, c.viewport, 0)
  o.argsArray[lastShow - 1] = [[1, 0, 0, 1, 50, 30]]
  a[1][0].rect = [30, 260, 370, 280]
  const colors = ['#cc0000', '#00aa00', '#0000cc']
  add(OPS.setLineWidth, [0.5])
  for (let n = 0; n < 3; n++) {
    add(OPS.setStrokeRGBColor, [colors[n]])
    path([60 + n * 110, 100, 100 + n * 110, 120])
  }
  add(OPS.setFillRGBColor, ['#ffffff'])
  path([90, 195, 300, 220], OPS.fill)
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setLineWidth, [2])
  for (let n = 0; n < 3; n++) {
    const x = n === 2 ? 230 : 110,
      y = n === 1 ? 214 : 204
    add(OPS.setStrokeRGBColor, [colors[n]])
    path([x - 18, y - 3, x - 3, y - 3])
    show(['Alpha', 'Bravo', 'Gamma'][n], x, y)
  }
  return f
}
it('completes an exclusive two-row native legend without adding text owners', () => {
  const { args: a } = legend(),
    before = JSON.stringify(a),
    figures = associateFigures(...a)
  expect(figures).toHaveLength(1)
  expect(figures[0].rect).toEqual([30, 60, 370, 245])
  expect(figures[0].fallbackFigure.rect).toEqual([50, 80, 350, 185])
  expect(figures[0].sourceItems).toEqual(figures[0].fallbackFigure.sourceItems)
  expect(JSON.stringify(a)).toBe(before)
})
it.each(['white', 'transparent'])(
  'keeps the original crop for an invisible legend label: %s',
  (kind) => {
    const { args: a } = legend(),
      o = a[6].operators,
      show = o.fnArray.findIndex(
        (op, i) => op === OPS.showText && o.argsArray[i][0][0].unicode === 'Alpha'
      ),
      begin = o.fnArray.lastIndexOf(OPS.beginText, show),
      end = o.fnArray.indexOf(OPS.endText, show),
      op = kind === 'white' ? OPS.setFillRGBColor : OPS.setGState
    o.fnArray.splice(end + 1, 0, op)
    o.argsArray.splice(end + 1, 0, kind === 'white' ? ['#000000'] : [[['ca', 1]]])
    o.fnArray.splice(begin, 0, op)
    o.argsArray.splice(begin, 0, kind === 'white' ? ['#ffffff'] : [[['ca', 0]]])
    expect(associateFigures(...a)[0].rect).toEqual([50, 80, 350, 185])
    expect(associateFigures(...a)[0].fallbackFigure).toBeUndefined()
  }
)
it('refuses a key without a matching visible curve in the existing plot', () => {
  const { args: a } = legend(),
    o = a[6].operators,
    last = o.fnArray.lastIndexOf(OPS.setStrokeRGBColor)
  o.argsArray[last] = ['#778899']
  expect(associateFigures(...a)[0].fallbackFigure).toBeUndefined()
})
it('refuses independent paint over the newly recovered labels', () => {
  const { args: a } = legend(),
    o = a[6].operators
  o.fnArray.push(OPS.constructPath)
  o.argsArray.push([
    OPS.fill,
    [[0, 112, 98, 1, 120, 98, 1, 120, 92, 1, 112, 92, 4]],
    [112, 92, 120, 98]
  ])
  expect(associateFigures(...a)[0].fallbackFigure).toBeUndefined()
})
it('refuses a dark plate rather than treating its box as a visible legend', () => {
  const { args: a } = legend(),
    o = a[6].operators
  o.argsArray[o.fnArray.indexOf(OPS.setFillRGBColor)] = ['#000000']
  expect(associateFigures(...a)[0].fallbackFigure).toBeUndefined()
})
it('refuses two independent painted keys beside the same source label', () => {
  const { args: a } = legend(),
    o = a[6].operators,
    i = o.fnArray.findIndex(
      (op, n) => op === OPS.showText && o.argsArray[n][0][0].unicode === 'Alpha'
    ),
    key = o.fnArray.lastIndexOf(OPS.constructPath, i)
  o.fnArray.splice(key, 0, OPS.constructPath)
  o.argsArray.splice(key, 0, structuredClone(o.argsArray[key]))
  expect(associateFigures(...a)[0].fallbackFigure).toBeUndefined()
})
it('binds rectangle and line programs to their declared native bounds', () => {
  const admitted = ['plate', 'marker'].map((kind) => {
    const { args: a } = legend(),
      o = a[6].operators,
      show = o.fnArray.findIndex(
        (op, i) => op === OPS.showText && o.argsArray[i][0][0].unicode === 'Alpha'
      ),
      index =
        kind === 'plate'
          ? o.fnArray.indexOf(OPS.constructPath)
          : o.fnArray.lastIndexOf(OPS.constructPath, show),
      points = o.argsArray[index][1][0]
    points[4] -= 1
    if (kind === 'plate') points[7] -= 1
    return associateFigures(...a)[0].fallbackFigure !== undefined
  })
  expect(admitted).toEqual([false, false])
})
it('checks encoded PNG rounding and refuses low-resolution or malformed exports', async () => {
  const { args: a } = legend(),
    candidate = associateFigures(...a)[0],
    rect = candidate.rect.map((v, i) => v + (i < 2 ? -4 / 3 : 4 / 3)),
    { nativeCompleteFormCropPngSafe } = await import(
      pathToFileURL(resolve('resources/literature-pdf-figure-native-complete-form.mjs')).href
    ),
    png = (scale): Buffer =>
      createCanvas(
        Math.ceil((rect[2] - rect[0]) * scale),
        Math.ceil((rect[3] - rect[1]) * scale)
      ).toBuffer('image/png')
  expect(nativeCompleteFormCropPngSafe(png(4), rect, a[0], candidate)).toBe(true)
  expect(nativeCompleteFormCropPngSafe(png(0.125), rect, a[0], candidate)).toBe(false)
  expect(nativeCompleteFormCropPngSafe(Buffer.from('invalid'), rect, a[0], candidate)).toBe(false)
  expect(candidate.fallbackFigure.rect).toEqual([50, 80, 350, 185])
})
