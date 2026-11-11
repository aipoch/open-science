/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captureAnonymousHeader } from './single-parent-math-header.mjs'

export async function anonymousFourRuleRecords(mode = 'terminal-wrapped', fault = '') {
  const text = (s, x, y) => `BT /F 8 Tf ${x} ${400 - y} Td (${s}) Tj ET`,
    footer = mode === 'count-footer',
    ys = footer ? [100, 120, 215, 245] : [100, 120, 175, 215],
    xs = footer ? [45, 85, 125, 165, 215, 250] : [45, 85, 125, 175, 225],
    headers = footer
      ? ['Kind', 'Audio', 'Proof', 'Use', 'Fam', 'Items']
      : ['Kind', 'Count', 'Cause', 'Check', 'Proof'],
    body = footer
      ? [
          ['Able', 'Mic', 'Label', 'Open', '1', '12'],
          ['Beta', 'Mic', 'Label', 'Open', '2', '12'],
          ['Gamma', 'Mic', 'Label', 'Open', '3', '12']
        ]
      : [
          ['One', '1', 'cause', 'test', 'proof'],
          ['Two', '2', 'cause', 'test', 'proof'],
          ['Three', '3', 'per-item', 'no-audio', 'test-proof']
        ],
    baselines = footer ? [140, 165, 190] : [140, 160, 190],
    stream = [
      text('Table', 40, 85),
      text('1:', 64, 85),
      text('Anonymous', 74, 85),
      text('records.', 126, 85),
      '0.5 w',
      ...ys
        .filter((_, n) => !(fault === 'missing-closing' && n === 3))
        .map((y) => `40 ${400 - y} m 270 ${400 - y} l S`),
      ...headers.map((h, n) => text(h, xs[n], 113)),
      ...body.flatMap((fields, r) =>
        fields.flatMap((s, c) => [
          text(
            fault === 'numeric-tail' && !footer && r === 2 && c >= 2 ? '11' : s,
            xs[c],
            baselines[r]
          ),
          ...(footer && c === 1
            ? [text('clip', xs[c], baselines[r] + 10)]
            : !footer && r === 2 && c >= 2
              ? [text(fault === 'numeric-tail' ? '12' : 'tail', xs[c], 200)]
              : [])
        ])
      ),
      ...(footer
        ? [
            text('Total', 45, fault === 'footer-above-terminal' ? 205 : 235),
            text('6', 215, fault === 'footer-above-terminal' ? 205 : 235),
            text('36', 250, fault === 'footer-above-terminal' ? 205 : 235)
          ]
        : []),
      ...(fault === 'foreign-paint' ? ['90 235 m 110 235 l S'] : []),
      ...(fault === 'foreign-glyph' ? [text('X', 105, 145)] : [])
    ].join('\n'),
    f = await captureAnonymousHeader(stream, [59, 149, 406, (ys[3] + 1) * 1.5])
  f.table.page = 1
  f.table.id = 'anonymous'
  return { ...f, tokens: f.items }
}
