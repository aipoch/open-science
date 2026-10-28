import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { nativeRecordFixture } from './open-native-table-contradictions.mjs'

function mergedRecordPackets() {
  const f = nativeRecordFixture(3, 4)
  f.headers()
  for (let c = 0; c < 3; c++) f.add(1, c, ['Alpha', 'First detail', '[1]'][c], 40)
  const first = ['Beta', 'Second detail', '[2]'].map((s, c) => f.token(s, 10 + c * 70, 60))
  const second = ['Gamma', 'Third detail', '[3]'].map((s, c) => f.token(s, 10 + c * 70, 90))
  for (let c = 0; c < 3; c++) f.cell(2, c, [first[c], second[c]])
  for (let c = 0; c < 3; c++) f.add(3, c, ['Delta', 'Fourth detail', '[4]'][c], 120)
  return f.finish()
}
function splitWrappedRecordPackets(calibrated = true) {
  const f = nativeRecordFixture(3, calibrated ? 4 : 3)
  f.headers()
  if (calibrated) {
    f.add(1, 0, '000', 40)
    for (let c = 1; c < 3; c++)
      f.cell(1, c, [
        f.token('Complete first line ' + c, 10 + c * 70, 40),
        f.token('complete second line ' + c, 10 + c * 70, 52),
        f.token('complete third line ' + c, 10 + c * 70, 64)
      ])
  }
  const row = calibrated ? 2 : 1,
    y = calibrated ? 90 : 40
  f.add(row, 0, '001', y)
  f.cell(row + 1, 0, [])
  for (let c = 1; c < 3; c++) {
    f.add(row, c, 'Complete beginning ' + c, y)
    f.add(row + 1, c, 'continued ending ' + c, y + 12)
  }
  return f.finish()
}
function priorRecordTailPacket() {
  const f = nativeRecordFixture(4, 4)
  f.headers()
  for (let c = 0; c < 3; c++) f.add(1, c, ['Alpha', 'Initial value', 'A sentence'][c], 40)
  const tail = f.token('ending', 150, 52)
  f.add(1, 3, '[1]', 40)
  f.add(2, 0, 'Beta', 70)
  f.add(2, 1, 'Next value', 70)
  f.cell(2, 2, [tail, f.token('New sentence', 150, 70)])
  f.add(2, 3, '[2]', 70)
  for (let c = 0; c < 4; c++) f.add(3, c, ['Gamma', 'Final value', 'Final sentence', '[3]'][c], 100)
  return f.finish()
}
function splitValueLanePacket() {
  const f = nativeRecordFixture(5, 4)
  for (let c = 0; c < 3; c++) f.add(0, c, 'Estimate ' + c, 20)
  f.cell(0, 3, [])
  f.cell(0, 4, [f.token('Combined estimate', 300, 20)])
  for (let r = 1; r < 4; r++) {
    f.add(r, 0, '0.5 [0.1]', 40 + r * 12)
    f.add(r, 1, '0.6 [0.2]', 40 + r * 12)
    f.add(r, 2, String(r), 40 + r * 12)
    const t = f.token('0.7 [0.3]', 300, 40 + r * 12)
    f.cell(r, 3, [t], '0.7', [[300, t.rect[1], 320, t.rect[3]]])
    f.cell(r, 4, [t], '[0.3]', [[320, t.rect[1], 340, t.rect[3]]])
  }
  return f.finish()
}
function splitHeaderLanePacket() {
  const f = nativeRecordFixture(3, 5)
  f.headers()
  f.add(1, 0, 'Estimator', 40)
  const t = f.token('All values', 80, 40, 80)
  f.cell(1, 1, [t], 'All', [[80, 30, 120, 40]])
  f.cell(1, 2, [t], 'values', [[120, 30, 160, 40]])
  for (let r = 2; r < 5; r++) {
    f.add(r, 0, 'Estimate ' + r, 40 + r * 12)
    f.cell(r, 1, [f.token('0.5 [0.1]', 80, 40 + r * 12, 80)])
    f.cell(r, 2, [])
  }
  return f.finish()
}
function ordinaryWrappedTwoLanePacket() {
  const f = nativeRecordFixture(2, 7)
  f.headers()
  for (let r = 1; r < 7; r++) {
    const y = 30 + r * 12 + (r > 3 ? 12 : 0),
      left = f.token('Entry ' + r, 10, y),
      right = f.token('Description ' + r, 80, y)
    // A complete wrapped first cell may be painted after its top-aligned peer.
    f.cell(r, 0, r === 3 ? [left, f.token('continued phrase', 10, y + 12)] : [left])
    f.cell(r, 1, [right])
  }
  return f.finish()
}
function wrappedWordPrefixPacket(correct = false) {
  const f = nativeRecordFixture(3, 4)
  f.headers()
  for (let c = 0; c < 3; c++) f.add(1, c, ['Alpha', 'First value', 'First detail'][c], 40)
  f.add(2, 0, 'Beta', 60)
  const first = f.token('Fixed', 80, 60, 25),
    prefix = f.token('pro-', 111, 60, 9),
    tail = f.token('cess value', 80, 72),
    peer = f.token('Second detail', 150, 60)
  f.home = f.cell(2, 1, correct ? [first, prefix, tail] : [first, tail])
  f.wrong = f.cell(2, 2, correct ? [peer] : [prefix, peer])
  for (let c = 0; c < 3; c++) f.add(3, c, ['Gamma', 'Last value', 'Last detail'][c], 100)
  f.prefix = prefix
  f.tail = tail
  return f.finish()
}
export {
  mergedRecordPackets,
  splitWrappedRecordPackets,
  priorRecordTailPacket,
  splitValueLanePacket,
  splitHeaderLanePacket,
  ordinaryWrappedTwoLanePacket,
  wrappedWordPrefixPacket
}

