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
import {
  collectGraphicsBounds,
  collectTableRules
} from '../../resources/literature-pdf-graphics.mjs'
import {
  projectPdfTextLines,
  findCaptionCandidates
} from '../../resources/literature-pdf-caption-group.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'

export async function anonymousSeparatedTableCaption(fault = '') {
  const literal = (s) => s.replace(/[\\()]/gu, '\\$&'),
    text = (x, y, s) => `BT /R 10 Tf ${x} ${700 - y} Td (${literal(s)}) Tj ET`,
    top = fault === 'intersecting-caption' ? 340 : fault === 'crossing-caption' ? 250 : 100,
    title =
      fault === 'same-figure-caption'
        ? 'Figure 4: Another view of this figure.'
        : fault === 'foreign-figure-caption'
          ? 'Figure 3: Another independent drawing.'
          : 'Table 3: Independent measurements from a separate native table.',
    tableBottom = fault === 'nearby-table' ? 245 : 150,
    stream = [
      fault === 'clipped-caption' ? 'q 35 600 530 6 re W n' : '',
      text(40, top, title),
      fault === 'clipped-caption' ? 'Q' : '',
      `0.5 w 40 590 m 550 590 l S 40 570 m 550 570 l S 40 ${700 - tableBottom} m 550 ${700 - tableBottom} l S`,
      text(60, 124, 'Entry                     Measurement'),
      text(60, 144, 'Group A                   12'),
      '/A Do',
      text(85, 412, '(a) First complete panel.'),
      '/B Do',
      text(355, 412, '(b) Second complete panel.'),
      text(60, 450, 'Figure 4: Two independent native panels.')
    ].join(' '),
    panel = (x, label) =>
      `0.5 w ${x} 330 180 110 re S ${x + 20} 330 20 65 re f ${text(x + 20, 253, label)} ${text(x + 60, 385, 'Samples')}`,
    a = panel(60, 'First view'),
    b = panel(330, 'Second view'),
    objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Contents 4 0 R /Resources << /Font << /R 5 0 R >> /XObject << /A 6 0 R /B 7 0 R >> >> >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
      `<< /Type /XObject /Subtype /Form /BBox [40 300 260 460] /Resources << /Font << /R 5 0 R >> >> /Length ${a.length} >>\nstream\n${a}\nendstream`,
      `<< /Type /XObject /Subtype /Form /BBox [310 300 560 460] /Resources << /Font << /R 5 0 R >> >> /Length ${b.length} >>\nstream\n${b}\nendstream`
    ]
  let source = '%PDF-1.4\n'
  const offsets = objects.map((o, n) => {
      const offset = source.length
      source += `${n + 1} 0 obj\n${o}\nendobj\n`
      return offset
    }),
    xref = source.length
  source += `xref\n0 8\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const bytes = Buffer.from(source),
    assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    pdf = await getDocument({
      data: new Uint8Array(bytes),
      fontExtraProperties: true,
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
      standardFontDataUrl: join(assets, 'standard_fonts') + '/'
    }).promise,
    nativePage = await pdf.getPage(1),
    viewport = nativePage.getViewport({ scale: 1 }),
    content = await nativePage.getTextContent(),
    operators = await nativePage.getOperatorList(),
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
    sha = createHash('sha256').update(bytes).digest('hex'),
    snapshot = captureNativeFigureRenderContext(
      render,
      1,
      content,
      viewport,
      graphics.graphicsBounds,
      sha,
      nativePage.commonObjs
    ),
    context = matchNativeFigureRenderContext(
      snapshot,
      1,
      content,
      viewport,
      graphics.graphicsBounds,
      sha
    ),
    page = {
      pageNumber: 1,
      width: 600,
      height: 700,
      rotation: 0,
      renderRotation: 0,
      lines: projectPdfTextLines(content, viewport),
      ...graphics
    },
    rules = collectTableRules(operators, viewport),
    captions = findCaptionCandidates([page], new Map([[1, rules]])),
    figure = {
      caption: captions.find((c) => c.lines[0].startsWith('Figure 4: Two')),
      rect: [55, 245, 545, 399]
    },
    tokens = content.items
      .map((r, index) => ({ ...r, sourceItem: { pageNumber: 1, index, text: r.str } }))
      .filter((r) => r.str?.trim())
      .map((r) => tableTextToken(r, viewport, 0)),
    tables = [[40, 110, 550, tableBottom]]
  if (fault === 'no-table') tables.length = 0
  if (fault === 'ambiguous-table') tables.push([...tables[0]])
  if (fault === 'width-mismatch') tables[0][2] = 180
  const prior = captions.find((c) => c !== figure.caption)
  if (fault === 'fake-caption-label')
    prior.lines[0] = prior.lines[0].replace('measurements', 'observations')
  if (fault === 'fake-caption-rect') {
    prior.rect[0] += 0.04
    prior.rect[2] += 0.04
  }
  return {
    page,
    figure,
    captions,
    tables,
    tokens,
    context,
    peers: [figure],
    nativePage,
    cleanup: async () => {
      canvas.width = canvas.height = 1
      await pdf.destroy()
    }
  }
}
