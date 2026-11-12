/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captureAnonymousVerticalFigure } from './vertical-native-subcaptions.mjs'
import { collectTableRules } from '../../resources/literature-pdf-graphics.mjs'

export async function anonymousSmallerTableCaption(fault = '') {
  const text = (s, x, baseline, em) =>
    `BT /R ${em} Tf 1 0 0 1 ${x} ${700 - baseline} Tm (${s}) Tj ET`
  const caption = [
    'Table 1 | Runtime of the complete reference methods under shared conditions. Limits for each run: 3 hours and 80',
    'GB of memory on the shared server for all measured groups. Each record reports the full computation and the resulting final output',
    'from the independent original measurements.'
  ]
  if (fault === 'narrative') caption[0] = caption[0].replace('Table 1 |', 'Table 1 shows')
  if (fault === 'closed-lead') caption[0] += '.'
  if (fault === 'unclosed-tail') caption[2] = caption[2].slice(0, -1)
  const rails = [107, 127, 185, 205].filter((_, n) => fault !== 'missing-rail' || n !== 2)
  const stream = [
    ...caption.map((s, n) => text(s, 50, [70, 82.3, 93.1][n], n ? 8.5 : 10)),
    ...rails.map(
      (y) =>
        `0.4 w 143 ${700 - y} m ${fault === 'mismatched-rail' && y === 185 ? 461 : 463} ${700 - y} l S`
    ),
    ...[
      ['Method', 'Group A', 'Group B'],
      ['Reference', '12', '18'],
      ['Variant', '14', '20'],
      ['Control', '10', '16'],
      ['Summary', '36', '54']
    ].flatMap((row, n) =>
      fault === 'prose-body'
        ? [text(row.join(' '), 150, [120, 142, 158, 174, 198][n], 10)]
        : row.map((s, column) => text(s, [150, 290, 400][column], [120, 142, 158, 174, 198][n], 10))
    ),
    fault === 'foreign-text' ? text('Independent prose.', 75, 102, 5) : '',
    fault === 'foreign-paint' ? '80 612 8 4 re f' : '',
    fault === 'interior-rule' ? '0.4 w 80 610 m 120 610 l S' : ''
  ].join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /R 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ]
  const f = await captureAnonymousVerticalFigure(objects)
  return {
    ...f,
    rules: collectTableRules(await f.nativePage.getOperatorList(), f.context.viewport),
    caption
  }
}
