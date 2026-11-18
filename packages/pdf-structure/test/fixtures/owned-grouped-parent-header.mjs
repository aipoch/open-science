/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captureAnonymousHeader } from './single-parent-math-header.mjs'

export async function anonymousOwnedGroupedParentHeader(mode) {
  const text = (s, x, y, size = 9) =>
    'BT /F ' + size + ' Tf ' + x + ' ' + (400 - y) + ' Td (' + s + ') Tj ET'
  const xs = [25, 80, 115, 147, 178, 212, 243, 275]
  const stream = [
    text('Table 1: Anonymous grouped values.', 25, 95, 8),
    '0.5 w 25 280 m 275 280 l S 25 243 m 275 243 l S 25 184 m 275 184 l S',
    ...(mode === 'missing-underline' ? [] : ['83 258.5 m 113 258.5 l S']),
    ...(mode === 'missing-long-underline' ? [] : ['120 258.5 m 270 258.5 l S']),
    text('Check', 85.247, 137),
    text('Group', 182.4945, 137),
    ...(mode === 'competing-parent' ? [text('Other', 218, 137)] : []),
    text('Mode', 30, 153.5),
    text('Score', 86.246, 153.5),
    text(mode === 'different-leaf-distribution' ? 'AAAA BBBB' : 'AAAA BBBB CCCC', 120, 153.5),
    text('D', 224.751, 153.5),
    text('E', 255.9985, 153.5)
  ]
  for (let r = 0; r < 4; r++) {
    const y = 169 + r * 14
    stream.push(
      text('A' + r, 30, y),
      text('0.00' + r, 85.49, y),
      text('0.1' + r, 123, y),
      text('0.2' + r, 154, y),
      text('0.3' + r, 185, y),
      text('0.11', 216, y),
      text('0.222', 248, y)
    )
  }
  stream.push(text('A note remains below the closed table.', 24, 224.85))
  const f = await captureAnonymousHeader(stream.join('\n'), [36, 180, 414, 327])
  const crop = f.table.cropRect,
    yBands = [
      [144.5, 157],
      [157, 176],
      [176, 190],
      [190, 204],
      [204, 215]
    ]
  f.table = {
    ...f.table,
    id: 'anonymous-table',
    rowCount: 5,
    columnCount: 7,
    spans: [],
    structure: {
      objects: [
        ...xs.slice(1).map((x, c) => ({
          label: 'table column',
          score: 1,
          rect: [
            xs[c] * 1.5 - crop[0],
            144.5 * 1.5 - crop[1],
            x * 1.5 - crop[0],
            215 * 1.5 - crop[1]
          ]
        })),
        ...yBands.map((y) => ({
          label: 'table row',
          score: 1,
          rect: [
            25 * 1.5 - crop[0],
            y[0] * 1.5 - crop[1],
            275 * 1.5 - crop[0],
            y[1] * 1.5 - crop[1]
          ]
        })),
        {
          label: 'table column header',
          score: 1,
          rect: [
            25 * 1.5 - crop[0],
            144.5 * 1.5 - crop[1],
            275 * 1.5 - crop[0],
            157 * 1.5 - crop[1]
          ]
        }
      ]
    }
  }
  return f
}
