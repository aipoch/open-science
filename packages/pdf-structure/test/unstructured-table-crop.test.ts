/* eslint-disable @typescript-eslint/explicit-function-return-type -- fixture geometry */
import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { OPS, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
// @ts-expect-error Worker resource has no declaration file.
import {
  completeNativeUnstructuredTableCrop,
  validateNativeGraphicalTableCropPng
} from '../resources/literature-pdf-native-graphical-table-crop.mjs'

function setup() {
  const width = 200,
    height = 200,
    paths = [
      [20, 20, 180, 21],
      [20, 80, 180, 81],
      [69, 20, 70, 81],
      [119, 20, 120, 81],
      [20, 49, 180, 50]
    ],
    graphicsBounds = paths.map((r, operationIndex) => ({
      kind: 'path',
      operationIndex,
      normalizedRect: r.map((n, i) => n / (i % 2 ? height : width))
    })),
    items = Array.from({ length: 12 }, (_, i) => ({
      str: String(i),
      dir: 'ltr',
      width: 8,
      height: 8,
      fontName: 'F',
      transform: [8, 0, 0, 8, 25 + (i % 3) * 50, 170 - Math.floor(i / 3) * 15]
    }))
  items.push({
    str: 'Table 1: Record values',
    dir: 'ltr',
    width: 90,
    height: 8,
    fontName: 'F',
    transform: [8, 0, 0, 8, 20, 108]
  })
  const table = {
      rect: [19, 19, 181, 75],
      caption: { page: 1, lines: ['Table 1: Record values'], rect: [20, 85, 180, 100] }
    },
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, graphicsBounds },
    context = {
      viewport: { width: 300, height: 300, scale: 1.5, rotation: 0 },
      nativeGlyphContext: {
        viewport: { width, height, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, height] },
        graphicsBounds,
        operators: {
          fnArray: paths.map(() => OPS.constructPath),
          argsArray: paths.map(([l, t, r, b]) => [
            OPS.fill,
            [[0, l, height - t, 1, r, height - t, 1, r, height - b, 1, l, height - b, 4]],
            [l, height - b, r, height - t]
          ])
        },
        content: { items, styles: { F: { ascent: 0.8, descent: -0.2, vertical: false } } }
      }
    },
    scope = {
      page,
      context: { ...context, sourceContent: context.nativeGlyphContext.content },
      competingRects: []
    }
  return { table, scope, items, paths, graphicsBounds }
}

it('completes the whole native graphic and validates final outward-rounded PNG pixels', async () => {
  const f = setup()
  // Recorded render cells overlap the caption; exact native rules do not.
  f.graphicsBounds[1].normalizedRect[3] = 0.48
  const proof = completeNativeUnstructuredTableCrop(f.table, f.scope)
  expect(proof?.table.rect).toEqual([19, 19, 181, 81])
  expect(proof.table.cells).toBeUndefined()
  expect(proof.table.sourceItems).toBeUndefined()
  const png = await sharp({ create: { width: 324, height: 124, channels: 3, background: 'white' } })
    .png()
    .toBuffer()
  expect(validateNativeGraphicalTableCropPng(png, proof)).toBe(true)
  f.items[0].width++
  expect(proof.current()).toBe(false)
})

it.each(['foreign-text', 'caption-overlap', 'disconnected', 'competing-body', 'unknown-font'])(
  'declines %s without changing the original candidate',
  (fault) => {
    const f = setup(),
      original = JSON.stringify(f.table)
    if (fault === 'foreign-text')
      f.items.push({ ...f.items[0], str: 'Unclaimed', transform: [8, 0, 0, 8, 30, 117] })
    if (fault === 'caption-overlap') f.items.at(-1)!.transform[5] = 122
    if (fault === 'disconnected') f.graphicsBounds[1].normalizedRect = [0.1, 0.6, 0.9, 0.605]
    if (fault === 'competing-body') f.scope.competingRects.push([25, 76, 170, 82] as never)
    if (fault === 'unknown-font') f.items[0].fontName = 'Missing'
    expect(completeNativeUnstructuredTableCrop(f.table, f.scope)).toBeUndefined()
    expect(JSON.stringify(f.table)).toBe(original)
  }
)

