import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { collectTableRules, collectClosedFigureFrames } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { nativePageTextPacketInventory } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
function sample(mode = ''): ReturnType<typeof JSON.parse> {
  const rows: [string, number, number][] = [
      ['Table 1: Native records', 180, 95],
      ...['Label', 'A', 'B', 'C', 'D'].map((s, i): [string, number, number] => [
        s,
        90 + i * 85,
        115
      ]),
      ...['Value', '1', '2', '3', '4'].map((s, i): [string, number, number] => [
        s,
        90 + i * 85,
        135
      ]),
      ...['Total', '5', '6', '7', '8'].map((s, i): [string, number, number] => [
        s,
        90 + i * 85,
        150
      ]),
      ['Figure 1: Native schematic', 60, 310],
      ['Independent explanation.', 60, 360]
    ],
    items = rows.map(([str, x, y], index) => ({
      str,
      dir: 'ltr',
      width: str.length * 4,
      height: 10,
      transform: [10, 0, 0, 10, x, 800 - y],
      fontName: 'native',
      sourceItem: { pageNumber: 1, index, text: str }
    })),
    o: ReturnType<typeof JSON.parse> = { fnArray: [], argsArray: [] },
    emit = (code: number, args: unknown): void => {
      o.fnArray.push(code)
      o.argsArray.push(args)
    },
    paths: number[][] = []
  for (const i of items) {
    emit(OPS.beginText, null)
    emit(OPS.setFont, ['native', 10])
    emit(OPS.setTextMatrix, [[1, 0, 0, 1, i.transform[4], i.transform[5]]])
    emit(OPS.showText, [
      Array.from(i.str, (c) => ({
        originalCharCode: c.codePointAt(0),
        unicode: c,
        fontChar: c,
        width: 400,
        isInFont: true,
        isSpace: c === ' '
      }))
    ])
    emit(OPS.endText, null)
  }
  emit(OPS.setLineWidth, [0.4])
  for (const x of [220, 290, 360, 430])
    for (const [a, b] of [
      [105, 120],
      [125, 140],
      [140, 155]
    ])
      paths.push([x, a, x, b])
  paths.push(
    [80, 125, 520, 125],
    [60, 180, 540, 180],
    [60, 180, 60, 280],
    [540, 180, 540, 280],
    [60, 280, 540, 280]
  )
  const graphics = paths.map((r) => {
    const operationIndex = o.fnArray.length
    emit(OPS.constructPath, [
      OPS.stroke,
      [[0, r[0], 800 - r[1], 1, r[2], 800 - r[3]]],
      [
        Math.min(r[0], r[2]),
        800 - Math.max(r[1], r[3]),
        Math.max(r[0], r[2]),
        800 - Math.min(r[1], r[3])
      ]
    ])
    return {
      kind: 'path',
      operationIndex,
      normalizedRect: [
        r[0] - (r[0] === r[2] ? 0.2 : 0),
        r[1] - (r[1] === r[3] ? 0.2 : 0),
        r[2] + (r[0] === r[2] ? 0.2 : 0),
        r[3] + (r[1] === r[3] ? 0.2 : 0)
      ].map((n, i) => n / (i % 2 ? 800 : 600))
    }
  })
  emit(OPS.save, null)
  emit(OPS.transform, [480, 0, 0, 100, 60, 520])
  const imageIndex = o.fnArray.length
  emit(OPS.paintImageXObject, ['native-image', 480, 100])
  emit(OPS.restore, null)
  graphics.push({
    kind: 'image',
    operationIndex: imageIndex,
    normalizedRect: [60 / 600, 180 / 800, 540 / 600, 280 / 800]
  })
  const viewport = {
      width: 600,
      height: 800,
      rotation: 0,
      scale: 1,
      transform: [1, 0, 0, -1, 0, 800],
      convertToViewportPoint: (x, y) => [x, 800 - y]
    },
    content = { items, styles: { native: { ascent: 0.8, descent: -0.2, vertical: false } } },
    page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      rotation: 0,
      invalidGraphicsBounds: 0,
      graphicsBounds: graphics,
      lines: items.map((i) => ({
        text: i.str,
        x: i.transform[4],
        y: 800 - i.transform[5] - 10,
        width: i.width,
        height: 10,
        fontSize: 10
      }))
    },
    context = {
      content: structuredClone(content),
      operators: o,
      viewport,
      graphicsBounds: graphics,
      glyphBounds: [
        {
          fontName: 'native',
          glyphs: [...new Set(items.flatMap((i) => [...i.str]))].map((c) => ({
            fontChar: c,
            bounds: c === ' ' ? [0, 0, 0, 0] : [0, 0, 0.4, 0.7]
          }))
        }
      ],
      sourceSha256: 'a'.repeat(64)
    },
    captions = [0, 16].map((index) => ({
      page: 1,
      lines: [items[index].str],
      rect: [
        items[index].transform[4],
        800 - items[index].transform[5] - 10,
        items[index].transform[4] + items[index].width,
        800 - items[index].transform[5]
      ]
    }))
  if (mode === 'native-glyph-missing') context.glyphBounds[0].glyphs.pop()
  if (mode === 'frame-gap') {
    const i = graphics[14].operationIndex
    o.argsArray[i][1][0][2] -= 5
    o.argsArray[i][2][3] -= 5
    graphics[14].normalizedRect[1] += 5 / 800
  }
  if (mode === 'foreign-paint') {
    const i = o.fnArray.length
    emit(OPS.constructPath, [
      OPS.fill,
      [[0, 300, 600, 1, 310, 600, 1, 310, 590, 1, 300, 590, 4]],
      [300, 590, 310, 600]
    ])
    graphics.push({
      kind: 'path',
      operationIndex: i,
      normalizedRect: [0.5, 0.25, 310 / 600, 210 / 800]
    })
  }
  if (mode === 'missing-table-caption') captions.shift()
  const tokens = content.items.map((i) => tableTextToken(i, viewport, 0))
  return {
    page,
    context,
    tokens,
    captions,
    rules: collectTableRules(o, viewport),
    frames: collectClosedFigureFrames(o, viewport)
  }
}
it('separates a completely framed native raster from an independently captioned table', () => {
  const f = sample(),
    before = JSON.stringify(f)
  expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeDefined()
  const result = associateFigures(f.page, f.captions, [], f.rules, f.frames, f.tokens, f.context)
  expect(result).toHaveLength(1)
  expect(result[0].rect).toEqual([
    58.46666666666666, 178.46666666666667, 541.5333333333334, 281.5333333333333
  ])
  expect(result[0].fallbackFigure.rect).toEqual([59.8, 124.8, 540.2, 280.2])
  expect(result[0].sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
it.each(['native-glyph-missing', 'frame-gap', 'foreign-paint', 'missing-table-caption'])(
  'keeps ordinary raster association when independent frame proof is incomplete: %s',
  (mode) => {
    const f = sample(mode),
      before = JSON.stringify(f)
    const result = associateFigures(f.page, f.captions, [], f.rules, f.frames, f.tokens, f.context)
    expect(result).toHaveLength(1)
    expect(result[0].rect).toEqual([59.8, 124.8, 540.2, 280.2])
    expect(result[0].formCropRaster).toBeUndefined()
    expect(JSON.stringify(f)).toBe(before)
  }
)
