/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captureAnonymousHeader } from './single-parent-math-header.mjs'

export function anonymousCategoricalParentHeader(mode) {
  const text = (s, x, y) => `BT /F 10 Tf ${x} ${400 - y} Td (${s}) Tj ET`,
    stream = [
      ...(mode === 'white-rail' ? ['1 G'] : []),
      '0.5 w 40 295 m 260 295 l S 40 245 m 260 245 l S 40 207 m 260 207 l S',
      ...(mode === 'white-rail' ? ['0 G'] : []),
      ...(mode === 'partial'
        ? []
        : [mode === 'short-partial' ? '165 271 m 225 271 l S' : '145 271 m 249 271 l S']),
      ...(mode === 'duplicate-partial' ? ['145 271 m 249 271 l S'] : []),
      text('Reference', 43, 128),
      text('Estimate', mode === 'off-center' ? 164 : 177.55, 120),
      text('Present', 145, 145),
      text('Absent', 221, 145),
      ...(mode === 'extra-parent' ? [text('Extra', 105, 120)] : []),
      ...(mode === 'foreign-glyph' ? [text('X', 190, 154)] : []),
      ...(mode === 'foreign-paint' ? ['100 230 m 190 230 l S'] : []),
      ...[173, 188].flatMap((y, n) => [
        text(n ? 'Absent' : mode === 'asymmetric' ? 'Other' : 'Present', 43, y),
        text(n ? 'ba' : 'aa', 162, y),
        ...(mode === 'missing-value' && n ? [] : [text(n ? 'bb' : 'ab', 228, y)]),
        ...(mode === 'extra-value' && n ? [text('cc', 198, y)] : [])
      ]),
      text('Table', 40, 220),
      text('1:', 68, 220),
      text('Anonymous', 80, 220),
      text('categories.', 140, 220)
    ].join('\n')
  return captureAnonymousHeader(stream, [58, 155, 392, 293])
}
