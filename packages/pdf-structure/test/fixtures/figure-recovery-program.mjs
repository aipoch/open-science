/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { anonymousIsolatedForm } from './isolated-form-figure.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
export function anonymousNestedRecovery() {
  const f = anonymousIsolatedForm(),
    [page, , , , , c] = f.args
  c.pageNumber = page.pageNumber
  c.sourceSha256 = 'a'.repeat(64)
  const o = c.operators,
    begin = o.fnArray.indexOf(OPS.paintFormXObjectBegin) + 1,
    end = o.fnArray.indexOf(OPS.paintFormXObjectEnd),
    group = structuredClone(o.argsArray[o.fnArray.indexOf(OPS.beginGroup)][0])
  o.fnArray.splice(end, 0, OPS.endGroup)
  o.argsArray.splice(end, 0, [group])
  o.fnArray.splice(begin, 0, OPS.beginGroup)
  o.argsArray.splice(begin, 0, [group])
  for (const bound of c.graphicsBounds) if (bound.operationIndex >= begin) bound.operationIndex++
  return f
}
export function anonymousInertLeadingRecovery() {
  const f = anonymousIsolatedForm(),
    [page, , , , , c] = f.args
  c.pageNumber = page.pageNumber
  c.sourceSha256 = 'a'.repeat(64)
  const insert = (i, op, args) => {
    c.operators.fnArray.splice(i, 0, op)
    c.operators.argsArray.splice(i, 0, args)
    for (const bound of c.graphicsBounds) if (bound.operationIndex >= i) bound.operationIndex++
  }
  for (let i = c.operators.fnArray.length - 1; i >= 0; i--) {
    if (c.operators.fnArray[i] === OPS.endText) insert(i, OPS.nextLine, null)
    if (c.operators.fnArray[i] === OPS.showText) insert(i, OPS.setLeading, [12])
  }
  return f
}
export function anonymousForeignAccentRecovery() {
  const f = anonymousIsolatedForm(),
    [page, , , , tokens, c] = f.args
  c.pageNumber = page.pageNumber
  c.sourceSha256 = 'a'.repeat(64)
  const firstShow = c.operators.fnArray.indexOf(OPS.showText),
    glyph = c.operators.argsArray[firstShow][0][0],
    item = c.content.items[0]
  Object.assign(glyph, {
    unicode: 'ä',
    fontChar: 'a',
    width: 500,
    accent: { fontChar: 'accent', offset: { x: 0.1, y: 0.1 } }
  })
  Object.assign(item, { str: 'ä', width: 5, sourceItem: { pageNumber: 1, index: 0, text: 'ä' } })
  tokens[0] = tableTextToken(item, c.viewport, 0)
  c.glyphBounds[0].glyphs.push({ fontChar: 'a', bounds: [0, -0.1, 0.5, 0.7] })
  c.foreignCompoundGlyphs = [
    {
      fontName: 'F',
      missingFile: false,
      disableFontFace: true,
      remeasure: false,
      isType3Font: false,
      fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      glyphs: [{ fontChar: 'accent', bounds: [0, 0.6, 0.4, 0.8] }]
    }
  ]
  return f
}
export function anonymousSubscriptRecovery() {
  const f = anonymousIsolatedForm(),
    [page, , , , tokens, c] = f.args
  c.pageNumber = page.pageNumber
  c.sourceSha256 = 'a'.repeat(64)
  const at = c.operators.fnArray.findIndex(
    (op, i) => op === OPS.showText && c.operators.argsArray[i][0][0].unicode === 'Axis'
  )
  c.operators.argsArray[at][0] = [{ unicode: 'n', fontChar: 'n', width: 500, isInFont: true }]
  c.operators.fnArray.splice(at + 1, 0, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.setFont)
  c.operators.argsArray.splice(
    at + 1,
    0,
    ['F', 6],
    [[1, 0, 0, 1, 85, 308]],
    [[{ unicode: 'q', fontChar: 'q', width: 500, isInFont: true }]],
    ['F', 10]
  )
  for (const bound of c.graphicsBounds) if (bound.operationIndex > at) bound.operationIndex += 4
  const item = c.content.items[1]
  Object.assign(item, { str: 'nq', width: 8, sourceItem: { pageNumber: 1, index: 1, text: 'nq' } })
  tokens[1] = tableTextToken(item, c.viewport, 0)
  c.glyphBounds[0].glyphs.push(
    { fontChar: 'n', bounds: [0, -0.1, 0.5, 0.7] },
    { fontChar: 'q', bounds: [0, -0.1, 0.5, 0.7] }
  )
  return f
}
