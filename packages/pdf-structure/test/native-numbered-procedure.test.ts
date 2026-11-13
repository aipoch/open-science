/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { anonymousIndentedProcedure } from './fixtures/anonymous-indented-procedure.mjs'
import { resolve } from './paths'

const resource = (name: string) => pathToFileURL(resolve(`resources/${name}.mjs`)).href
const { findNativeAlgorithmCandidates, acceptsNativeScopedAlgorithmPng } = await import(
  resource('literature-pdf-algorithm-native-body')
)
const { collectGraphicsBounds, collectTableRules } = await import(
  resource('literature-pdf-graphics')
)
const { projectPdfTextLines } = await import(resource('literature-pdf-caption-group'))
const {
  recordPaintedOperationBounds,
  captureNativeFigureRenderContext,
  matchNativeFigureRenderContext
} = await import(resource('literature-pdf-render-bounds'))
const { renderPdfCrop } = await import(resource('literature-pdf-crop'))

async function inspectProcedure(fault = '') {
  const bytes = await anonymousIndentedProcedure(fault),
    sourceSha256 = createHash('sha256').update(bytes).digest('hex'),
    assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    loading = getDocument({
      data: bytes,
      fontExtraProperties: true,
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
      standardFontDataUrl: join(assets, 'standard_fonts') + '/'
    })

  try {
    const pdf = await loading.promise,
      nativePage = await pdf.getPage(1),
      content = await nativePage.getTextContent(),
      operators = await nativePage.getOperatorList(),
      viewport = nativePage.getViewport({ scale: 1 }),
      scaled = nativePage.getViewport({ scale: 1.5 }),
      canvas = createCanvas(Math.ceil(scaled.width), Math.ceil(scaled.height)),
      render = nativePage.render({
        canvas: canvas as never,
        canvasContext: canvas.getContext('2d') as never,
        viewport: scaled,
        recordOperations: true
      })

    recordPaintedOperationBounds(render)
    await render.promise
    const graphics = collectGraphicsBounds(render, nativePage.recordedBBoxes),
      snapshot = captureNativeFigureRenderContext(
        render,
        1,
        content,
        viewport,
        graphics.graphicsBounds,
        sourceSha256,
        nativePage.commonObjs
      ),
      bound = matchNativeFigureRenderContext(
        snapshot,
        1,
        content,
        viewport,
        graphics.graphicsBounds,
        sourceSha256
      )

    expect(bound).toBeTruthy()
    const page = {
        pageNumber: 1,
        width: viewport.width,
        height: viewport.height,
        rotation: viewport.rotation,
        renderRotation: viewport.rotation,
        lines: projectPdfTextLines(content, viewport),
        ...graphics
      },
      context = {
        ...bound,
        content: bound!.content,
        viewport,
        operators,
        rules: collectTableRules(operators, viewport),
        nativeGlyphContext: { ...bound, pageNumber: 1, sourceSha256 }
      },
      result = findNativeAlgorithmCandidates(page, context),
      candidate = result.find(
        (entry: { nativeBody?: { kind?: string } }) => entry.nativeBody?.kind === 'algorithm'
      )

    const crop = candidate
      ? await renderPdfCrop(nativePage, candidate.rect, nativePage.rotate, [candidate.rect])
      : undefined
    return {
      candidate,
      pngAccepted: !!candidate && acceptsNativeScopedAlgorithmPng(page, candidate, crop)
    }
  } finally {
    await loading.destroy()
  }
}

it('recognizes a fully owned two-line, two-digit numbered procedure in an anonymous PDF', async () => {
  const { candidate, pngAccepted } = await inspectProcedure()
  expect(candidate).toBeTruthy()
  expect(candidate.caption.lines).toEqual([
    'Procedure 12: Bounded update',
    'The second line is part of the complete caption.'
  ])
  expect(candidate.nativeBody.sourceItems.map((item: { text: string }) => item.text)).toEqual(
    expect.arrayContaining(['1:', 'procedure Update(values, limit)', '10:', 'return accumulator'])
  )
  expect(candidate.nativeBody.sourceItems).toHaveLength(20)
  expect(pngAccepted).toBe(true)
})

it.each([
  'missing-loop',
  'missing-if',
  'orphan-else',
  'no-return',
  'missing-number',
  'duplicate-number',
  'ordinal-font-mutation',
  'missing-divider',
  'empty-caption',
  'missing-caption',
  'foreign-return'
])('rejects the native PDF mutation %s', async (fault) => {
  const { candidate } = await inspectProcedure(fault)
  expect(candidate).toBeUndefined()
})
