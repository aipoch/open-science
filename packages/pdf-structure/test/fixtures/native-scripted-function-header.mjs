/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { nativeRecordFixture } from './open-native-table-contradictions.mjs'

// A generated six-run function with two native script tiers, no external text.
export function scriptedFunctionHeader(gap = '') {
  const f = nativeRecordFixture(1, 2),
    runs = [
      ['f', 30, 40, 4.5, 10],
      ['(', 34.5, 40, 4.5, 10],
      ['q', 39, 40, 6, 10],
      ['upper', 45.05, 36, 20, 20 / 3],
      ['lower', 45.1, 42.1, 20, 20 / 3],
      [')', 65.3, 40, 4.5, 10]
    ].map(([text, x, y, width, height], i) => {
      if (i === 5 && gap)
        f.token(gap === 'empty' ? '' : 'foreign', 300, 100, gap === 'empty' ? 0 : 30)
      const t = f.token(text, x, y, width)
      t.height = height
      t.rect[1] = y - height
      t.nativeLabelRect = [x, y - height * 0.7, x + width, y + height * 0.3]
      return t
    })
  f.target = f.cell(
    0,
    0,
    runs,
    'f(qlowerupper)',
    [0, 1, 2, 4, 3, 5].map((i) => runs[i].rect)
  )
  f.runs = runs
  f.add(1, 0, '3.5', 70)
  return f.finish()
}
