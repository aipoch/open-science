/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { captureNativeIsolatedRasterScope } from '../../resources/literature-pdf-isolated-raster-scope.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
export function anonymousIsolatedForm() {
  const width = 400,
    height = 400,
    operators = { fnArray: [], argsArray: [] },
    items = [],
    tokens = [],
    glyphs = [],
    graphicsBounds = [],
    viewport = {
      width,
      height,
      rotation: 0,
      scale: 1,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x, y) => [x, height - y]
    },
    add = (op, a) => {
      operators.fnArray.push(op)
      operators.argsArray.push(a)
    },
    text = (str, x, baseline) => {
      add(OPS.beginText, null)
      add(OPS.setFont, ['F', 10])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - baseline]])
      add(OPS.showText, [
        [{ unicode: str, fontChar: str, width: 500 * str.length, isInFont: true }]
      ])
      add(OPS.endText, null)
      const r = {
        str,
        dir: 'ltr',
        width: 5 * str.length,
        height: 10,
        transform: [10, 0, 0, 10, x, height - baseline],
        fontName: 'F',
        sourceItem: { pageNumber: 1, index: items.length, text: str }
      }
      items.push(r)
      tokens.push(tableTextToken(r, viewport, 0))
      glyphs.push({ fontChar: str, bounds: [0, -0.1, str.length * 0.5, 0.7] })
    }
  add(OPS.setFillRGBColor, ['#000000'])
  text('Running header', 40, 35)
  const group = {
    matrix: null,
    bbox: [60, 140, 340, 330],
    smask: null,
    isolated: true,
    knockout: false
  }
  add(OPS.beginGroup, [group])
  add(OPS.paintFormXObjectBegin, [null, null])
  add(OPS.save, null)
  add(OPS.transform, [240, 0, 0, 140, 80, 160])
  add(OPS.paintImageXObject, ['image', 100, 100])
  const im = operators.fnArray.length - 1
  add(OPS.restore, null)
  graphicsBounds.push({
    operationIndex: im,
    kind: 'image',
    normalizedRect: [0.2, 0.25, 0.8, 0.6],
    imageHash: 'a'.repeat(64)
  })
  add(OPS.setGState, [
    [
      ['CA', 0.6],
      ['ca', 0.6]
    ]
  ])
  add(OPS.constructPath, [
    OPS.fill,
    [[0, 60, 140, 1, 340, 140, 1, 340, 330, 1, 60, 330, 4]],
    [60, 140, 340, 330]
  ])
  add(OPS.setGState, [
    [
      ['CA', 1],
      ['ca', 1]
    ]
  ])
  text('Axis', 80, 90)
  text('Value', 100, 250)
  add(OPS.paintFormXObjectEnd, null)
  add(OPS.endGroup, [group])
  text('Figure 1: Shared picture.', 60, 310)
  const caption = { page: 1, lines: ['Figure 1: Shared picture.'], rect: [60, 300, 250, 312] },
    page = {
      pageNumber: 1,
      width,
      height,
      rotation: 0,
      renderRotation: 0,
      invalidGraphicsBounds: 0,
      lines: [],
      graphicsBounds
    },
    context = {
      operators,
      viewport,
      content: { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
      glyphBounds: [{ fontName: 'F', glyphs }],
      graphicsBounds
    },
    figure = { caption, rect: [40, 20, 360, 260] }
  return { args: [page, figure, [caption], [], tokens, context], text, add }
}

export function anonymousRasterRoot() {
  const f = anonymousIsolatedForm(),
    [page, figure, captions, tables, tokens, context] = f.args,
    o = context.operators
  for (const index of ['Axis', 'Value']
    .map((text) =>
      o.argsArray.findIndex(
        (args, index) => o.fnArray[index] === OPS.showText && args[0][0].unicode === text
      )
    )
    .sort((a, b) => b - a)) {
    o.fnArray.splice(index - 3, 5)
    o.argsArray.splice(index - 3, 5)
  }
  context.content.items.splice(1, 2)
  tokens.splice(1, 2)
  context.glyphBounds[0].glyphs = context.glyphBounds[0].glyphs.filter(
    (g) => !['Axis', 'Value'].includes(g.fontChar)
  )
  context.content.items.forEach((item, index) => {
    item.sourceItem.index = index
  })
  let imageIndex = o.fnArray.indexOf(OPS.paintImageXObject)
  o.fnArray.splice(imageIndex - 2, 0, OPS.paintFormXObjectBegin)
  o.argsArray.splice(imageIndex - 2, 0, [null, new Float32Array([0, 0, 400, 400])])
  imageIndex++
  o.fnArray.splice(imageIndex, 0, OPS.setGState)
  o.argsArray.splice(imageIndex, 0, [
    [
      ['BM', 'source-over'],
      ['SMask', false]
    ]
  ])
  imageIndex++
  o.fnArray.splice(imageIndex + 2, 0, OPS.paintFormXObjectEnd)
  o.argsArray.splice(imageIndex + 2, 0, [])
  context.graphicsBounds[0].operationIndex = imageIndex
  context.sourceSha256 = 'a'.repeat(64)
  context.pageNumber = 1
  const image = { kind: 3, width: 100, height: 100, data: new Uint8ClampedArray(40000) }
  image.data.fill(255)
  image.data.set([0, 0, 0, 128])
  const images = new Map([['image', image]]),
    task = {
      _internalRenderTask: {
        operatorList: o,
        params: {
          viewport: {
            ...context.viewport,
            scale: 1.5,
            width: context.viewport.width * 1.5,
            height: context.viewport.height * 1.5,
            transform: context.viewport.transform.map((value) => value * 1.5)
          }
        },
        objs: { get: (id) => images.get(id) },
        commonObjs: { get: (id) => images.get(id) }
      }
    },
    observed = {
      scanned: o.fnArray.length,
      overflow: false,
      paths: new Map(
        o.fnArray.flatMap((op, i) => (op === OPS.constructPath ? [[i, o.argsArray[i]]] : []))
      )
    }
  const capture = () => {
    context.isolatedRasterScope = captureNativeIsolatedRasterScope(context, task, observed)
    return context.isolatedRasterScope
  }
  return {
    args: f.args,
    page,
    figure,
    captions,
    tables,
    tokens,
    context,
    o,
    image,
    images,
    task,
    observed,
    capture,
    imageIndex
  }
}
