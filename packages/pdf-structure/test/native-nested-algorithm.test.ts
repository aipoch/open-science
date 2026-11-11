/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import {
  PDFDocument,
  rgb,
  moveTo,
  lineTo,
  stroke,
  setLineWidth,
  setStrokingRgbColor,
  setFillingRgbColor,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  showText
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
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

// Two anonymous three-rule frames, with no paper text, identifiers or model output.
async function fixturePdf(fault = '') {
  const rows: [string, number, number, string][] = [
    ['Algorithm 1: Update state', 50, 100, 'B'],
    ['Init: state', 60, 125, 'B'],
    ['while ready do', 60, 145, 'B'],
    ['Update state', 70, 165, 'T'],
    ['for each item do', 70, 185, 'B'],
    ['Store item', fault === 'indent' ? 60 : 80, 205, 'T'],
    [fault === 'closing' ? 'end while' : 'end for', 70, 225, 'B'],
    ['Record state', 70, 245, 'T'],
    ['end while', 60, 265, 'B'],
    ['Algorithm 2: Select state', 50, 320, 'B'],
    ['Input: values', 60, 345, 'B'],
    ['for each item do', 60, 365, 'B'],
    ['if ready then Store item', 70, 385, 'B'],
    ['end for', 60, 405, 'B'],
    ['if ready then', 60, 425, 'B'],
    ['Store state', 70, 445, 'T'],
    ['end if', 60, 465, 'B'],
    ['Independent paragraph.', 50, 530, 'T']
  ]
  const rails = [90, 105, 285, 310, 325, 485]
  if (fault === 'missing-frame') rails.splice(2, 1)
  const doc = await PDFDocument.create()
  doc.registerFontkit(createRequire(import.meta.url)('fontkit'))
  const fontBytes = await readFile(
    join(
      dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
      'standard_fonts/LiberationSans-Regular.ttf'
    )
  )
  const font = await doc.embedFont(fontBytes),
    page = doc.addPage([600, 800])
  const fontKey = page.node.newFontDictionary('Native', font.ref)
  if (fault === 'white-body') page.pushOperators(setFillingRgbColor(1, 1, 1))
  for (const [text, x, y] of rows)
    page.pushOperators(
      beginText(),
      setFontAndSize(fontKey, 10),
      setTextMatrix(1, 0, 0, 1, x, 800 - y),
      showText(font.encodeText(text)),
      endText()
    )
  page.pushOperators(
    setLineWidth(0.5),
    setStrokingRgbColor(...(fault === 'white-rail' ? ([1, 1, 1] as const) : ([0, 0, 0] as const)))
  )
  for (const y of rails) page.pushOperators(moveTo(50, 800 - y), lineTo(550, 800 - y), stroke())
  if (fault === 'foreign-paint')
    page.drawRectangle({ x: 200, y: 600, width: 10, height: 10, color: rgb(0, 0, 0) })
  return doc.save()
}

async function withFixture(
  fault: string,
  inspect: (f: ReturnType<typeof JSON.parse>) => Promise<void>
) {
  const bytes = await fixturePdf(fault),
    sha = createHash('sha256').update(bytes).digest('hex'),
    assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const loading = getDocument({
    data: bytes,
    fontExtraProperties: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
    standardFontDataUrl: join(assets, 'standard_fonts') + '/'
  })
  try {
    const pdf = await loading.promise,
      p = await pdf.getPage(1),
      content = await p.getTextContent(),
      operators = await p.getOperatorList(),
      viewport = p.getViewport({ scale: 1 }),
      canvas = createCanvas(900, 1200)
    const render = p.render({
      canvas: canvas as never,
      canvasContext: canvas.getContext('2d') as never,
      viewport: p.getViewport({ scale: 1.5 }),
      recordOperations: true
    })
    recordPaintedOperationBounds(render)
    await render.promise
    const graphics = collectGraphicsBounds(render, p.recordedBBoxes),
      snapshot = captureNativeFigureRenderContext(
        render,
        1,
        content,
        viewport,
        graphics.graphicsBounds,
        sha,
        p.commonObjs
      ),
      bound = matchNativeFigureRenderContext(
        snapshot,
        1,
        content,
        viewport,
        graphics.graphicsBounds,
        sha
      )
    const page = {
        pageNumber: 1,
        width: 600,
        height: 800,
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
        nativeGlyphContext: { ...bound, pageNumber: 1, sourceSha256: sha }
      }
    await inspect({ page, context, p })
  } finally {
    await loading.destroy()
  }
}

it('owns both complete framed native bodies and validates their actual PNG crops', async () => {
  await withFixture('', async ({ page, context, p }) => {
    const candidates = findNativeAlgorithmCandidates(page, context)
    expect(candidates).toHaveLength(2)
    for (const [index, c] of candidates.entries()) {
      expect(c.nativeBody.kind).toBe('algorithm')
      const first = index ? 330 : 110,
        last = index ? 485 : 285
      const expected = context.content.items
        .filter((r) => r.str?.trim() && 800 - r.transform[5] > first && 800 - r.transform[5] < last)
        .map((r) => r.sourceItem)
      expect(c.nativeBody.sourceItems).toEqual(expected)
      const png = await renderPdfCrop(p, c.rect, p.rotate, [c.rect])
      expect(acceptsNativeScopedAlgorithmPng(page, c, png)).toBe(true)
    }
  })
})
it.each([
  'closing',
  'indent',
  'missing-frame',
  'foreign-paint',
  'white-body',
  'white-rail',
  'source-text'
])('rejects an incomplete first frame: %s', async (fault) => {
  await withFixture(fault, async ({ page, context }) => {
    if (fault === 'source-text')
      context.content.items.find((r) => r.str === 'Store item').sourceItem.text += ' altered'
    expect(
      findNativeAlgorithmCandidates(page, context).some((c) =>
        c.caption.lines[0].startsWith('Algorithm 1:')
      )
    ).toBe(false)
  })
})
