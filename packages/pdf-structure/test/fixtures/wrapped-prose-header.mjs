/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captureAnonymousHeader } from './single-parent-math-header.mjs'

export function anonymousWrappedProseHeader(mode) {
  const text = (s, x, y) => `BT /F 10 Tf ${x} ${400 - y} Td (${s}) Tj ET`,
    stream = [
      text('Table', 40, 90),
      text('1:', 68, 90),
      text('Anonymous', 80, 90),
      text('records.', 140, 90),
      ...(mode === 'white-rail' ? ['1 G'] : []),
      '0.5 w',
      ...(mode === 'opening' ? [] : ['40 300 m 260 300 l S']),
      ...(mode === 'divider' ? [] : ['40 268 m 260 268 l S']),
      ...(mode === 'closing' ? [] : ['40 175 m 260 175 l S']),
      ...(mode === 'white-rail' ? ['0 G'] : []),
      ...[
        ['Record', 'Class', 43],
        ['Peer', 'List', 95],
        ['Energy', 'Metric', 150],
        ['Main', 'Limits', 205]
      ].flatMap(([a, b, x]) => [text(a, x, 111), text(b, x, 121)]),
      ...(mode === 'foreign-paint' ? ['80 225 m 210 225 l S'] : []),
      ...[142, 172, 202].flatMap((y, n) => [
        text(['Alpha', 'Beta', 'Gamma'][n], 43, y),
        text(mode === 'citation' && n === 1 ? 'Other' : `[${n + 1}]`, 95, y),
        ...(mode === 'missing-field' && n === 1 ? [] : [text('Power', 150, y)]),
        text('Clear', 205, y),
        text(
          'Tail.',
          mode === 'cross-gutter' && n === 1 ? 180 : 205,
          y + (mode === 'cross-record' && n === 1 ? 30 : 10)
        ),
        ...(mode === 'foreign-glyph' && n === 1 ? [text('X', 190, y + 5)] : [])
      ])
    ].join('\n')
  return captureAnonymousHeader(stream, [58, 148, 392, 344])
}
