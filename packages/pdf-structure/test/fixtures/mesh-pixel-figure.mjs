/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas } from '@napi-rs/canvas'
import {
  collectGraphicsBounds,
  collectTableRules
} from '../../resources/literature-pdf-graphics.mjs'
import {
  recordPaintedOperationBounds,
  captureNativeFigureRenderContext,
  matchNativeFigureRenderContext,
  bindNativeMesh4RenderContext
} from '../../resources/literature-pdf-render-bounds.mjs'
import {
  projectPdfTextLines,
  findCaptionCandidates
} from '../../resources/literature-pdf-caption-group.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'

function bytes(foreignInside) {
  const vertices = [
      [0, 0, 230, 80, 90],
      [255, 0, 80, 180, 90],
      [0, 255, 80, 90, 230],
      [255, 0, 80, 180, 90],
      [255, 255, 180, 90, 200],
      [0, 255, 80, 90, 230]
    ],
    hex =
      vertices
        .flatMap((v) => [0, ...v])
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('') + '>',
    form = 'q /Pattern cs /P scn 0 0 40 30 re f Q 0 0 0 rg BT /F 10 Tf 55 12 Td (Label) Tj ET',
    content = `q 1 0 0 1 30 140 cm /Fm Do Q BT /F 10 Tf 30 120 Td (Figure 1: Anonymous mesh.) Tj ET BT /F 10 Tf ${foreignInside ? '65 155' : '210 180'} Td (Foreign prose.) Tj ET`,
    objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F 5 0 R >> /XObject << /Fm 6 0 R >> >> >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Type /XObject /Subtype /Form /BBox [0 0 140 100] /Resources << /Font << /F 5 0 R >> /Pattern << /P 7 0 R >> >> /Length ${form.length} >>\nstream\n${form}\nendstream`,
      '<< /Type /Pattern /PatternType 2 /Matrix [1 0 0 1 0 0] /Shading 8 0 R >>',
      `<< /ShadingType 4 /ColorSpace /DeviceRGB /BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 40 0 30 0 1 0 1 0 1] /Filter /ASCIIHexDecode /Length ${hex.length} >>\nstream\n${hex}\nendstream`
    ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, i) => {
      const offset = pdf.length
      pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
      return offset
    }),
    xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf))
}

export async function anonymousNativeMeshFigure(foreignInside = false) {
  const assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    document = await getDocument({
      data: bytes(foreignInside),
      fontExtraProperties: true,
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
      standardFontDataUrl: join(assets, 'standard_fonts') + '/',
      cMapUrl: join(assets, 'cmaps') + '/',
      cMapPacked: true,
      wasmUrl: join(assets, 'wasm') + '/'
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
    sha = 'a'.repeat(64),
    snapshot = captureNativeFigureRenderContext(
      render,
      1,
      content,
      viewport,
      graphics.graphicsBounds,
      sha,
      nativePage.commonObjs
    ),
    matched = matchNativeFigureRenderContext(
      snapshot,
      1,
      content,
      viewport,
      graphics.graphicsBounds,
      sha
    ),
    context = bindNativeMesh4RenderContext({ ...matched }, matched),
    tokens = context.content.items
      .filter((r) => r.str?.trim())
      .map((r) => tableTextToken(r, context.viewport, 0)),
    page = {
      pageNumber: 1,
      width: 300,
      height: 300,
      rotation: 0,
      renderRotation: 0,
      lines: projectPdfTextLines(content, viewport),
      ...graphics
    },
    captions = findCaptionCandidates(
      [page],
      new Map([[1, collectTableRules(context.operators, viewport)]])
    ),
    figure = { id: 'anonymous', caption: captions[0], rect: [25, 100, 285, 165] },
    peers = [figure]
  return {
    args: [page, figure, captions, [], tokens, context, peers, figure.rect],
    nativePage,
    render,
    snapshot,
    cleanup: async () => {
      canvas.width = canvas.height = 1
      await document.destroy()
    }
  }
}
