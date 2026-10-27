/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeRecordFixture } from './open-native-table-contradictions.mjs'

// Seven generated native records, not an exported paper or model prediction.
export function scientificOrderFixture() {
  const f = nativeRecordFixture(1, 2)
  f.add(0, 0, 'Estimate', 20)
  const runs = [
    ['2.75', 40, 80, 24, 12],
    ['±', 64, 80, 4.8, 6],
    ['4', 68.8, 80, 4.8, 6],
    ['×', 73.6, 80, 4.8, 6],
    ['10', 78.4, 80, 9.6, 6],
    ['−', 88, 77.6, 4.8, 6],
    ['2', 92.8, 77.6, 4.8, 6]
  ].map(([text, x, y, width, height]) => {
    const t = f.token(text, x, y, width)
    t.height = height
    t.rect[1] = y - height
    t.nativeLabelRect = [x, y - height * 0.7, x + width, y + height * 0.3]
    return t
  })
  const order = [runs[0], runs[5], runs[6], ...runs.slice(1, 5)],
    cell = f.cell(1, 0, runs, order.map((f) => f.text).join(' '))
  cell.sourceTokens = order.map((t) => ({
    text: t.text,
    rect: t.rect,
    baseline: t.baseline,
    height: t.height
  }))
  f.target = cell
  f.runs = runs
  return f.finish()
}

export function addRemoteScientificImage(f) {
  const index = f.context.operators.fnArray.length + 3,
    g = { kind: 'image', operationIndex: index, normalizedRect: [0.55, 0.5, 0.6, 0.55] }
  for (const [context, name] of [
    [f.context, 'RasterB'],
    [f.context.nativeGlyphContext, 'RasterA']
  ]) {
    context.operators.fnArray.push(
      OPS.dependency,
      OPS.save,
      OPS.transform,
      OPS.paintImageXObject,
      OPS.restore
    )
    context.operators.argsArray.push([name], [], [20, 0, 0, 20, 220, 180], [name, 20, 20], [])
  }
  f.context.sourcePage.graphicsBounds.push(g)
  f.context.nativeGlyphContext.graphicsBounds.push(structuredClone(g))
  return index
}
