/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { colonlessNativeRoutine } from './fixtures/colonless-native-routine.mjs'
import { resolve } from './paths'

const resource = (name: string) => import(pathToFileURL(resolve(`resources/${name}.mjs`)).href)
const { findNativeAlgorithmCandidates, acceptsNativeScopedAlgorithmPng } = await resource(
  'literature-pdf-algorithm-native-body'
)
const { renderPdfCrop } = await resource('literature-pdf-crop')
const { projectPdfTextLines } = await resource('literature-pdf-caption-group')
const { collectGraphicsBounds, collectTableRules } = await resource('literature-pdf-graphics')
const {
  recordPaintedOperationBounds,
  captureNativeFigureRenderContext,
  matchNativeFigureRenderContext
} = await resource('literature-pdf-render-bounds')

async function inspect(fault = '') {
  const bytes = await colonlessNativeRoutine(fault),
    secondData = bytes.slice(),
    checksum = createHash('sha256').update(bytes).digest('hex'),
    assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    loading = getDocument({
      data: bytes,
      fontExtraProperties: true,
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
      standardFontDataUrl: join(assets, 'standard_fonts') + '/'
    })
  let alternate: ReturnType<typeof getDocument> | undefined
  try {
    const pdf = await loading.promise,
      native = await pdf.getPage(1),
      viewport = native.getViewport({ scale: 1 }),
      scaled = native.getViewport({ scale: 1.5 }),
      content = await native.getTextContent(),
      operators = await native.getOperatorList(),
      canvas = createCanvas(Math.ceil(scaled.width), Math.ceil(scaled.height)),
      render = native.render({
        canvas: canvas as never,
        canvasContext: canvas.getContext('2d') as never,
        viewport: scaled,
        recordOperations: true
      })
    recordPaintedOperationBounds(render)
    await render.promise
    const graphics = collectGraphicsBounds(render, native.recordedBBoxes),
      snapshot = captureNativeFigureRenderContext(
        render,
        1,
        content,
        viewport,
        graphics.graphicsBounds,
        checksum,
        native.commonObjs
      ),
      bound = matchNativeFigureRenderContext(
        snapshot,
        1,
        content,
        viewport,
        graphics.graphicsBounds,
        checksum
      )
    expect(bound).toBeTruthy()
    const page = {
        pageNumber: 1,
        width: viewport.width,
        height: viewport.height,
        rotation: 0,
        renderRotation: 0,
        lines: projectPdfTextLines(content, viewport),
        ...graphics
      },
      context = {
        ...bound,
        content: bound.content,
        viewport,
        operators,
        rules: collectTableRules(operators, viewport),
        nativeGlyphContext: { ...bound, pageNumber: 1, sourceSha256: checksum }
      }
    let cropPage = native
    if (fault.startsWith('separate-document')) {
      alternate = getDocument({
        data: secondData,
        fontExtraProperties: true,
        useSystemFonts: false,
        isEvalSupported: false,
        verbosity: 0,
        standardFontDataUrl: join(assets, 'standard_fonts') + '/'
      })
      const second = await alternate.promise,
        currentPage = await second.getPage(1),
        currentViewport = currentPage.getViewport({ scale: 1 }),
        currentContent = await currentPage.getTextContent()
      context.content = {
        ...currentContent,
        items: currentContent.items.map((item, index) => ({
          ...item,
          sourceItem: { pageNumber: 1, index, text: 'str' in item ? item.str : '' }
        }))
      }
      context.viewport = currentViewport
      context.operators = await currentPage.getOperatorList()
      context.rules = collectTableRules(context.operators, currentViewport)
      context.nativeGlyphContext = matchNativeFigureRenderContext(
        snapshot,
        1,
        context.content,
        currentViewport,
        page.graphicsBounds,
        checksum
      )
      expect(context.nativeGlyphContext).toBeTruthy()
      const fontOperation = context.operators.fnArray.indexOf(OPS.setFont)
      expect(context.operators.argsArray[fontOperation][0]).not.toBe(
        context.nativeGlyphContext.operators.argsArray[fontOperation][0]
      )
      if (fault === 'separate-document-unbound-font')
        context.operators.argsArray[fontOperation][0] = 'unbound-font'
      page.lines = projectPdfTextLines(currentContent, currentViewport)
      cropPage = currentPage
    }
    const item = context.content.items.find((entry: { str?: string }) => entry.str?.trim())
    if (fault === 'source-index') item.sourceItem.index += 1
    if (fault === 'source-page') item.sourceItem.pageNumber += 1
    if (fault === 'source-width') item.width += 1
    if (fault === 'source-baseline') item.transform[5] += 1
    if (fault === 'font-metrics') context.content.styles[item.fontName].ascent -= 0.1
    if (fault === 'missing-graphic') page.graphicsBounds.shift()
    const result = findNativeAlgorithmCandidates(page, context)
    if (result[0]) {
      const png = await renderPdfCrop(cropPage, result[0].rect, 0, [result[0].rect])
      expect(acceptsNativeScopedAlgorithmPng(page, result[0], png)).toBe(true)
      expect(acceptsNativeScopedAlgorithmPng(page, result[0], new Uint8Array([1, 2, 3]))).toBe(
        false
      )
    }
    return result
  } finally {
    await alternate?.destroy()
    await loading.destroy()
  }
}

it.each(['', 'font-metrics', 'separate-document'])(
  'retains complete native ink for a wrapped column routine: %s',
  async (variant) => {
    const result = await inspect(variant)
    expect(result).toHaveLength(1)
    expect(result[0].caption.lines).toEqual([
      'Algorithm S1 Select a result.',
      'The complete caption continues on this line.'
    ])
    expect(result[0].rect[1]).toBeLessThanOrEqual(90)
    expect(result[0].rect[3]).toBeGreaterThanOrEqual(235)
    expect(result[0].nativeBody.sourceItems.map((item: { text: string }) => item.text)).toEqual(
      expect.arrayContaining(['SELECT(values, limit)', 'return fallback(values)'])
    )
    expect(
      result[0].nativeBody.sourceItems.some((item: { text: string }) =>
        /Independent/.test(item.text)
      )
    ).toBe(false)
  }
)

it.each([
  'title',
  'signature',
  'assignment',
  'condition',
  'indent',
  'return',
  'missing-number',
  'duplicate-number',
  'divider',
  'closing-rule',
  'foreign-line',
  'white-frame',
  'white-body',
  'translucent-body',
  'clipped-body',
  'foreign-paint',
  'source-index',
  'source-page',
  'source-width',
  'source-baseline',
  'missing-graphic',
  'separate-document-unbound-font'
])('does not recover an incomplete colonless native routine: %s', async (fault) => {
  expect(await inspect(fault)).toEqual([])
})
