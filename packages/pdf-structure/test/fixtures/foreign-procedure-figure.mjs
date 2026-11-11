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

export async function anonymousForeignProcedureFigure(fault = '') {
  const literal = (s) => s.replace(/[\\()]/gu, '\\$&'),
    text = (font, size, x, y, s) =>
      `BT /${font} ${size} Tf ${x} ${700 - y} Td (${literal(s)}) Tj ET`,
    statements = [
      [58, 'z = 0'],
      [58, 'for each entry do'],
      [74, 'z = z + entry'],
      [58, 'end'],
      [58, 'return z'],
      [58, 'Function transform(z):'],
      [74, 'a = z + 1'],
      [74, 'b = a + 1'],
      [74, 'c = b + 1'],
      [74, 'return c']
    ],
    header = [
      text('B', 10, 58, 60, fault === 'missing-input' ? 'Values: z' : 'Input: z'),
      text('B', 10, 58, 74, fault === 'missing-output' ? 'Result: z' : 'Output: z')
    ],
    body = statements.map(([x, s], i) => {
      if (fault === 'missing-closure' && i === 3) s = 'continue'
      if (fault === 'missing-return' && i === 9) s = 'c = c + 1'
      return (
        text(
          'B',
          7,
          i < 9 ? 44.2 : 40,
          98 + i * 14,
          String(fault === 'missing-number' && i === 4 ? 6 : i + 1)
        ) +
        ' ' +
        text([1, 3, 4, 5, 9].includes(i) ? 'B' : 'R', 10, x, 98 + i * 14, s)
      )
    }),
    title = text(
      'B',
      10,
      50,
      246,
      fault === 'panel-title' ? 'Figure 4: Another trial panel.' : 'Algorithm 2: Update values.'
    ),
    rails =
      fault === 'missing-rail'
        ? ''
        : `${fault === 'white-rail' ? '1 1 1 RG' : '0 0 0 RG'} 0.4 w 64 570 m 64 584 l S 64 472 m 64 528 l S 0 0 0 RG`,
    extra =
      fault === 'foreign-paint'
        ? '280 550 10 15 re f'
        : fault === 'foreign-label'
          ? text('R', 10, 230, 130, 'Panel A')
          : '',
    stream = [
      rails,
      fault === 'clipped-headers'
        ? 'q 35 460 200 161 re W n'
        : fault === 'clipped-closure'
          ? 'q 35 479 200 180 re W n'
          : '',
      header.join(' '),
      body.join(' '),
      ['clipped-headers', 'clipped-closure'].includes(fault) ? 'Q' : '',
      title,
      extra,
      '/Chart Do',
      text(
        'R',
        10,
        320,
        262,
        fault === 'composite-caption'
          ? 'Figure 4: (a) Steps and (b) outcomes.'
          : fault === 'algorithm-reference-caption'
            ? 'Figure 4: Algorithm and trial outcomes.'
            : 'Figure 4: Independent trial outcomes.'
      ),
      text('R', 10, 320, 276, 'All observations remain in this chart.')
    ].join(' '),
    chart = `0 0 0 RG 0.5 w 330 490 m 560 490 l S 330 490 m 330 620 l S
      0.2 0.5 0.8 rg 350 490 25 60 re f 400 490 25 90 re f 450 490 25 110 re f
      0 0 0 rg ${text('R', 10, 340, 225, 'Independent samples')}`,
    objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Contents 4 0 R /Resources << /Font << /R 5 0 R /B 6 0 R >> /XObject << /Chart 7 0 R >> >> >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>',
      `<< /Type /XObject /Subtype /Form /BBox [300 460 580 660] /Resources << /Font << /R 5 0 R >> >> /Length ${chart.length} >>\nstream\n${chart}\nendstream`
    ]
  let source = '%PDF-1.4\n'
  const offsets = objects.map((object, n) => {
      const offset = source.length
      source += `${n + 1} 0 obj\n${object}\nendobj\n`
      return offset
    }),
    xref = source.length
  source += `xref\n0 8\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const bytes = Buffer.from(source),
    assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    document = await getDocument({
      data: new Uint8Array(bytes),
      fontExtraProperties: true,
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
      standardFontDataUrl: join(assets, 'standard_fonts') + '/'
    }).promise,
    nativePage = await document.getPage(1),
    viewport = nativePage.getViewport({ scale: 1 }),
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
    tokens = content.items
      .map((item, index) => ({ ...item, sourceItem: { pageNumber: 1, index, text: item.str } }))
      .filter((item) => item.str?.trim())
      .map((item) => tableTextToken(item, viewport, 0)),
    captions = findCaptionCandidates([page]),
    figure = { rect: [35, 45, 570, 237], caption: captions.find((c) => c.rect[0] >= 300) }
  return {
    page,
    tokens,
    context,
    figure,
    captions,
    tables: [],
    peers: [figure],
    nativePage,
    cleanup: async () => {
      canvas.width = canvas.height = 1
      await document.destroy()
    }
  }
}
