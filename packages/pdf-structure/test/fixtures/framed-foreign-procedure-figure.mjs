/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  recordPaintedOperationBounds,
  captureNativeFigureRenderContext,
  matchNativeFigureRenderContext
} from '../../resources/literature-pdf-render-bounds.mjs'
import { collectGraphicsBounds } from '../../resources/literature-pdf-graphics.mjs'
import {
  projectPdfTextLines,
  findCaptionCandidates
} from '../../resources/literature-pdf-caption-group.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
export async function anonymousFramedForeignProcedureFigure(fault = '') {
  const H = 700,
    literal = (s) => s.replace(/[\\()]/gu, '\\$&'),
    text = (font, size, x, y, s) => `BT /${font} ${size} Tf ${x} ${H - y} Td (${literal(s)}) Tj ET`,
    line = (y, right = 500) => `60 ${H - y} m ${right} ${H - y} l S`,
    statements = [
      'procedure Update(x)',
      'Initialize total',
      'while x > 0 do',
      'total = total + x',
      'x = x - 1',
      'if total > 0 then',
      'record value',
      'return total'
    ]
  const title = [
      text('B', 10, 60, 78, fault === 'missing-title' ? 'Closed update' : 'Procedure 3'),
      text('R', 10, 130, 78, 'Update values from complete inputs.'),
      text('I', 10, 60, 92, 'All steps remain inside this closed block.')
    ].join(' '),
    body = statements
      .map(
        (s, i) =>
          text(
            'R',
            9,
            63,
            115 + i * 14,
            fault === 'missing-ordinal' && i === 3
              ? ''
              : String(fault === 'duplicate-ordinal' && i === 3 ? 3 : i + 1) + ':'
          ) +
          ' ' +
          text(
            i === 0 || i === 7 ? 'B' : 'R',
            9,
            85,
            115 + i * 14,
            fault === 'missing-return' && i === 7 ? 'write total' : s
          )
      )
      .join(' '),
    bboxTop = fault === 'own-intersection' ? 220 : 260
  const stream = [
      '0 0 0 RG 0.4 w',
      line(60),
      line(98),
      fault === 'clipped-title' ? 'q 60 600 115 80 re W n' : '',
      title,
      fault === 'double-title' ? text('B', 10, 320, 92, 'Procedure 4') : '',
      fault === 'clipped-title' ? 'Q' : '',
      fault === 'clipped-body' ? 'q 60 490 440 100 re W n' : '',
      body,
      fault === 'clipped-body' ? 'Q' : '',
      fault === 'foreign-paint' ? '350 510 8 8 re f' : '',
      fault === 'missing-closing'
        ? ''
        : `${fault === 'white-closing' ? '1 1 1 RG ' : ''}${fault === 'dashed-closing' ? '[3 2] 0 d ' : ''}${fault === 'round-cap' ? '1 J ' : fault === 'square-cap' ? '2 J ' : ''}${fault === 'hairline' ? '0 w ' : ''}${line(230, fault === 'short-closing' ? 499 : 500)} 0 0 0 RG [] 0 d 0 J 0.4 w`,
      fault === 'foreign-label' ? text('R', 9, 320, 244, 'Independent panel label') : '',
      '/Chart Do',
      text(
        'R',
        10,
        60,
        465,
        fault === 'composite-caption'
          ? 'Figure 9: (a) Steps and (b) chart outcomes.'
          : 'Figure 9: Independent chart outcomes.'
      ),
      fault === 'partial-caption-exclusion'
        ? text('R', 10, 60, 478, 'All original samples remain visible.')
        : ''
    ].join(' '),
    chart = [
      `1 1 1 rg 60 270 440 ${H - bboxTop - 270} re f 0 0 0 rg 0 0 0 RG 0.4 w`,
      '85 300 m 480 300 l S 85 300 m 85 410 l S',
      '0.2 0.5 0.8 rg 110 300 40 60 re f 190 300 40 90 re f 270 300 40 100 re f',
      '0 0 0 rg',
      text('R', 10, 100, 420, 'Complete chart labels'),
      text('B', 10, 100, 282, 'Independent samples')
    ].join(' '),
    objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /R 4 0 R /B 5 0 R /I 6 0 R >> /XObject << /Chart 8 0 R >> >> /Contents 7 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>',
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
      `<< /Type /XObject /Subtype /Form /FormType 1 /BBox [60 270 500 ${H - bboxTop}] /Resources << /Font << /R 4 0 R /B 5 0 R >> >> /Length ${Buffer.byteLength(chart)} >>\nstream\n${chart}\nendstream`
    ]
  let source = '%PDF-1.7\n'
  const offsets = [0]
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(source))
    source += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xref = Buffer.byteLength(source)
  source +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((x) => String(x).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const bytes = Buffer.from(source),
    assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    pdf = await getDocument({
      data: new Uint8Array(bytes),
      fontExtraProperties: true,
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
      standardFontDataUrl: join(assets, 'standard_fonts') + '/',
      cMapUrl: join(assets, 'cmaps') + '/',
      cMapPacked: true,
      wasmUrl: join(assets, 'wasm') + '/'
    }).promise,
    nativePage = await pdf.getPage(1),
    v = nativePage.getViewport({ scale: 1 }),
    content = await nativePage.getTextContent(),
    canvas = createCanvas(900, 1050),
    render = nativePage.render({
      canvas,
      canvasContext: canvas.getContext('2d'),
      viewport: nativePage.getViewport({ scale: 1.5 }),
      recordOperations: true
    })
  recordPaintedOperationBounds(render)
  await render.promise
  const graphics = collectGraphicsBounds(render, nativePage.recordedBBoxes),
    snapshot = captureNativeFigureRenderContext(
      render,
      1,
      content,
      v,
      graphics.graphicsBounds,
      createHash('sha256').update(bytes).digest('hex'),
      nativePage.commonObjs
    ),
    context = matchNativeFigureRenderContext(
      snapshot,
      1,
      content,
      v,
      graphics.graphicsBounds,
      createHash('sha256').update(bytes).digest('hex')
    ),
    page = {
      pageNumber: 1,
      width: 600,
      height: 700,
      rotation: 0,
      renderRotation: 0,
      lines: projectPdfTextLines(content, v),
      ...graphics
    },
    tokens = content.items
      .map((r, index) => ({ ...r, sourceItem: { pageNumber: 1, index, text: r.str } }))
      .filter((r) => r.str?.trim())
      .map((r) => tableTextToken(r, v, 0)),
    captions = findCaptionCandidates([page]),
    figure = { rect: [50, 228, 510, 445], caption: captions[0] }
  return {
    page,
    tokens,
    context,
    captions,
    figure,
    nativePage,
    canvas,
    bytes,
    pdf,
    cleanup: () => pdf.destroy()
  }
}