export function rightAlignedCollapsedLanes() {
  const f = nativeRecordFixture(2, 4)
  f.add(0, 0, 'Record', 20)
  f.cell(0, 1, [f.token('Count', 100, 20, 30), f.token('Total', 160, 20, 30)])
  for (let row = 1; row <= 3; row++) {
    f.add(row, 0, 'Record ' + row, 20 + row * 25)
    f.cell(row, 1, [
      f.token(String(row), 120, 20 + row * 25, 10),
      f.token(String(row + 1), 180, 20 + row * 25, 10)
    ])
  }
  f.rules = [
    [0, 5, 190, 5],
    [0, 120, 190, 120]
  ]
  const finish = f.finish
  f.finish = () => {
    finish()
    f.context.rulePaintBounds = new Map()
    f.context.nativePaintIdentityGraphics = []
    for (const r of f.rules) {
      const y = 400 - r[1],
        paint = [r[0], r[1] - 0.5, r[2], r[3] + 0.5]
      const ops = f.context.operators
      ops.fnArray.push(OPS.setStrokeRGBColor, OPS.setLineWidth, OPS.setLineCap, OPS.constructPath)
      ops.argsArray.push(
        ['#000000'],
        [1],
        [0],
        [OPS.stroke, [[0, r[0], y, 1, r[2], y]], [r[0], y, r[2], y]]
      )
      f.context.rulePaintBounds.set(r.join(','), paint)
      f.context.nativePaintIdentityGraphics.push({
        kind: 'path',
        operationIndex: ops.fnArray.length - 1,
        rect: paint
      })
    }
    return f
  }
  return f.finish()
}

