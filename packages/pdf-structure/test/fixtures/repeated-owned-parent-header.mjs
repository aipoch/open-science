/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captureAnonymousHeader } from './single-parent-math-header.mjs'

export async function anonymousRepeatedOwnedParentHeader(mode) {
  const text = (s, x, y, z = 9) => `BT /F ${z} Tf ${x} ${400 - y} Td (${s}) Tj ET`,
    line = (x, y, z) => `${x} ${400 - y} m ${z} ${400 - y} l S`,
    xs = [25, 55, 73.75, 92.5, 111.25, 130, 166.25, 202.5, 238.75, 275],
    stream = [
      text('Table 1: Anonymous repeated values.', 25, 105, 8),
      '0.5 w',
      line(25, 126, 275),
      line(25, 128, 275),
      line(25, 159, 275),
      line(25, 216, 275),
      ...(mode === 'missing-left' ? [] : [line(60, 141.5, 130)]),
      ...(mode === 'missing-right' ? [] : [line(130, 141.5, 270)]),
      text('Base', 84.7445, 136),
      text('Trial', 191.252, 136),
      text('Key', 30, 149.5),
      ...(mode === 'foreign-upper' ? [text('X', 150, 136)] : []),
      ...(mode === 'foreign-lower' ? [text('X', 129, 149.5)] : [])
    ]
  for (let c = 1; c < 9; c++)
    stream.push(
      text(
        mode === 'different-leaves' && c === 8 ? 'P' : ['L', 'M', 'N', 'O'][(c - 1) % 4],
        (xs[c] + xs[c + 1]) / 2 - 3,
        149.5
      ),
      text('u', (xs[c] + xs[c + 1]) / 2 - 1, 154.5, 6),
      text('v', (xs[c] + xs[c + 1]) / 2 + 4, 148, 3)
    )
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 9; c++)
      stream.push(text(c ? '0.' + r + c : 'A' + r, (xs[c] + xs[c + 1]) / 2 - 7, 169 + r * 14))
  const f = await captureAnonymousHeader(stream.join('\n'), [36, 180, 414, 327]),
    crop = f.table.cropRect,
    ybands = [
      [129, 141.5],
      [141.5, 151],
      [151, 159],
      [159, 172],
      [172, 186],
      [186, 200],
      [200, 213]
    ]
  f.table = {
    ...f.table,
    id: 'anonymous-table',
    rowCount: 7,
    columnCount: 9,
    spans: [],
    structure: {
      objects: [
        ...xs.slice(1).map((x, c) => ({
          label: 'table column',
          score: 1,
          rect: [xs[c] * 1.5 - crop[0], 129 * 1.5 - crop[1], x * 1.5 - crop[0], 213 * 1.5 - crop[1]]
        })),
        ...ybands.map((y) => ({
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
          rect: [25 * 1.5 - crop[0], 129 * 1.5 - crop[1], 275 * 1.5 - crop[0], 159 * 1.5 - crop[1]]
        }
      ]
    }
  }
  return f
}
