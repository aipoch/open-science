/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captureAnonymousVerticalFigure } from './vertical-native-subcaptions.mjs'

export async function strokeOnlyPreviewFixture(name = 'base') {
  const mode = /^mode[0-7]$/u.test(name) ? Number(name.at(-1)) : 1,
    width = name === 'hairline' ? 0 : name === 'wide-stroke' ? 3 : 0.6,
    extra = ['fill-alpha', 'fill-alpha-zero'].includes(name)
      ? ' /A gs '
      : name === 'stroke-alpha'
        ? ' /B gs '
        : ''
  const text = `q ${extra} ${width} w BT /R 12 Tf ${name === 'implicit-fill' ? '' : mode + ' Tr'} 1 0 0 1 60 100 Tm (*) Tj ${name === 'empty-space' ? '( ) Tj' : ''} ET Q`,
    objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /R 4 0 R >> /ExtGState << /A 6 0 R /B 7 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
      `<< /Type /ExtGState /ca ${name === 'fill-alpha-zero' ? 0 : 0.5} >>`,
      '<< /Type /ExtGState /CA 0.5 >>'
    ]
  return captureAnonymousVerticalFigure(objects, [50, 580, 90, 610])
}