// A zero-area origin contour enlarges the coarse box of an overhead filled mark.
export function filledOverheadMark() {
  const f = nativeRecordFixture(1, 2)
  f.add(0, 0, 'Estimate', 20)
  const mark = f.token('z', 34, 57.5, 4),
    base = f.token('A', 34, 60, 6),
    open = f.token('(', 40, 60, 4),
    upper = f.token('2', 48, 56, 3),
    lower = f.token('j', 48, 62, 3),
    close = f.token(')', 53, 60, 4)
  for (const t of [upper, lower]) {
    t.height = 6
    t.rect[1] = t.baseline - 6
  }
  f.target = f.cell(1, 0, [mark, base, open, upper, lower, close])
  f.finish()
  const native = f.context.nativeGlyphContext
  native.glyphBounds[0].glyphs.find((g) => g.fontChar === 'z').bounds = [0, 0, 0.4, 0.73]
  for (const a of native.operators.argsArray)
    for (const g of a?.[0] ?? [])
      if (g && typeof g === 'object' && g.unicode === 'z') g.originalCharCode = 122
  // Keep both observed streams identical, including the original character code.
  f.context.operators = structuredClone(native.operators)
  const operationIndex = native.operators.fnArray.findIndex(
    (op, i) => native.operators.argsArray[i]?.[0]?.[0]?.unicode === 'z'
  )
  native.filledGlyphEvidence = {
    sourceSha256: native.sourceSha256,
    pageNumber: 1,
    requestedGlyphs: 1,
    computedGlyphs: 1,
    glyphs: [
      {
        fontName: 'F',
        unicode: 'z',
        sourceIndices: [mark.sourceItem.index],
        fontChar: 'z',
        originalCharCode: 122,
        fontSha256: 'b'.repeat(64),
        outlineSha256: 'c'.repeat(64),
        fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        coarseBounds: [0, 0, 0.4, 0.73],
        filledBounds: [0, 0.65, 0.4, 0.73],
        occurrences: [{ operationIndex, glyphIndex: 0 }]
      }
    ]
  }
  return f
}

export function parallelAssignmentRows() {
  const f = nativeRecordFixture(2, 6)
  const assignments = Array.from({ length: 7 }, (_, row) =>
    [0, 1].map((column) => {
      const x = 10 + column * 120,
        y = 30 + row * 12
      return [
        f.token((column ? 'q' : 'p') + row, x, y, 12),
        f.token('=', x + 16, y, 6),
        f.token(String(row + 2), x + 26, y, 8)
      ]
    })
  )
  for (let row = 0; row < 6; row++)
    for (let c = 0; c < 2; c++)
      f.cell(row, c, row === 5 ? [...assignments[5][c], ...assignments[6][c]] : assignments[row][c])
  f.rules = [
    [0, 15, 180, 15],
    [0, 110, 180, 110]
  ]
  return f.finish()
}

export function splitWrappedHierarchy(unforced = false, independent = false) {
  const f = nativeRecordFixture(3, 3)
  f.headers()
  const parent = [
      f.token(independent ? 'Observation' : 'Observation &', 10, 50, 60),
      f.token('Control', 10, 62, 30)
    ],
    child = [
      f.token('Visual and ambient', 100, 50, unforced ? 70 : 110),
      f.token('Perception', 100, 62, 55),
      f.token('Touch response', 100, 74, 65)
    ],
    detail = [
      f.token('Identifying structures using', 230, 50, unforced ? 100 : 150),
      f.token('camera signals.', 230, 62, 100),
      f.token('Estimating contact forces.', 230, 74, 150)
    ]
  for (let c = 0; c < 3; c++) {
    const a = [parent, child, detail][c]
    f.cell(1, c, [a[0]])
    f.cell(2, c, a.slice(1))
  }
  f.rules = [
    [0, 30, 390, 30],
    [0, 90, 390, 90]
  ]
  f.finish()
  const context = f.context,
    native = context.nativeGlyphContext
  context.rulePaintBounds = new Map()
  context.nativePaintIdentityGraphics = []
  for (const r of f.rules) {
    const y = 400 - r[1],
      paint = [r[0], r[1] - 0.5, r[2], r[3] + 0.5],
      index = context.operators.fnArray.length,
      fn = [OPS.setStrokeRGBColor, OPS.setLineWidth, OPS.setLineCap, OPS.constructPath],
      args = [['#000000'], [1], [0], [OPS.stroke, [[0, r[0], y, 1, r[2], y]], [r[0], y, r[2], y]]]
    for (const operators of [context.operators, native.operators]) {
      operators.fnArray.push(...fn)
      operators.argsArray.push(...structuredClone(args))
    }
    context.rulePaintBounds.set(r.join(','), paint)
    context.nativePaintIdentityGraphics.push({
      kind: 'path',
      operationIndex: index + 3,
      rect: paint
    })
    const graphic = {
      kind: 'path',
      operationIndex: index + 3,
      normalizedRect: paint.map((n) => n / 400)
    }
    context.sourcePage.graphicsBounds.push(graphic)
    native.graphicsBounds.push(structuredClone(graphic))
  }
  return f
}
