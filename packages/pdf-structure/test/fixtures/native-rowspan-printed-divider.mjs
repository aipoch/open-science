/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeRecordFixture } from './open-native-table-contradictions.mjs'
export function rowspanAcrossFullDivider({
  correct = false,
  partial = false,
  color = '#000000',
  alpha = 1,
  clip = false,
  occlusion = false
} = {}) {
  const f = nativeRecordFixture(3, 5)
  f.headers()
  for (let r = 1; r < 5; r++) for (let c = 1; c < 3; c++) f.add(r, c, String(r + c), 20 + r * 25)
  const group = f.cell(correct ? 2 : 1, 0, [f.token('Group', 10, 80, 40)])
  group.rowSpan = correct ? 3 : 4
  f.finish()
  f.rules = [[partial ? 75 : 0, 55, 220, 55]]
  const ops = f.context.operators
  f.context.rulePaintBounds = new Map()
  const all = []
  for (const [i, r] of [
    [0, [0, 5, 220, 5]],
    [1, f.rules[0]]
  ]) {
    ops.fnArray.push(
      OPS.save,
      OPS.setStrokeRGBColor,
      OPS.setLineWidth,
      OPS.setLineCap,
      OPS.setGState
    )
    ops.argsArray.push([], [color], [1], [0], [[['CA', alpha]]])
    if (clip && i === 1) {
      ops.fnArray.push(OPS.constructPath)
      ops.argsArray.push([
        OPS.clip,
        [[0, 0, 346, 1, 110, 346, 1, 110, 344, 1, 0, 344, 4]],
        [0, 344, 110, 346]
      ])
    }
    ops.fnArray.push(OPS.constructPath)
    ops.argsArray.push([
      OPS.stroke,
      [[0, r[0], 400 - r[1], 1, r[2], 400 - r[3]]],
      [r[0], 400 - r[1], r[2], 400 - r[3]]
    ])
    const rect = [r[0], r[1] - 0.5, r[2], r[3] + 0.5]
    all.push({ kind: 'path', operationIndex: ops.fnArray.length - 1, rect })
    f.context.rulePaintBounds.set(r.join(','), rect)
    ops.fnArray.push(OPS.restore)
    ops.argsArray.push([])
  }
  if (occlusion) {
    ops.fnArray.push(OPS.setFillRGBColor, OPS.constructPath)
    ops.argsArray.push(
      ['#ffffff'],
      [OPS.fill, [[0, 90, 346, 1, 100, 346, 1, 100, 344, 1, 90, 344, 4]], [90, 344, 100, 346]]
    )
    all.push({ kind: 'path', operationIndex: ops.fnArray.length - 1, rect: [90, 54, 100, 56] })
  }
  const graphics = all.map((g) => ({
    kind: g.kind,
    operationIndex: g.operationIndex,
    normalizedRect: g.rect.map((n) => n / 400)
  }))
  f.context.sourcePage.graphicsBounds = graphics
  f.context.nativeGlyphContext.graphicsBounds = structuredClone(graphics)
  f.context.nativeGlyphContext.operators = structuredClone(ops)
  f.context.nativePaintIdentityGraphics = graphics.slice(1).map((g) => ({
    kind: g.kind,
    operationIndex: g.operationIndex,
    rect: g.normalizedRect.map((n) => n * 400)
  }))
  return f
}
