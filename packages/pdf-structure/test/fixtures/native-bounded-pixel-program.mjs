/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectGraphicsBounds } from '../../resources/literature-pdf-graphics.mjs'
import {
  recordPaintedOperationBounds,
  captureNativeFigureRenderContext,
  matchNativeFigureRenderContext
} from '../../resources/literature-pdf-render-bounds.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
import {
  projectPdfTextLines,
  findCaptionCandidates
} from '../../resources/literature-pdf-caption-group.mjs'

export async function anonymousBoundedPixelProgram({ depth = 2, mode = '' } = {}) {
  const translated = ['touching-clip', 'tiny-gap-clip', 'far-disjoint-clip'].includes(mode),
    secondClip =
      mode === 'empty' || mode === 'far-disjoint-clip'
        ? '0 0 10 10 re W n '
        : mode === 'touching-clip'
          ? '150 100 10 100 re W n '
          : mode === 'tiny-gap-clip'
            ? '150.1 100 10 100 re W n '
            : '',
    curve =
      mode === 'rectangle'
        ? '50 100 100 100 re'
        : '60 100 m 140 100 l 145.52 100 150 104.48 150 110 c 150 190 l ' +
          '150 195.52 145.52 200 140 200 c 60 200 l 54.48 200 50 195.52 50 190 c ' +
          '50 110 l 50 104.48 54.48 100 60 100 c ' +
          (mode === 'unclosed' ? '' : 'h ') +
          (mode === 'multicontour' ? '20 20 m 30 20 l 30 30 l h ' : '0 0 m '),
    body =
      `q ${curve} W n ${secondClip}` +
      '0 0 1 rg 40 90 120 120 re f Q ' +
      '0 0 0 rg BT /F 10 Tf 65 160 Td (Panel) Tj ET',
    pageStream =
      (translated ? '1 0 0 1 0.2 0 cm ' : '') +
      '/G0 Do BT /F 10 Tf 50 60 Td (' +
      (translated || mode === 'figure' || mode === 'foreign' || mode === 'foreign-path'
        ? 'Figure 1: Anonymous bounded panel.'
        : 'Figure: anonymous') +
      ') Tj ET ' +
      (mode === 'foreign' ? 'BT /F 10 Tf 80 160 Td (Exterior) Tj ET' : '') +
      (mode === 'foreign-path' ? '0 0 0 rg 80 150 20 20 re f' : ''),
    objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R ' +
        '/Resources << /Font << /F 5 0 R >> /XObject << /G0 6 0 R >> >> >>',
      `<< /Length ${pageStream.length} >>\nstream\n${pageStream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    ]
  for (let n = 0; n < depth; n++) {
    const stream = n === depth - 1 ? body : '/Next Do',
      resources = `/Font << /F 5 0 R >> ${n < depth - 1 ? `/XObject << /Next ${7 + n} 0 R >>` : ''}`
    objects.push(
      `<< /Type /XObject /Subtype /Form /BBox [0 0 300 300] ` +
        `/Group << /S /Transparency /I ${mode === 'nonisolated' ? 'false' : 'true'} /K false >> ` +
        `/Resources << ${resources} >> /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    )
  }
  let bytes = '%PDF-1.4\n'
  const offsets = objects.map((object, n) => {
      const offset = bytes.length
      bytes += `${n + 1} 0 obj\n${object}\nendobj\n`
      return offset
    }),
    xref = bytes.length
  bytes +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
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
    canvas = createCanvas(450, 450),
    render = nativePage.render({
      canvas,
      canvasContext: canvas.getContext('2d'),
      viewport: nativePage.getViewport({ scale: 1.5 }),
      recordOperations: true
    })
  recordPaintedOperationBounds(render)
  await render.promise
  const graphics = collectGraphicsBounds(render, nativePage.recordedBBoxes),
    sha = 'b'.repeat(64),
    snapshot = captureNativeFigureRenderContext(
      render,
      1,
      content,
      viewport,
      graphics.graphicsBounds,
      sha,
      nativePage.commonObjs
    ),
    original = matchNativeFigureRenderContext(
      snapshot,
      1,
      content,
      viewport,
      graphics.graphicsBounds,
      sha
    ),
    context = { ...original, pageNumber: 1, sourceSha256: sha },
    page = {
      pageNumber: 1,
      width: viewport.width,
      height: viewport.height,
      rotation: 0,
      renderRotation: 0,
      lines: projectPdfTextLines(content, viewport),
      ...graphics
    },
    tokens = content.items
      .map((item, index) => ({ ...item, sourceItem: { pageNumber: 1, index, text: item.str } }))
      .filter((item) => item.str?.trim())
      .map((item) => tableTextToken(item, viewport, 0)),
    captions = findCaptionCandidates([page], new Map())
  return {
    page,
    tokens,
    context,
    nativePage,
    canvas,
    captions,
    cleanup: async () => {
      canvas.width = canvas.height = 1
      await document.destroy()
    }
  }
}