it.each(['raster-only', 'mixed-raster'])(
  'does not apply vector-rule completion to %s graphics or change the candidate',
  (kind) => {
    const f = setup(),
      operators = f.scope.context.nativeGlyphContext.operators
    if (kind === 'raster-only') {
      f.graphicsBounds.length = 0
      operators.fnArray.length = operators.argsArray.length = 0
    }
    f.graphicsBounds.push({
      kind: 'image',
      operationIndex: operators.fnArray.length,
      normalizedRect: [20 / 200, 20 / 200, 180 / 200, 81 / 200]
    })
    operators.fnArray.push(OPS.paintImageXObject)
    operators.argsArray.push(['TableImage', 160, 61] as never)
    const before = JSON.stringify([f.table, f.scope])
    expect(completeNativeUnstructuredTableCrop(f.table, f.scope)).toBeUndefined()
    expect(JSON.stringify([f.table, f.scope])).toBe(before)
  }
)

it('publishes the completed PNG through the real extractor context and graphical-table branch', async () => {
  const f = await realPublicationSetup(),
    output = await mkdtemp(join(tmpdir(), 'native-table-publication-')),
    source = await readFile(
      new URL('../resources/literature-pdf-extract.mjs', import.meta.url),
      'utf8'
    ),
    contextStart = source.indexOf('        const nativeRecordContext = {'),
    contextEnd = source.indexOf('        const hasNativeBoundaryMarker', contextStart),
    branchStart = source.indexOf('          const completeCrop ='),
    branchEnd = source.indexOf('          if (nativeVisual) {', branchStart)
  expect(contextStart).toBeGreaterThan(0)
  expect(contextEnd).toBeGreaterThan(contextStart)
  expect(branchStart).toBeGreaterThan(0)
  expect(branchEnd).toBeGreaterThan(branchStart)
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor,
    publish = new AsyncFunction(
      'env',
      `
      const {pageNumber,pageGeometry,originalPages,nativeFigureContext,nativeEvidenceGraphics,
        operators,viewport,sourceContent,pageCaptions,rulePaintBounds,graphicalTables,
        completeNativeUnstructuredTableCrop,validateNativeGraphicalTableCropPng,
        renderPdfCrop,crop,output,writeFile,readFileSync,join,page}=env;
      const markedSource=undefined, recognizedTableRects=[],tables=[],finalNativeBodyChecks=[],
        nativeVisualOnlyPng=new Map(),nativeMathBodySeedIdentities=new Set();
      const normalize=(r,w,h)=>({x:r[0]/w,y:r[1]/h,width:(r[2]-r[0])/w,height:(r[3]-r[1])/h});
      const captionValue=(caption)=>({text:caption.lines.join(' '),regions:[normalize(caption.rect,pageGeometry.width,pageGeometry.height)]});
      ${source.slice(contextStart, contextEnd)}
      for(const [index,table] of graphicalTables.entries()) {
        const id='native-table-'+index, nativeBody=undefined,nativeVisual=undefined,threeRulePixel=false,matrix=false;
        ${source.slice(branchStart, branchEnd)}
      }
      return {tables,finalNativeBodyChecks};
    `
    ),
    renderPdfCrop = vi.fn(f.renderPdfCrop),
    crop = vi.fn(async () => 'fallback.png')
  try {
    await mkdir(join(output, 'thumbnails'))
    const result = await publish({
      page: f.nativePage,
      pageNumber: 1,
      pageGeometry: f.scope.page,
      originalPages: new Map([[1, f.scope.page]]),
      nativeFigureContext: f.scope.context.nativeGlyphContext,
      nativeEvidenceGraphics: f.graphicsBounds.map((g) => ({
        kind: g.kind,
        rect: g.normalizedRect.map((n) => n * 300)
      })),
      operators: f.scope.context.nativeGlyphContext.operators,
      viewport: f.scope.context.viewport,
      sourceContent: f.scope.context.sourceContent,
      pageCaptions: [f.table.caption],
      rulePaintBounds: new Map(),
      graphicalTables: [f.table],
      completeNativeUnstructuredTableCrop,
      validateNativeGraphicalTableCropPng,
      renderPdfCrop,
      crop,
      output,
      writeFile,
      readFileSync,
      join
    })
    expect(crop).not.toHaveBeenCalled()
    expect(renderPdfCrop.mock.calls[0][1]).toEqual([19, 19, 181, 81])
    expect(result.tables[0].region).toEqual({
      x: 19 / 200,
      y: 19 / 200,
      width: 162 / 200,
      height: 62 / 200
    })
    const file = join(output, result.tables[0].thumbnail),
      metadata = await sharp(await readFile(file)).metadata()
    const originalMetadata = await sharp(
      await f.renderPdfCrop(f.nativePage, f.table.rect, 0)
    ).metadata()
    expect(metadata.width).toBe(originalMetadata.width)
    expect(metadata.height).toBeGreaterThan(originalMetadata.height!)
    expect(result.finalNativeBodyChecks).toHaveLength(1)
    expect(result.finalNativeBodyChecks[0]()).toBe(true)
    f.scope.context.nativeGlyphContext.content.items[0].width++
    expect(result.finalNativeBodyChecks[0]()).toBe(false)
  } finally {
    await rm(output, { recursive: true, force: true })
    await f.task.destroy()
  }
})

