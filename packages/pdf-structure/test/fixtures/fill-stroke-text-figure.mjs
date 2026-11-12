/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { anonymousClosedSaveFigure } from './closed-save-figure.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'

// A complete anonymous native Form with three outlined labels and a separate
// literal caption. No external text, file identity, or renderer output is kept.
export function anonymousFillStrokeTextFigure(mode = 'normal') {
  const fixture = anonymousClosedSaveFigure(mode === 'foreign-stroke' ? 'foreign-text' : mode),
    a = fixture.args,
    context = a[5],
    o = context.operators,
    start = o.fnArray.indexOf(OPS.save),
    end = o.fnArray.indexOf(OPS.restore)
  context.pageNumber = 1
  context.sourceSha256 = 'b'.repeat(64)
  o.fnArray[start] = OPS.paintFormXObjectBegin
  o.argsArray[start] = [null, [0, 0, 400, 300]]
  o.fnArray[end] = OPS.paintFormXObjectEnd
  o.argsArray[end] = []
  const ops = [
      OPS.setStrokeRGBColor,
      OPS.setLineWidth,
      OPS.setLineJoin,
      OPS.setLineCap,
      OPS.setMiterLimit,
      OPS.setTextRenderingMode
    ],
    args = [['#000000'], [1.2], [0], [0], [4], [2]],
    firstText = o.fnArray.indexOf(OPS.beginText)
  o.fnArray.splice(firstText, 0, ...ops)
  o.argsArray.splice(firstText, 0, ...args)
  for (const g of context.graphicsBounds)
    if (g.operationIndex >= firstText) g.operationIndex += ops.length
  if (mode === 'image') {
    const at = o.fnArray.indexOf(OPS.paintFormXObjectEnd)
    o.fnArray.splice(at, 0, OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore)
    o.argsArray.splice(at, 0, null, [10, 0, 0, 10, 310, 190], ['anonymous-pixels', 4, 4], null)
    context.graphicsBounds.push({
      operationIndex: at + 2,
      kind: 'image',
      imageHash: 'c'.repeat(64),
      normalizedRect: [310 / 400, 100 / 300, 320 / 400, 110 / 300]
    })
  }
  if (mode === 'foreign-stroke') {
    const show = o.argsArray.findIndex(
        (args, i) =>
          o.fnArray[i] === OPS.showText && args?.[0]?.[0]?.unicode === 'Foreign sentence.'
      ),
      item = context.content.items.find((r) => r.str === 'Foreign sentence.')
    o.argsArray[show - 1][0][4] = item.transform[4] = 300
    o.fnArray.splice(show - 3, 0, OPS.setStrokeRGBColor, OPS.setLineWidth, OPS.setTextRenderingMode)
    o.argsArray.splice(show - 3, 0, ['#000000'], [12], [2])
    o.fnArray.splice(show + 5, 0, OPS.setTextRenderingMode)
    o.argsArray.splice(show + 5, 0, [0])
    a[4] = context.content.items.map((r) => tableTextToken(r, context.viewport, 0))
  }
  return fixture
}
