/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { createCanvas } from '@napi-rs/canvas'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { anonymousIsolatedForm } from './isolated-form-figure.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'

export function anonymousCompositingFigure() {
  const f = anonymousIsolatedForm(),
    [page, , , , tokens, context] = f.args,
    o = context.operators,
    add = f.add
  o.fnArray.length = o.argsArray.length = context.content.items.length = tokens.length = 0
  context.glyphBounds[0].glyphs.length = context.graphicsBounds.length = 0
  context.pageNumber = page.pageNumber
  context.sourceSha256 = 'a'.repeat(64)
  const group = {
      matrix: null,
      bbox: [40, 150, 140, 250],
      smask: null,
      isolated: true,
      knockout: false
    },
    mask = { ...group, smask: { subtype: 'Alpha', backdrop: undefined } },
    image = {
      width: 3,
      height: 3,
      kind: 3,
      data: new Uint8Array([
        0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 200, 0, 0, 0, 200, 0, 0, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 200, 0, 0, 0, 128
      ])
    },
    path = [
      OPS.fill,
      [new Float32Array([0, 0, 0, 1, 4, 0, 1, 4, 4, 4])],
      new Float32Array([0, 0, 4, 4])
    ],
    ordinaryState = [
      [
        ['BM', 'source-over'],
        ['CA', 1],
        ['SMask', false],
        ['ca', 1]
      ]
    ],
    pattern = [
      'TilingPattern',
      null,
      {
        fnArray: [
          OPS.paintFormXObjectBegin,
          OPS.save,
          OPS.setGState,
          OPS.setFillRGBColor,
          OPS.setGState,
          OPS.constructPath,
          OPS.restore,
          OPS.paintFormXObjectEnd
        ],
        argsArray: [
          [null, new Float32Array([0, 0, 4, 4])],
          null,
          ordinaryState,
          ['#000000'],
          [
            [
              ['CA', 1],
              ['ca', 1]
            ]
          ],
          path,
          null,
          []
        ],
        length: 8
      },
      [1, 0, 0, 1, 0, 0],
      [0, 0, 4, 4],
      4,
      4,
      1,
      1
    ]
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.beginGroup, [group])
  add(OPS.paintFormXObjectBegin, [null, null])
  add(OPS.beginGroup, [mask])
  add(OPS.paintFormXObjectBegin, [null, null])
  add(OPS.save, null)
  add(OPS.transform, [100, 0, 0, 100, 40, 150])
  const imageIndex = o.fnArray.length
  add(OPS.paintImageXObject, ['mask-image', 3, 3])
  add(OPS.restore, null)
  add(OPS.paintFormXObjectEnd, [])
  add(OPS.endGroup, [mask])
  const activationIndex = o.fnArray.length
  add(OPS.setGState, [[['SMask', true]]])
  add(OPS.beginGroup, [group])
  add(OPS.paintFormXObjectBegin, [null, new Float32Array(group.bbox)])
  const patternIndex = o.fnArray.length
  add(OPS.setFillColorN, pattern)
  add(OPS.constructPath, [
    OPS.fill,
    [new Float32Array([0, 40, 150, 1, 140, 150, 1, 140, 250, 4])],
    new Float32Array(group.bbox)
  ])
  add(OPS.paintFormXObjectEnd, [])
  add(OPS.endGroup, [group])
  add(OPS.paintFormXObjectEnd, [])
  const endIndex = o.fnArray.length
  add(OPS.endGroup, [group])
  add(OPS.save, null)
  add(OPS.constructPath, [
    OPS.fill,
    [new Float32Array([0, 170, 140, 1, 250, 140, 1, 250, 240, 1, 170, 240, 4])],
    new Float32Array([170, 140, 250, 240])
  ])
  f.text('x', 180, 180)
  f.text('legend', 230, 240)
  add(OPS.restore, null)
  f.text('Figure 1: Composite view.', 40, 300)
  f.text('External prose', 40, 350)
  f.text('z', 300, 360)
  const last = context.content.items.at(-1)
  last.width = 0
  o.argsArray[o.fnArray.lastIndexOf(OPS.showText)][0][0].width = 0
  tokens[tokens.length - 1] = tableTextToken(last, context.viewport, 0)
  const caption = { page: 1, lines: ['Figure 1: Composite view.'], rect: [40, 290, 200, 302] },
    figure = { caption, rect: [40, 150, 220, 260], reason: 'native-raster-vector-strip' },
    images = [
      {
        operationIndex: imageIndex,
        imageId: 'mask-image',
        ...image,
        sourceSha256: context.sourceSha256
      }
    ]
  context.graphicsBounds.push({
    operationIndex: imageIndex,
    kind: 'image',
    normalizedRect: [0.1, 0.375, 0.35, 0.625],
    imageHash: createHash('sha256').update('3:3:3:').update(image.data).digest('hex')
  })
  context.compositingImages = images
  const rect = [40 - 4 / 3, 150 - 4 / 3, 260 + 4 / 3, 260 + 4 / 3],
    canvas = createCanvas(Math.ceil((rect[2] - rect[0]) * 4), Math.ceil((rect[3] - rect[1]) * 4)),
    ctx = canvas.getContext('2d')
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'
  for (const r of [
    [40, 150, 140, 250],
    [170, 160, 250, 260],
    [230, 233, 260, 241]
  ])
    ctx.fillRect((r[0] - rect[0]) * 4, (r[1] - rect[1]) * 4, (r[2] - r[0]) * 4, (r[3] - r[1]) * 4)
  const png = canvas.toBuffer('image/png')
  canvas.width = canvas.height = 0
  return {
    page,
    figure,
    captions: [caption],
    tables: [],
    tokens,
    context,
    images,
    image,
    o,
    imageIndex,
    activationIndex,
    patternIndex,
    endIndex,
    rect,
    png,
    args: [page, figure, [caption], [], tokens, context]
  }
}
