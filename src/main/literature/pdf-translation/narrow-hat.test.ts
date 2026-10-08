import { expect, it } from 'vitest'
import {
  resolveNativeMathAccents,
  type NativeMathObject
} from '../../../../resources/pdf-translation/math-accents.mjs'

it.each([
  ['centered', true],
  ['subset', true],
  ['ordinary-font', false],
  ['ordinary-base', false],
  ['detached', false],
  ['baseline-mark', false],
  ['ambiguous-base', false],
  ['tall-mark', false],
  ['wide-mark', false]
] as const)('groups only a proven narrow native hat: %s', (change, accepted) => {
  const objects: NativeMathObject[] = [
    {
      i: 1,
      text: 'ˆ ',
      fontName: change === 'ordinary-font' ? 'Helvetica' : 'ABCDEF+CMR10',
      bounds:
        change === 'detached'
          ? [110, 108, 113, 109.5]
          : change === 'baseline-mark'
            ? [102.5, 102, 105.5, 103.5]
            : change === 'tall-mark'
              ? [102.5, 108, 105.5, 111]
              : change === 'wide-mark'
                ? [99, 108, 109, 109.5]
                : [102.5, 108, 105.5, 109.5]
    },
    {
      i: 2,
      text: 'Q',
      fontName:
        change === 'ordinary-base'
          ? 'Helvetica-Bold'
          : change === 'subset'
            ? 'ABCDEF+CMBX10'
            : 'CMBX10',
      bounds: [100, 100, 108, 107]
    }
  ]
  if (change === 'ambiguous-base') objects.push({ ...objects[1], i: 3, text: 'V' })
  const result = resolveNativeMathAccents(objects)
  expect(result).toHaveLength(accepted ? 1 : 0)
  if (accepted) expect(result[0]).toMatchObject({ indices: [1, 2], label: 'Qˆ' })
})
