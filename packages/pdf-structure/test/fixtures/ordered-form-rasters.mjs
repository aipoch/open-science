/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'

export function anonymousOrderedFormRasters() {
  const width = 400,
    height = 500,
    operators = { fnArray: [], argsArray: [] },
    items = [],
    tokens = [],
    glyphs = [],
    graphicsBounds = [],
    opaqueRasterImages = [],
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x, y) => [x, height - y]
    },
    add = (op, args) => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
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
        width: str.length * 5,
        height: 10,
        transform: [10, 0, 0, 10, x, height - baseline],
        fontName: 'F',
        sourceItem: { pageNumber: 1, index: items.length, text: str }
      }
      items.push(r)
      tokens.push(tableTextToken(r, viewport, 0))
      glyphs.push({ fontChar: str, bounds: [0, -0.1, str.length * 0.5, 0.7] })
    },
    image = (id, rect) => {
      add(OPS.save, null)
      add(OPS.transform, [rect[2] - rect[0], 0, 0, rect[3] - rect[1], rect[0], height - rect[3]])
      add(OPS.paintImageXObject, [id, 100, 100])
      const operationIndex = operators.fnArray.length - 1
      graphicsBounds.push({
        operationIndex,
        kind: 'image',
        normalizedRect: rect.map((x, i) => x / (i % 2 ? height : width))
      })
      opaqueRasterImages.push({ operationIndex, imageId: id, width: 100, height: 100, kind: 2 })
      add(OPS.restore, null)
    }
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.paintFormXObjectBegin, [null, [100, 360, 260, 460]])
  image('one', [100, 60, 260, 140])
  text('Truth', 110, 55)
  add(OPS.paintFormXObjectEnd, null)
  text('(a) First panel', 110, 155)
  add(OPS.paintFormXObjectBegin, [null, [40, 120, 360, 315]])
  image('two', [40, 210, 360, 380])
  text('Samples', 50, 200)
  add(OPS.paintFormXObjectEnd, null)
  text('(b) Second panel', 150, 400)
  text('Figure 1. Two panels.', 40, 450)
  const caption = { page: 1, lines: ['Figure 1. Two panels.'], rect: [40, 440, 200, 452] },
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
      graphicsBounds,
      opaqueRasterImages
    },
    figure = { caption, rect: [40, 185, 360, 405], graphicsCount: 1 }
  return { args: [page, figure, [caption], [], tokens, context], text, add }
}
