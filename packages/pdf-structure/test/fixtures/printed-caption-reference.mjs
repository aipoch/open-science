/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectGraphicsBounds } from '../../resources/literature-pdf-graphics.mjs'
import { recordPaintedOperationBounds } from '../../resources/literature-pdf-render-bounds.mjs'
import { projectPdfTextLines } from '../../resources/literature-pdf-caption-group.mjs'

export async function anonymousPrintedCaptionReference(fault = '') {
  const rows = [
    [40, 165, 'Figure 7: Regional scores in several trial groups'],
    [40, 179, 'Every measured condition is printed in this panel;'],
    [40, 193, 'and independent observations remain visible here.'],
    [40, 232, 'A preceding paragraph establishes the full record.'],
    [40, 246, 'Its second line continues the same physical lane.'],
    [40, 260, 'The prior statement ends.'],
    [52, 276, 'Figure 7 aggregates all observations by position'],
    [40, 290, 'The following line retains all original records.'],
    [40, 304, 'Another line continues the same native paragraph.'],
    [40, 318, 'Closing sentence ends here.'],
    [52, 336, 'A separate paragraph starts after the reference.']
  ]
  if (fault === 'missing-caption') rows.splice(0, 3)
  if (fault === 'other-number') rows[0][2] = rows[0][2].replace('7:', '8:')
  if (fault === 'unfinished-caption') rows[2][2] = rows[2][2].slice(0, -1)
  if (fault === 'unfinished-paragraph') rows[9][2] = rows[9][2].slice(0, -1)
  if (fault === 'no-indent') rows[6][0] = 40
  if (fault === 'missing-prior-paragraph') rows.splice(3, 3)
  if (fault === 'punctuated-title') rows[6][2] = rows[6][2].replace('7 ', '7: ')
  if (fault === 'continued-caption') rows[6][2] = 'Figure 7 Continued measurements in another panel'
  if (fault === 'duplicate-caption')
    rows.unshift(
      [40, 20, 'Figure 7: A separately printed title for the panel'],
      [40, 34, 'This independent title is complete.']
    )
  const literal = (s) => s.replace(/[\\()]/gu, '\\$&'),
    text = rows
      .map(([x, y, s]) => `BT /F 10 Tf ${x} ${700 - y} Td (${literal(s)}) Tj ET`)
      .join(' '),
    drawing = fault === 'missing-graphic' ? '' : '40 560 320 100 re S ',
    extra =
      fault === 'body-graphic'
        ? '45 405 20 20 re S '
        : ['following-graphic', 'continued-caption'].includes(fault)
          ? '40 310 320 60 re S '
          : '',
    stream = drawing + extra + text,
    objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 700] /Contents 4 0 R /Resources << /Font << /F 5 0 R >> >> >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'
    ]
  let bytes = '%PDF-1.4\n'
  const offsets = objects.map((object, n) => {
      const offset = bytes.length
      bytes += `${n + 1} 0 obj\n${object}\nendobj\n`
      return offset
    }),
    xref = bytes.length
  bytes +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    document = await getDocument({
      data: new Uint8Array(Buffer.from(bytes)),
      fontExtraProperties: true,
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
      standardFontDataUrl: join(assets, 'standard_fonts') + '/'
    }).promise,
    nativePage = await document.getPage(1),
    viewport = nativePage.getViewport({ scale: 1 }),
    content = await nativePage.getTextContent(),
    canvas = createCanvas(600, 1050),
    render = nativePage.render({
      canvas,
      canvasContext: canvas.getContext('2d'),
      viewport: nativePage.getViewport({ scale: 1.5 }),
      recordOperations: true
    })
  recordPaintedOperationBounds(render)
  await render.promise
  const page = {
    pageNumber: 1,
    width: 400,
    height: 700,
    rotation: 0,
    renderRotation: 0,
    lines: projectPdfTextLines(content, viewport),
    ...collectGraphicsBounds(render, nativePage.recordedBBoxes)
  }
  return {
    page,
    content,
    cleanup: async () => {
      canvas.width = canvas.height = 1
      await document.destroy()
    }
  }
}
