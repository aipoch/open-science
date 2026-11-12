/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captureAnonymousVerticalFigure } from './vertical-native-subcaptions.mjs'

export async function anonymousCaptionedSingleForm(fault = '') {
  const objects = [],
    add = (s) => objects.push(s),
    stream = (s, dict = '') =>
      add(`<< ${dict} /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`),
    catalog = add(''),
    pages = add(''),
    ordinary = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    charproc = stream(
      '600 0 50 50 500 700 d1 50 50 m 150 50 l 150 310 l 400 50 l 500 50 l 230 370 l 500 700 l 400 700 l 150 430 l 150 700 l 50 700 l h f'
    ),
    unicode = stream(
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Anonymous def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <4B> <004B> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end'
    ),
    typed = add(
      `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 800] /FontMatrix [.001 0 0 .001 0 0] /CharProcs << /K ${charproc} 0 R >> /Encoding << /Type /Encoding /Differences [75 /K] >> /FirstChar 75 /LastChar 75 /Widths [600] /Resources << >> /ToUnicode ${unicode} 0 R >>`
    ),
    forms = [
      ...[60, 330].map((x, n) =>
        stream(
          (fault === 'unproved-pre-path-state' && n === 0 ? 'q Q ' : '') +
            `0.4 w ${x} 450 180 110 re S ${x + 20} 470 m ${x + 150} 540 l S ${x + 20} 490 m ${x + 150} 510 l S ` +
            (fault === 'clipped-label' && n === 0 ? `q ${x + 65} 410 2 14 re W n ` : '') +
            `BT /K 14 Tf 1 0 0 1 ${x + 65} 410 Tm (K) Tj ET ` +
            (fault === 'clipped-label' && n === 0 ? 'Q ' : '') +
            (fault === 'null-endpath' && n === 0 ? '0 0 m n' : ''),
          `/Type /XObject /Subtype /Form /BBox [${x - 2} ${['outer-form-clip', 'unproved-pre-path-state'].includes(fault) && n === 0 ? 411 : 398} ${x + 182} 562] /Resources << /Font << /K ${typed} 0 R >> >>`
        )
      ),
      stream(
        '0.4 w 100 170 180 110 re S 175 240 30 25 re S 160 195 60 40 re S 145 225 m 160 210 l S 220 210 m 235 225 l S BT /R 10 Tf 1 0 0 1 120 176 Tm (Device) Tj ET',
        `/Type /XObject /Subtype /Form /BBox [98 168 282 282] /Resources << /Font << /R ${ordinary} 0 R >> >>`
      )
    ],
    captions =
      fault === 'single-caption'
        ? 'BT /R 10 Tf 40 392 Td (Figure 1: Paired anonymous plots showing complete measurement series together with independently labelled axes.) Tj ET'
        : 'BT /R 10 Tf 40 392 Td (Figure 1: Complete anonymous left plot chart.) Tj ET BT /R 10 Tf 320 374 Td (Figure 2: Complete anonymous right plot chart.) Tj ET',
    body = stream(
      `q /A Do Q q /B Do Q q /C Do Q BT /R 10 Tf 105 220 Td (External device label) Tj ET ${fault === 'foreign-text' ? 'BT /R 10 Tf 100 420 Td (Foreign.) Tj ET' : ''} ${fault === 'foreign-paint' ? '100 420 10 5 re f' : ''} ${fault === 'gap-label' ? 'BT /R 2 Tf 125 404 Td (Gap label) Tj ET' : ''} ${captions} BT /R 10 Tf 90 138 Td (Figure 3: Complete anonymous device drawing.) Tj ET`
    ),
    page = add(
      `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 600 700] /Resources << /Font << /R ${ordinary} 0 R >> /XObject << /A ${forms[0]} 0 R /B ${forms[1]} 0 R /C ${forms[2]} 0 R >> >> /Contents ${body} 0 R >>`
    )
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`
  objects[pages - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`
  const f = await captureAnonymousVerticalFigure(objects, [58, 138, 244, 260])
  const rects = [
    [58, 138, 244, 260],
    [328, 138, 514, 260],
    [98, 418, 284, 532]
  ]
  f.peers = f.captions.map((caption) => ({
    rect: rects[Number(caption.lines[0].match(/^Figure (\d+):/u)[1]) - 1],
    caption
  }))
  f.figure = fault === 'outside-form-label' ? f.peers[2] : f.peers[0]
  return f
}
