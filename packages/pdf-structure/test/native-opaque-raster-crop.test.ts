import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const { nativeOpaqueRasterCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-opaque-raster-crop.mjs')).href
)

const fixture = (): ReturnType<typeof JSON.parse> => {
  const page = {
    pageNumber: 1,
    width: 200,
    height: 200,
    invalidGraphicsBounds: 0,
    lines: [
      { text: 'Plain paragraph alpha', x: 20, y: 30, width: 105, height: 10, fontSize: 10 },
      { text: 'Plain paragraph bravo', x: 20, y: 42, width: 105, height: 10, fontSize: 10 },
      { text: 'Tail.', x: 20, y: 54, width: 25, height: 10, fontSize: 10 },
      { text: 'Figure A.', x: 30, y: 132, width: 36, height: 8, fontSize: 8 }
    ],
    graphicsBounds: [] as object[]
  }
  const items = page.lines.map((l, index) => ({
    str: l.text,
    dir: 'ltr',
    width: l.width,
    height: l.fontSize,
    transform: [l.fontSize, 0, 0, l.fontSize, l.x, 200 - l.y - l.height],
    fontName: 'font',
    sourceItem: { pageNumber: 1, index, text: l.text }
  }))
  const operators: { fnArray: number[]; argsArray: unknown[] } = { fnArray: [], argsArray: [] }
  for (const i of items) {
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      ['font', i.height],
      [new Float32Array([1, 0, 0, 1, i.transform[4], i.transform[5]])],
      [
        [...i.str].map((unicode) => ({
          unicode,
          fontChar: unicode,
          originalCharCode: unicode.charCodeAt(0),
          width: 500,
          isSpace: unicode === ' ',
          isInFont: unicode !== ' '
        }))
      ],
      null
    )
  }
  operators.fnArray.push(
    OPS.save,
    OPS.eoClip,
    OPS.constructPath,
    OPS.transform,
    OPS.dependency,
    OPS.paintImageXObject,
    OPS.restore
  )
  operators.argsArray.push(
    null,
    null,
    [
      OPS.endPath,
      [new Float32Array([0, 20, 70, 1, 180, 70, 1, 180, 130, 1, 20, 130, 4])],
      new Float32Array([20, 70, 180, 130])
    ],
    [160, 0, 0, 60, 20, 70],
    ['image'],
    ['image', 160, 60],
    null
  )
  const operationIndex = operators.fnArray.length - 2
  page.graphicsBounds = [{ kind: 'image', operationIndex, normalizedRect: [0.1, 0.35, 0.9, 0.65] }]
  const caption = { page: 1, lines: ['Figure A.'], rect: [30, 132, 66, 140] },
    figure = {
      caption,
      rect: [19, 60, 181, 129],
      graphicsCount: 1,
      excludedProseLines: page.lines.slice(0, 2)
    }
  const glyphBounds = [
    {
      fontName: 'font',
      glyphs: [...new Set(items.flatMap((i) => [...i.str]))].map((fontChar) => ({
        fontChar,
        bounds: fontChar === ' ' ? [0, 0, 0, 0] : [0, -0.2, 0.5, 0.7]
      }))
    }
  ]
  const context = {
    operators,
    glyphBounds,
    viewport: {
      width: 200,
      height: 200,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 200],
      convertToViewportPoint: (x: number, y: number): number[] => [x, 200 - y]
    },
    content: { items, styles: { font: { vertical: false } } },
    graphicsBounds: page.graphicsBounds,
    opaqueRasterImages: [{ operationIndex, imageId: 'image', width: 160, height: 60, kind: 2 }]
  }
  return { page, figure, captions: [caption], tables: [], context, operationIndex }
}
it('crops an opaque last image independently of a proved preceding paragraph tail', () => {
  const f = fixture(),
    before = structuredClone(f.figure),
    result = nativeOpaqueRasterCrop(f.page, f.figure, f.captions, f.tables, f.context)
  expect(result).toEqual([20, 70, 180, 130])
  expect(f.figure).toEqual(before)
})
it.each([
  'missing opacity',
  'rgba',
  'wrong identity',
  'duplicate identity',
  'alpha',
  'blend',
  'soft mask',
  'later text',
  'unknown paint',
  'nonrect clip',
  'rotation',
  'source alias',
  'wrong literal',
  'unproved prose',
  'different cadence',
  'foreign table',
  'owned labels',
  'parts',
  'cropRects',
  'unknown graphic',
  'global clip',
  'caption ink enters image',
  'caption glyph missing'
])('keeps the old crop when opaque-raster evidence is incomplete: %s', (mode) => {
  const f = fixture(),
    o = f.context.operators,
    n = f.operationIndex
  if (mode === 'missing opacity') delete f.context.opaqueRasterImages
  if (mode === 'rgba') f.context.opaqueRasterImages[0].kind = 3
  if (mode === 'wrong identity') f.context.opaqueRasterImages[0].imageId = 'other'
  if (mode === 'duplicate identity')
    f.context.opaqueRasterImages.push({ ...f.context.opaqueRasterImages[0] })
  if (['alpha', 'blend', 'soft mask'].includes(mode)) {
    o.fnArray.unshift(OPS.setGState)
    o.argsArray.unshift([
      [mode === 'alpha' ? ['ca', 0.5] : mode === 'blend' ? ['BM', 'multiply'] : ['SMask', true]]
    ])
    f.context.opaqueRasterImages[0].operationIndex++
    f.page.graphicsBounds[0].operationIndex++
  }
  if (mode === 'later text') {
    o.fnArray.push(OPS.showText)
    o.argsArray.push([[{ unicode: 'X', width: 500 }]])
  }
  if (mode === 'unknown paint') {
    o.fnArray.push(OPS.shadingFill)
    o.argsArray.push(['unknown'])
  }
  if (mode === 'nonrect clip') o.argsArray[n - 3][1][0][3] = 2
  if (mode === 'rotation') o.argsArray[n - 2][1] = 1
  if (mode === 'source alias') f.context.content.items[0].sourceItem.index = 1
  if (mode === 'wrong literal') f.context.content.items[0].str = 'Changed'
  if (mode === 'unproved prose') delete f.figure.excludedProseLines
  if (mode === 'different cadence') f.page.lines[0].y--
  if (mode === 'foreign table') f.tables.push([20, 70, 180, 130])
  if (mode === 'owned labels') f.figure.sourceItems = [{ pageNumber: 1, index: 2, text: 'Tail.' }]
  if (mode === 'parts') f.figure.parts = []
  if (mode === 'cropRects') f.figure.cropRects = []
  if (mode === 'unknown graphic') f.page.graphicsBounds[0].operationIndex = 99
  if (mode === 'global clip') {
    o.fnArray.unshift(OPS.clip)
    o.argsArray.unshift(null)
    f.context.opaqueRasterImages[0].operationIndex++
    f.page.graphicsBounds[0].operationIndex++
  }
  if (mode === 'caption ink enters image')
    f.context.glyphBounds[0].glyphs.find((g) => g.fontChar === 'F').bounds[3] = 2
  if (mode === 'caption glyph missing')
    f.context.glyphBounds[0].glyphs = f.context.glyphBounds[0].glyphs.filter(
      (g) => g.fontChar !== 'F'
    )
  expect(nativeOpaqueRasterCrop(f.page, f.figure, f.captions, f.tables, f.context)).toBeUndefined()
})
