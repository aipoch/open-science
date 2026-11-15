/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { captureAnonymousVerticalFigure } from './vertical-native-subcaptions.mjs'

export async function anonymousStrokeMarkerPairedPanels(fault = '') {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica)
  const scale = fault === 'oversize-page' ? 4 : ['large-page', 'byte-retry'].includes(fault) ? 2 : 1
  const stream = (text, dictionary = '') =>
      `<< ${dictionary} /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    literal = (s) => '(' + s.replace(/([\\()])/gu, '\\$1') + ')',
    text = (s, x, y, size = 9) =>
      `BT /R ${size} Tf 0 Tr 1 0 0 1 ${x} ${700 * scale - y} Tm ${literal(s)} Tj ET `,
    tasks = ['"Move the neutral marker."', '"Select the neutral region."'],
    task = (i) => {
      const s =
          fault === 'narrative-task' && i === 0
            ? 'Independent narrative continues in this lane.'
            : tasks[i],
        x = (i === 0 ? 160 : 420) * scale - font.widthOfTextAtSize(s, 9) / 2
      const result = text(
        s,
        x + (fault === 'off-center-task' && i === 0 ? 50 : 0),
        250 * scale - 10
      )
      return fault === 'rotated-task' && i === 0 ? result.replace('1 0 0 1', '0 1 -1 0') : result
    },
    marker = (x) =>
      `q ${fault === 'inactive-fill' ? '1 0 0' : '0.48 0.35 0.49'} rg 1 1 1 RG 2 w BT /R 12 Tf ${fault === 'invisible-marker' ? 3 : 1} Tr 1 0 0 1 ${x * scale} ${430 * scale} Tm (*) Tj ET Q ` +
      (fault === 'missing-fill'
        ? ''
        : `q 0.48 0.35 0.49 rg BT /R 12 Tf 0 Tr 1 0 0 1 ${x * scale} ${430 * scale} Tm (*) Tj ET Q `),
    baseline = 400 * scale + (fault === 'distant-legend' ? 100 : 32),
    keys = ['P Close', 'P Wide', 'Q Close', fault === 'reordered-key' ? 'P Close' : 'Q Wide'],
    legend =
      keys
        .map((s, i) => {
          const x = (82 + i * 77) * scale
          return (
            `q ${i < 2 ? '0.2 0.45 0.8' : '0.85 0.45 0.15'} rg ${x - 10} ${700 * scale - baseline + 2} 5 5 re f Q ` +
            text(s, x, baseline)
          )
        })
        .join('') +
      `q 0.48 0.35 0.49 rg BT /R 12 Tf 0 Tr 1 0 0 1 ${400 * scale - 11} ${700 * scale - baseline} Tm (*) Tj ET Q ` +
      text('Choice', 400 * scale, baseline) +
      (fault === 'missing-key'
        ? ''
        : `q 0 0.6 0 RG 0.6 w ${463 * scale - 13} ${700 * scale - baseline} 7 7 re S Q `) +
      text('Reference', 463 * scale, baseline),
    body =
      (fault === 'viewport-clip' ? 'q 0 0 600 700 re W n ' : '') +
      'n ' +
      task(0) +
      task(1) +
      `q ${200 * scale} 0 0 ${150 * scale} ${60 * scale} ${300 * scale} cm /Left Do Q q ${200 * scale} 0 0 ${150 * scale} ${320 * scale} ${300 * scale} cm /Right Do Q ` +
      marker(75) +
      marker(335) +
      text(
        '(a) Neutral response',
        160 * scale - font.widthOfTextAtSize('(a) Neutral response', 10) / 2,
        400 * scale + 15,
        10
      ) +
      text(
        '(b) Bounded response',
        420 * scale - font.widthOfTextAtSize('(b) Bounded response', 10) / 2,
        400 * scale + 15,
        10
      ) +
      legend +
      (fault === 'foreign-caption-gap' ? text('Independent narrative.', 280, 442) : '') +
      (fault === 'foreign-path' ? 'q 0.6 w 280 262 m 310 262 l S Q ' : '') +
      (fault === 'third-image' ? 'q 10 0 0 10 540 260 cm /Left Do Q ' : '') +
      text(
        'Figure 1. Paired tasks. (a) Neutral response. (b) Bounded response.',
        60 * scale,
        400 * scale + 55,
        10
      ) +
      (fault === 'viewport-clip' ? 'Q ' : ''),
    rgba = fault.startsWith('rgba') || fault === 'alpha-after-seal',
    imageWidth = fault === 'byte-retry' ? 1000 : 2,
    imageHeight = fault === 'byte-retry' ? 750 : 2,
    image =
      `/Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode` +
      (rgba ? ' /SMask 8 0 R' : ''),
    noise = (seed) => {
      const bytes = Buffer.alloc(imageWidth * imageHeight * 3)
      let value = seed
      for (let i = 0; i < bytes.length; i++) {
        value ^= value << 13
        value ^= value >>> 17
        value ^= value << 5
        bytes[i] = value & 255
      }
      return bytes.toString('hex') + '>'
    },
    objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${600 * scale} ${700 * scale}] /Resources << /Font << /R 4 0 R >> /XObject << /Left 6 0 R /Right 7 0 R >> >> /Contents 5 0 R >>`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      stream(body),
      stream(fault === 'byte-retry' ? noise(0x12345678) : 'D8E8F0CCDDE6BBD0DDABC2D2>', image),
      stream(fault === 'byte-retry' ? noise(0x87654321) : 'E8DFD0DDCFBBD2C2AAC6B497>', image)
    ]
  if (rgba)
    objects.push(
      stream(
        fault === 'rgba-transparent' ? 'FEFFFFFF>' : 'FFFFFFFF>',
        '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode'
      )
    )
  const f = await captureAnonymousVerticalFigure(objects, [
    60 * scale - 1,
    250 * scale - 1,
    520 * scale + 21,
    400 * scale + 22
  ])
  f.figure.reason = 'native-raster-side-by-side'
  return f
}
