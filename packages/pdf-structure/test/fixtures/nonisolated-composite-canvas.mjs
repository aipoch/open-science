/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captureAnonymousVerticalFigure } from './vertical-native-subcaptions.mjs'

export async function anonymousNonisolatedCompositeCanvas(fault = '') {
  const stream = (text, dictionary = '') =>
    `<< ${dictionary} /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`
  let upper =
    '0.5 w 65 455 470 160 re S 80 480 m 520 590 l S ' +
    'BT /R 10 Tf 1 0 0 1 80 590 Tm (Upper panel) Tj ' +
    '1 0 0 1 80 520 Tm (Value) Tj 1 0 0 1 450 470 Tm (Time) Tj ET'
  let lower =
    '0.5 w 65 105 470 190 re S 80 120 m 520 275 l S ' +
    'BT /R 10 Tf 1 0 0 1 80 275 Tm (Lower panel) Tj ' +
    '1 0 0 1 80 190 Tm (Value) Tj 1 0 0 1 450 120 Tm (Time) Tj ET'
  if (['normal-alpha', 'blend', 'soft-mask'].includes(fault)) upper = '/A gs ' + upper
  if (fault === 'mixed-node') lower = lower.replace('(Time)', '(2)')
  const childGroup = `/Group << /S /Transparency /I ${fault === 'nonisolated-child' ? 'false' : 'true'} /K ${fault === 'knockout-child' ? 'true' : 'false'} >>`
  const childMatrix = fault === 'sheared-child' ? '[1 0.1 0 1 0 0]' : '[1 0 0 1 0 0]'
  const body =
    'q /Picture Do Q ' +
    (fault === 'foreign-glyph'
      ? 'BT /R 10 Tf 1 0 0 1 200 400 Tm (Independent narrative.) Tj ET '
      : '') +
    'BT /R 10 Tf 1 0 0 1 60 80 Tm (Figure 1. Complete paired measurements from two independently painted panels with shared axes.) Tj ET'
  const childText = (s) => (fault === 'outline-only' ? s.replace(/BT[\s\S]*?ET/gu, '') : s)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /R 4 0 R >> /XObject << /Picture 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream(body),
    stream(
      fault === 'mixed-node'
        ? 'q /Upper Do Q q /Lower Do Q BT /R 10 Tf 1 0 0 1 455.56 120 Tm (0) Tj ET'
        : fault === 'root-nonnumeric'
          ? 'q /Upper Do Q q /Lower Do Q BT /R 10 Tf 1 0 0 1 100 400 Tm (Remark) Tj ET'
          : fault === 'root-numeric'
            ? 'q /Upper Do Q q /Lower Do Q BT /R 10 Tf 1 0 0 1 100 400 Tm (20) Tj ET'
            : fault === 'root-prose'
              ? 'q /Upper Do Q q /Lower Do Q BT /R 10 Tf 1 0 0 1 100 400 Tm (Ordinary experimental prose remains independent.) Tj 1 0 0 1 100 380 Tm (This paragraph explains a separate method.) Tj 1 0 0 1 100 360 Tm (These sentences are not labels or ticks.) Tj ET'
              : fault === 'four-children'
                ? 'q /Upper Do Q q /Lower Do Q q /Lower Do Q q /Lower Do Q'
                : fault === 'excess-children'
                  ? 'q /Upper Do Q q /Lower Do Q q /Lower Do Q q /Lower Do Q q /Lower Do Q'
                  : 'q /Upper Do Q q /Lower Do Q',
      '/Type /XObject /Subtype /Form /BBox [60 100 540 620] /Group << /S /Transparency /I false /K false >> /Resources << /Font << /R 4 0 R >> /XObject << /Upper 7 0 R /Lower 8 0 R >> >>'
    ),
    stream(
      childText(upper),
      `/Type /XObject /Subtype /Form /BBox [60 450 540 620] /Matrix ${childMatrix} ${childGroup} /Resources << /Font << /R 4 0 R >> /ExtGState << /A 9 0 R >> >>`
    ),
    stream(
      childText(lower),
      `/Type /XObject /Subtype /Form /BBox [60 100 540 ${fault === 'overlap' ? 500 : 300}] /Matrix [1 0 0 1 0 0] ${childGroup} /Resources << /Font << /R 4 0 R >> /ExtGState << /A 9 0 R >> >>`
    ),
    fault === 'soft-mask'
      ? '<< /Type /ExtGState /SMask << /S /Luminosity /G 10 0 R >> >>'
      : fault === 'blend'
        ? '<< /Type /ExtGState /BM /Multiply /ca 1 /CA 1 >>'
        : '<< /Type /ExtGState /BM /Normal /ca 0.5 /CA 0.5 >>',
    stream(
      '1 g 0 0 600 700 re f',
      '/Type /XObject /Subtype /Form /BBox [0 0 600 700] /Group << /S /Transparency /I true /K false /CS /DeviceGray >> /Resources << >>'
    )
  ]
  const fixture = await captureAnonymousVerticalFigure(objects, [59, 399, 541, 601])
  fixture.figure.reason = 'native-raster-composite-grid'
  return fixture
}
