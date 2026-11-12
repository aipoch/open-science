/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captureAnonymousVerticalFigure } from './vertical-native-subcaptions.mjs'

export async function anonymousOrdinaryFormFigure(fault = '') {
  const objects = [],
    add = (s) => objects.push(s),
    stream = (s, dict = '') =>
      add(`<< ${dict} /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`),
    catalog = add(''),
    pages = add(''),
    font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'),
    image = stream(
      'D07030 30A070 3070D0 D0B030>',
      '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode'
    ),
    panels = [520, 370, 220]
      .map(
        (y, n) =>
          `0.4 w 65 ${y - 10} 400 100 re S q 80 0 0 50 75 ${y} cm /I Do Q ` +
          (fault === 'clipped-label' && n === 0 ? `q 180 ${y + 20} 2 15 re W n ` : '') +
          `BT /R 10 Tf 180 ${y + 30} Td (Panel ${n + 1}: complete measurement.) Tj ET ` +
          (fault === 'clipped-label' && n === 0 ? 'Q ' : '')
      )
      .join(' '),
    formBody = `BT 12 TL ET BT /R 10 Tf 65 605 Td (Composed measurement summary) Tj ET ${panels}`,
    other = stream('', '/Type /XObject /Subtype /Form /BBox [10 10 20 20] /Resources << >>'),
    form = stream(
      formBody + (fault === 'nested-form' ? ' q /B Do Q' : ''),
      `/Type /XObject /Subtype /Form /BBox [60 200 480 620] /Resources << /Font << /R ${font} 0 R >> /XObject << /I ${image} 0 R /B ${other} 0 R >> >>`
    ),
    body = stream(
      `${fault === 'no-form' ? formBody : 'q /A Do Q'} ${fault === 'multiple-forms' ? 'q /B Do Q' : ''} ` +
        `${fault === 'foreign-own' ? 'BT /R 10 Tf 300 460 Td (Independent body.) Tj ET ' : ''}` +
        `${fault === 'foreign-lane' ? 'BT /R 4 Tf 220 195 Td (Independent lane.) Tj ET ' : ''}` +
        `${fault === 'foreign-image' ? 'q 40 0 0 30 300 460 cm /I Do Q ' : ''}` +
        'BT /B 10 Tf 60.01 165 Td (Figure 1:) Tj /R 10 Tf ( Complete anonymous measurement panels.) Tj ET BT /R 10 Tf 520 500 Td (Side) Tj ET'
    ),
    page = add(
      `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 600 700] /Resources << /Font << /R ${font} 0 R /B ${bold} 0 R >> /XObject << /A ${form} 0 R /B ${other} 0 R /I ${image} 0 R >> >> /Contents ${body} 0 R >>`
    )
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`
  objects[pages - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`
  return captureAnonymousVerticalFigure(objects, [60, 315, 480, 490])
}
