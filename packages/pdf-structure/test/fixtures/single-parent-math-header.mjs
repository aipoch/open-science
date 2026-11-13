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
  matchNativeFigureRenderContext
} from '../../resources/literature-pdf-render-bounds.mjs'
import {
  projectPdfTextLines,
  findCaptionCandidates
} from '../../resources/literature-pdf-caption-group.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'

export async function anonymousSingleParentMathHeader(mode) {
  const text = (s, x, y, size = 10) => `BT /F ${size} Tf ${x} ${400 - y} Td (${s}) Tj ET`,
    stream = [
      text('Table', 40, 80),
      text('1:', 68, 80),
      text('Anonymous', 80, 80),
      text('measurements.', 140, 80),
      '0.5 w 40 295 m 260 295 l S 40 245 m 260 245 l S 40 185 m 260 185 l S',
      text('Category', 170, 120),
      text('Measure', 50, 140),
      text('Low', 150, 140),
      text('High', 220, 140),
      ...(mode === 'extra-parent' ? [text('Extra', 100, 120)] : []),
      ...(mode === 'extra-leaf' ? [text('Extra', 100, 140)] : []),
      ...(mode === 'foreign-paint' ? ['100 230 m 190 230 l S'] : []),
      ...[175, 200].flatMap((y, n) => [
        text(n && mode === 'stub' ? 'z' : 'x', 50, y),
        text('2', 55.1, y + 1.5, 7),
        text(n ? '>' : '<', 63, y),
        text('0.4', 75, y),
        text(n ? '3' : '8', 160, y),
        ...(mode === 'missing-value' && n ? [] : [text(n ? '11' : '6', 225, y)]),
        ...(mode === 'extra-value' && !n ? [text('9', 200, y)] : [])
      ])
    ].join('\n')
  return captureAnonymousHeader(stream, [58, 155, 392, 325])
}

export async function captureAnonymousHeader(stream, cropRect) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R /Resources << /Font << /F 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((o, i) => {
      const p = pdf.length
      pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
      return p
    }),
    xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((x) => `${String(x).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    document = await getDocument({
      data: new Uint8Array(Buffer.from(pdf)),
      fontExtraProperties: true,
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
      standardFontDataUrl: join(assets, 'standard_fonts') + '/'
    }).promise,
    nativePage = await document.getPage(1),
    v = nativePage.getViewport({ scale: 1 }),
    viewport = nativePage.getViewport({ scale: 1.5 }),
    content = await nativePage.getTextContent(),
    canvas = createCanvas(450, 600),
    render = nativePage.render({
      canvas,
      canvasContext: canvas.getContext('2d'),
      viewport,
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
      v,
      graphics.graphicsBounds,
      sha,
      nativePage.commonObjs
    ),
    matched = matchNativeFigureRenderContext(snapshot, 1, content, v, graphics.graphicsBounds, sha),
    sourceContent = {
      ...content,
      items: content.items.map((i, index) => ({
        ...i,
        sourceItem: { pageNumber: 1, index, text: i.str }
      }))
    },
    items = sourceContent.items
      .filter((i) => i.str?.trim())
      .map((i) => tableTextToken(i, viewport, 0)),
    page = {
      pageNumber: 1,
      width: 300,
      height: 400,
      rotation: 0,
      renderRotation: 0,
      lines: projectPdfTextLines(content, v),
      ...graphics
    },
    captions = findCaptionCandidates(
      [page],
      new Map([[1, collectTableRules(matched.operators, v)]])
    ).map((c) => ({ ...c, rect: c.rect.map((x) => x * 1.5) })),
    rules = collectTableRules(matched.operators, viewport),
    context = {
      sourcePage: page,
      nativeGlyphContext: { ...matched },
      sourceContent,
      content: sourceContent,
      viewport,
      operators: matched.operators
    },
    table = {
      readingRotation: 0,
      cropRect,
      structure: {
        objects: [
          { label: 'table column', rect: [0, 0, 130, 170] },
          { label: 'table column', rect: [130, 0, 230, 170] },
          { label: 'table column', rect: [230, 0, 334, 170] }
        ]
      }
    }
  return {
    table,
    items,
    captions,
    rules,
    context,
    nativePage,
    cleanup: async () => {
      canvas.width = canvas.height = 1
      await document.destroy()
    }
  }
}