async function realPublicationSetup() {
  const f = setup(),
    program = [
      '0 g 20 179 160 1 re f 20 119 160 1 re f 69 119 1 61 re f 119 119 1 61 re f 20 150 160 1 re f',
      ...Array.from(
        { length: 12 },
        (_, i) =>
          `BT /F 8 Tf 1 0 0 1 ${25 + (i % 3) * 50} ${170 - Math.floor(i / 3) * 15} Tm (${i}) Tj ET`
      ),
      'BT /F 8 Tf 1 0 0 1 20 108 Tm (Table 1: Record values) Tj ET'
    ].join('\n'),
    objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${Buffer.byteLength(program)} >>\nstream\n${program}\nendstream`
    ],
    offsets = [0]
  let pdf = '%PDF-1.7\n'
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const bytes = new Uint8Array(Buffer.from(pdf)),
    hash = createHash('sha256').update(bytes).digest('hex'),
    pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    task = getDocument({
      data: bytes,
      fontExtraProperties: true,
      isEvalSupported: false,
      useSystemFonts: false,
      standardFontDataUrl: join(pdfjsRoot, 'standard_fonts') + '/'
    }),
    document = await task.promise,
    nativePage = await document.getPage(1),
    viewport = nativePage.getViewport({ scale: 1 }),
    scaled = nativePage.getViewport({ scale: 1.5 }),
    canvas = createCanvas(scaled.width, scaled.height),
    {
      recordPaintedOperationBounds,
      captureNativeFigureRenderContext,
      matchNativeFigureRenderContext
    } = await import('../resources/literature-pdf-render-bounds.mjs'),
    { collectGraphicsBounds } = await import('../resources/literature-pdf-graphics.mjs'),
    { renderPdfCrop } = await import('../resources/literature-pdf-crop.mjs'),
    rendering = nativePage.render({
      canvas: canvas as never,
      canvasContext: canvas.getContext('2d') as never,
      viewport: scaled,
      recordOperations: true
    })
  recordPaintedOperationBounds(rendering)
  await rendering.promise
  const content = await nativePage.getTextContent(),
    graphics = collectGraphicsBounds(
      rendering,
      (nativePage as ReturnType<typeof JSON.parse>).recordedBBoxes
    ),
    snapshot = captureNativeFigureRenderContext(
      rendering,
      1,
      content,
      viewport,
      graphics.graphicsBounds,
      hash,
      nativePage.commonObjs
    ),
    capture = {
      ...matchNativeFigureRenderContext(
        snapshot,
        1,
        content,
        viewport,
        graphics.graphicsBounds,
        hash
      ),
      pageNumber: 1,
      sourceSha256: hash
    },
    sourceContent = {
      ...content,
      items: content.items.map((item, index) =>
        'str' in item ? { ...item, sourceItem: { pageNumber: 1, index, text: item.str } } : item
      )
    }
  expect(capture.content.items.length).toBeGreaterThan(12)
  return {
    ...f,
    task,
    nativePage,
    renderPdfCrop,
    items: content.items as ReturnType<typeof JSON.parse>,
    graphicsBounds: graphics.graphicsBounds,
    scope: {
      page: { pageNumber: 1, width: 200, height: 200, renderRotation: 0, ...graphics },
      context: { viewport: scaled, nativeGlyphContext: capture, sourceContent },
      competingRects: []
    }
  }
}
