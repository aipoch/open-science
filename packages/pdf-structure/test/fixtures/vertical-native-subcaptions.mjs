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

export async function anonymousVerticalNativeSubcaptions(fault = '') {
  const height = 700,
    tops = [80, 230, 380],
    literal = (s) => s.replace(/[\\()]/gu, '\\$&')
  const text = (s, x, y) => `${x} ${height - y} Tm (${literal(s)}) Tj`
  const label = (n) =>
    `BT /R 10 Tf 1 0 0 1 ${text(`(${fault === 'duplicate-letter' && n === 1 ? 'a' : String.fromCharCode(97 + n)}) Complete panel description.`, 60, tops[n] + 100)} ${fault === 'mixed-fonts' ? '/I 10 Tf' : ''} 1 0 0 1 ${text('Original continuation remains with this panel.', 60, tops[n] + 115)}`
  const stream =
    (fault === 'unclaimed-header'
      ? 'BT /R 10 Tf 60 660 Td (Independent original heading) Tj ET '
      : '') +
    tops
      .map((top, n) =>
        [
          fault === 'missing-form' && n === 1 ? '' : `/P${n} Do`,
          fault === 'clipped-label' && n === 1 ? `q 60 ${height - top - 120} 30 30 re W n` : '',
          label(n),
          n === 2
            ? `1 0 0 1 ${text('Figure 7: Anonymous composed measurements.', 60, 525)} 1 0 0 1 ${text('1', 300, 670)}`
            : '',
          'ET',
          fault === 'clipped-label' && n === 1 ? 'Q' : '',
          fault === 'foreign-label' && n === 0
            ? `BT /R 10 Tf 1 0 0 1 ${text('Independent foreign text.', 300, top + 128)} ET`
            : '',
          fault === 'foreign-paint' && n === 0 ? `300 ${height - top - 128} 8 5 re f` : '',
          fault === 'caption-rule' && n === 2 ? `0.4 w 300 200 m 340 200 l S` : ''
        ].join(' ')
      )
      .join(' ')
  const panels = tops.map(
    (top) =>
      `0 0 0 RG 0.4 w 100 ${height - top - 80} 380 80 re S 150 ${height - top - 60} 70 20 re S 300 ${height - top - 60} 70 30 re S BT /R 10 Tf 1 0 0 1 ${text('Original panel value', 120, top + 20)} ET`
  )
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /R 4 0 R /I 5 0 R >> /XObject << /P0 7 0 R /P1 8 0 R /P2 9 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ...panels.map(
      (s, n) =>
        `<< /Type /XObject /Subtype /Form /FormType 1 /BBox [100 ${height - tops[n] - 80} 480 ${height - tops[n]}] /Resources << /Font << /R 4 0 R >> >> /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`
    )
  ]
  const fixture = await captureAnonymousVerticalFigure(objects, [98, 378, 225, 462])
  if (fault === 'unclaimed-header')
    fixture.tokens = fixture.tokens.filter((t) => t.text !== 'Independent original heading')
  return fixture
}

export async function captureAnonymousVerticalFigure(objects, rect) {
  let source = '%PDF-1.7\n'
  const offsets = [0]
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source))
    source += `${i + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(source)
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((o) => String(o).padStart(10, '0') + ' 00000 n \n')
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const bytes = Buffer.from(source),
    assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const pdf = await getDocument({
    data: new Uint8Array(bytes),
    fontExtraProperties: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
    standardFontDataUrl: join(assets, 'standard_fonts') + '/',
    cMapUrl: join(assets, 'cmaps') + '/',
    cMapPacked: true,
    wasmUrl: join(assets, 'wasm') + '/'
  }).promise
  const nativePage = await pdf.getPage(1),
    v = nativePage.getViewport({ scale: 1 }),
    content = await nativePage.getTextContent(),
    canvas = createCanvas(900, 1050)
  const render = nativePage.render({
    canvas,
    canvasContext: canvas.getContext('2d'),
    viewport: nativePage.getViewport({ scale: 1.5 }),
    recordOperations: true
  })
  recordPaintedOperationBounds(render)
  await render.promise
  const graphics = collectGraphicsBounds(render, nativePage.recordedBBoxes),
    hash = createHash('sha256').update(bytes).digest('hex')
  const snapshot = captureNativeFigureRenderContext(
    render,
    1,
    content,
    v,
    graphics.graphicsBounds,
    hash,
    nativePage.commonObjs
  )
  const context = matchNativeFigureRenderContext(
    snapshot,
    1,
    content,
    v,
    graphics.graphicsBounds,
    hash
  )
  const page = {
    pageNumber: 1,
    width: 600,
    height: 700,
    rotation: 0,
    renderRotation: 0,
    lines: projectPdfTextLines(content, v),
    ...graphics
  }
  const tokens = content.items
    .map((r, index) => ({ ...r, sourceItem: { pageNumber: 1, index, text: r.str } }))
    .filter((r) => r.str?.trim())
    .map((r) => tableTextToken(r, v, 0))
  const captions = findCaptionCandidates([page]),
    figure = rect
      ? { rect, caption: captions[0] }
      : { reason: 'no-unambiguous-adjacent-graphics', caption: captions[0] }
  return {
    page,
    tokens,
    context,
    captions,
    figure,
    nativePage,
    bytes,
    pdf,
    cleanup: () => pdf.destroy()
  }
}
