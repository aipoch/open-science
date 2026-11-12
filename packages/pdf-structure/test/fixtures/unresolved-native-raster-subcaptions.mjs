/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captureAnonymousVerticalFigure } from './vertical-native-subcaptions.mjs'

export async function anonymousUnresolvedNativeRasterSubcaptions(fault = '') {
  const escape = (s) => s.replace(/[\\()]/gu, '\\$&'),
    text = (s, x, y) => `BT /R 10 Tf ${x} ${700 - y} Td (${escape(s)}) Tj ET`
  const stream = [
    'q 380 0 0 80 110 520 cm /A Do Q',
    fault === 'clipped-label' ? 'q 60 495 30 40 re W n' : '',
    text('(a) Original upper measurements.', 60, 195),
    fault === 'clipped-label' ? 'Q' : '',
    fault === 'foreign-label' ? text('Independent foreign paragraph.', 300, 220) : '',
    fault === 'foreign-paint' ? '300 475 10 8 re f' : '',
    'q 270 0 0 90 160 360 cm /B Do Q',
    text(
      fault === 'duplicate-letter'
        ? '(a) Original lower measurements.'
        : '(b) Original lower measurements.',
      160,
      355
    ),
    text('Figure 7: Anonymous sampled measurements.', 60, 380),
    text('1', 300, 670)
  ].join(' ')
  const rgb = Array.from({ length: 64 }, (_, i) =>
      i % 8 < 2 || i % 8 > 5 || i < 16 || i >= 48 ? 'ffffff' : i % 2 ? 'ff0000' : '0000ff'
    ).join(''),
    image = `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${rgb.length + 1} >>\nstream\n${rgb}>\nendstream`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /R 4 0 R >> /XObject << /A 6 0 R /B 7 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    image,
    image
  ]
  return captureAnonymousVerticalFigure(objects)
}
