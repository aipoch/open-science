import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { nativeFigureCaptionBottomLimit: limit } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-crop-geometry.mjs')).href
)

// A native Form clips a vector plate above its caption. The recorded paint box
// is expanded to page bins and reaches the first caption line.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function example() {
  const graphicsBounds = [
    { operationIndex: 1, kind: 'path', normalizedRect: [0.04, 0.1953125, 0.96, 0.609375] }
  ]
  const content = {
    styles: { F: { ascent: 0.8, descent: -0.2, vertical: false } },
    items: [
      {
        str: 'Panel label',
        dir: 'ltr',
        width: 60,
        height: 10,
        transform: [10, 0, 0, 10, 40, 210],
        fontName: 'F'
      },
      {
        str: 'Figure 1: An anonymous plate.',
        dir: 'ltr',
        width: 180,
        height: 10,
        transform: [10, 0, 0, 10, 20, 188],
        fontName: 'F'
      }
    ].map((item, index) => ({ ...item, sourceItem: { pageNumber: 1, index, text: item.str } }))
  }
  return {
    page: { pageNumber: 1, width: 500, height: 500, invalidGraphicsBounds: 0, graphicsBounds },
    figure: {
      rect: [20, 100, 480, 304.6875],
      caption: { page: 1, lines: ['Figure 1: An anonymous plate.'], rect: [20, 302, 480, 324] }
    },
    context: {
      graphicsBounds,
      content,
      viewport: {
        width: 500,
        height: 500,
        scale: 1,
        rotation: 0,
        transform: [1, 0, 0, -1, 0, 500]
      },
      operators: {
        fnArray: [OPS.paintFormXObjectBegin, OPS.constructPath, OPS.paintFormXObjectEnd],
        argsArray: [
          [null, [20, 200, 480, 400]],
          [
            OPS.fill,
            [new Float32Array([0, 0, 0, 1, 500, 0, 1, 500, 500, 1, 0, 500, 4])],
            [0, 0, 500, 500]
          ],
          []
        ] as unknown[][]
      }
    }
  }
}

it('excludes caption ink only when native clipping proves that all plate paint ends earlier', () => {
  const x = example(),
    before = JSON.stringify(x)
  expect(limit(x.page, x.figure, x.context)).toBe(301.5)
  expect(JSON.stringify(x)).toBe(before)
})

it('uses the actual image transform when a raster paint box reaches the caption', () => {
  const x = example()
  x.context.operators.fnArray = [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore]
  x.context.operators.argsArray = [[], [460, 0, 0, 200, 20, 200], ['image', 460, 200], []]
  x.page.graphicsBounds[0] = { ...x.page.graphicsBounds[0], operationIndex: 2, kind: 'image' }
  expect(limit(x.page, x.figure, x.context)).toBe(301.5)
})

it('preserves a rotated label whose full native font envelope ends before the caption strip', () => {
  const x = example()
  x.context.content.items[0].transform = [7, 7, -7, 7, 40, 220]
  x.context.content.items[0].height = Math.hypot(7, 7)
  expect(limit(x.page, x.figure, x.context)).toBe(301.5)
})

it('refuses caption trimming when a rotated label descender reaches the strip', () => {
  const x = example()
  x.context.content.items[0].transform = [7, 7, -7, 7, 40, 199]
  x.context.content.items[0].height = Math.hypot(7, 7)
  expect(limit(x.page, x.figure, x.context)).toBe(500)
})

it.each([
  'no context',
  'other page',
  'unknown graphics',
  'wrong operation',
  'unclipped paint',
  'unbound source',
  'wrong source',
  'foreign label',
  'unknown font',
  'label em box',
  'mirrored label',
  'stroked label',
  'positioned accent',
  'caption mismatch',
  'malformed paint'
])('preserves the established crop without full strip ownership: %s', (variant) => {
  const x: ReturnType<typeof JSON.parse> = example()
  if (variant === 'no context') x.context = undefined
  if (variant === 'other page') x.figure.caption.page = 2
  if (variant === 'unknown graphics') x.page.invalidGraphicsBounds = 1
  if (variant === 'wrong operation') x.page.graphicsBounds[0].operationIndex = 2
  if (variant === 'unclipped paint') x.context.operators.argsArray[0][1] = [20, 100, 480, 400]
  if (variant === 'unbound source') delete x.context.content.items[0].sourceItem
  if (variant === 'wrong source') x.context.content.items[0].sourceItem.text = 'Different source'
  if (variant === 'unknown font') delete x.context.content.styles.F.descent
  if (variant === 'label em box') {
    x.context.content.styles.F.ascent = 0.1
    x.context.content.items[0].transform[5] = 201
  }
  if (variant === 'mirrored label') x.context.content.items[0].transform = [10, 0, 0, -10, 40, 202]
  if (variant === 'stroked label') {
    x.context.content.items[0].transform[5] = 202
    x.context.operators.fnArray.unshift(OPS.setTextRenderingMode, OPS.setLineWidth)
    x.context.operators.argsArray.unshift([2], [10])
    x.page.graphicsBounds[0].operationIndex += 2
  }
  if (variant === 'positioned accent') {
    x.context.operators.fnArray.push(OPS.showText)
    x.context.operators.argsArray.push([[{ accent: { fontChar: 'x', offset: { x: 0, y: 10 } } }]])
  }
  if (variant === 'caption mismatch') x.figure.caption.lines = ['Different caption.']
  if (variant === 'malformed paint') x.page.graphicsBounds[0].normalizedRect[2] = NaN
  if (variant === 'foreign label') {
    x.context.content.items[0].transform[5] = 195
  }
  expect(limit(x.page, x.figure, x.context)).toBe(500)
})
