import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import * as fontkit from 'fontkit'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument } from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectGraphicsBounds } from '../resources/literature-pdf-graphics.mjs'
import {
  recordPaintedOperationBounds,
  captureNativeFigureRenderContext,
  matchNativeFigureRenderContext
} from '../resources/literature-pdf-render-bounds.mjs'
import { tableTextToken } from '../resources/literature-pdf-orientation.mjs'
import { nativeFigureLabelBounds } from '../resources/literature-pdf-figure-crop-geometry.mjs'
import {
  nativeCompleteFormCrop,
  nativeCompleteFormCropPngSafe
} from '../resources/literature-pdf-figure-native-complete-form.mjs'

type Fixture = ReturnType<typeof JSON.parse>

// Native PDF generated solely from bundled Liberation and invented panel pixels.
async function rasterPanels(columns = 2, foreign = '', consumer = false): Promise<Fixture> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  if (consumer) {
    pdf.addPage([600, 320])
    pdf.addPage([600, 320])
  }
  const pageNumber = consumer ? 3 : 1
  const assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    width = columns === 2 ? 440 : 600,
    page = pdf.addPage([width, 320]),
    font = await pdf.embedFont(
      await readFile(join(assets, 'standard_fonts/LiberationSans-Regular.ttf')),
      { subset: false }
    ),
    canvas = createCanvas(32, 24),
    ctx = canvas.getContext('2d')
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 32, 24)
  ctx.fillStyle = 'blue'
  ctx.fillRect(2, 2, 28, 20)
  const picture = (image: Fixture, x: number, y: number, w: number, h: number): void => {
    const key = page.node.newXObject('Panel', image.ref)
    page.node.addContentStream(
      pdf.context.register(pdf.context.flateStream(`q ${w} 0 0 ${h} ${x} ${y} cm ${key} Do Q`))
    )
  }
  const image = await pdf.embedPng(canvas.toBuffer('image/png')),
    fontKey = page.node.newFontDictionary('PanelFont', font.ref),
    text = (value: string, x: number, y: number): void => {
      const lines = value
        .split('\n')
        .map((line, i) => `1 0 0 1 ${x} ${y - i * 12} Tm ${font.encodeText(line)} Tj`)
        .join('\n')
      page.node.addContentStream(
        pdf.context.register(pdf.context.flateStream(`0 0 0 rg BT ${fontKey} 10 Tf\n${lines}\nET`))
      )
    }
  if (consumer) text('3', width - 20, 305)
  if (foreign === 'early-glyph') text('Independent legend', 240, 320 - 245)
  if (foreign === 'early-fill')
    page.node.addContentStream(pdf.context.register(pdf.context.flateStream('240 75 10 4 re f')))
  for (let n = 0; n < 4; n++) {
    const x = columns === 2 ? 55 + (n % 2) * 140 : 30 + n * 120,
      top = columns === 2 ? 60 + Math.floor(n / 2) * 100 : 80,
      caption = '(' + String.fromCharCode(97 + n) + ') Proposed model'
    ctx.fillStyle = ['red', 'green', 'blue', 'purple'][n]
    ctx.fillRect(4, 4, 4, 4)
    const panel = await pdf.embedPng(canvas.toBuffer('image/png'))
    picture(panel, x, 320 - top - 60, 100, 60)
    text(caption + (columns === 2 ? '\nsecond variant' : ''), x, 320 - top - 73)
  }
  if (foreign === 'glyph') text('Independent legend', 240, 320 - 245)
  if (foreign === 'image') picture(image, 360, 320 - 210, 20, 20)
  if (foreign === 'fill') page.drawRectangle({ x: 290, y: 320 - 245, width: 20, height: 4 })
  const captionText = 'Figure 1: Comparison of four independent measurement panels.'
  text(captionText, 40, 320 - 275)
  const data = await pdf.save(),
    loading = getDocument({
      data: data.slice(),
      useSystemFonts: false,

      standardFontDataUrl: join(assets, 'standard_fonts') + '/',
      isEvalSupported: false
    })
  try {
    const document = await loading.promise,
      native = await document.getPage(pageNumber),
      viewport = native.getViewport({ scale: 1 }),
      canvas = createCanvas(width, 320),
      task = native.render({
        canvas,
        canvasContext: canvas.getContext('2d'),
        viewport,
        recordOperations: true
      })
    recordPaintedOperationBounds(task)
    await task.promise
    const raw = await native.getTextContent(),
      graphics = collectGraphicsBounds(task, native.recordedBBoxes),
      sourceSha256 = createHash('sha256').update(data).digest('hex'),
      snapshot = captureNativeFigureRenderContext(
        task,
        pageNumber,
        raw,
        viewport,
        graphics.graphicsBounds,
        sourceSha256,
        native.commonObjs
      ),
      context = matchNativeFigureRenderContext(
        snapshot,
        pageNumber,
        raw,
        viewport,
        graphics.graphicsBounds,
        sourceSha256
      )
    expect(context).toBeDefined()
    context.pageNumber = pageNumber
    context.sourceSha256 = sourceSha256
    const tokens = context.content.items.flatMap((item: Fixture) =>
        item.str?.trim()
          ? [
              {
                ...tableTextToken(item, viewport, 0),
                fontAscent: context.content.styles[item.fontName].ascent,
                fontDescent: context.content.styles[item.fontName].descent,
                nativeLabelRect: nativeFigureLabelBounds(
                  item,
                  context.content.styles[item.fontName],
                  viewport
                )
              }
            ]
          : []
      ),
      caption = {
        page: pageNumber,
        lines: [captionText],
        rect: tokens.find((t: Fixture) => t.text === captionText).rect.slice()
      }
    if (consumer) {
      const witness = await document.getPage(1)
      context.runningHeadWitness = {
        sourceSha256,
        currentPageNumber: pageNumber,
        witnessPageNumber: 1,
        currentContent: context.content,
        witnessContent: await witness.getTextContent(),
        witnessViewport: witness.getViewport({ scale: 1 })
      }
    }
    canvas.width = canvas.height = 0
    return {
      page: { pageNumber, width, height: 320, rotation: 0, ...graphics },
      figure: { rect: columns === 2 ? [52, 58, 308, 236] : [145, 75, 385, 200], caption },
      captions: [caption],
      tables: [],
      tokens,
      context
    }
  } finally {
    await loading.destroy()
  }
}

const crop = (f: Fixture): Fixture =>
  nativeCompleteFormCrop(f.page, f.figure, f.captions, f.tables, f.tokens, f.context)
it.each([2, 4])(
  'completes all four native panel captions in a %s column cohort',
  async (columns) => {
    const f = await rasterPanels(columns),
      old = structuredClone(f.figure),
      plan = crop(f)
    expect(plan?.formCropRaster.rasterSubcaptions).toBeDefined()
    expect(plan.rect[0]).toBeLessThanOrEqual(columns === 2 ? 55 : 30)
    expect(plan.rect[2]).toBeGreaterThanOrEqual(columns === 2 ? 295 : 490)
    if (columns === 2) expect(plan.rect[3]).toBeGreaterThan(245)
    expect(plan.sourceItems).toBeUndefined()
    expect(f.figure).toEqual(old)
  }
)
it.each(['glyph', 'image', 'fill', 'early-glyph', 'early-fill'])(
  'rejects independent %s in the proposed caption cohort',
  async (foreign) => {
    expect(crop(await rasterPanels(2, foreign))).toBeUndefined()
  }
)
it.each(['marker', 'caption', 'width', 'literal', 'font'])(
  'rejects changed native %s membership',
  async (fault) => {
    const f = await rasterPanels(),
      raw = f.context.content.items.find((r: Fixture) => r.str.startsWith('(d)'))
    if (fault === 'marker') raw.str = raw.str.replace('(d)', '(b)')
    if (fault === 'literal') raw.str = raw.str.replace('Proposed', 'Pro posed')
    if (fault === 'font') raw.fontName = 'Unknown'
    if (fault === 'width') raw.width += 4
    if (fault === 'caption') f.figure.caption.lines = ['Figure 9: Separate panels.']
    expect(crop(f)).toBeUndefined()
  }
)
it('rejects cloned and stale pixel proofs while preserving all complete owned paint', async () => {
  const f = await rasterPanels(),
    plan = crop(f),
    rect = plan.rect.map((n: number, i: number) => n + (i < 2 ? -2 : 2)),
    png = createCanvas(
      Math.ceil((rect[2] - rect[0]) * 2),
      Math.ceil((rect[3] - rect[1]) * 2)
    ).toBuffer('image/png')
  expect(nativeCompleteFormCropPngSafe(png, rect, f.page, plan)).toBe(true)
  const published = {
    ...plan,
    formCropRaster: {
      ...plan.formCropRaster,
      foreignPaints: [...plan.formCropRaster.foreignPaints, { rect: [0, 0, 1, 1], floor: 0 }]
    }
  }
  expect(nativeCompleteFormCropPngSafe(png, rect, f.page, published)).toBe(true)
  const missing = {
    ...published,
    formCropRaster: { ...published.formCropRaster, foreignPaints: [] }
  }
  expect(nativeCompleteFormCropPngSafe(png, rect, f.page, missing)).toBe(false)
  expect(nativeCompleteFormCropPngSafe(png, rect, f.page, structuredClone(plan))).toBe(false)
  f.context.operators.fnArray[0] = OPS.setWordSpacing
  expect(nativeCompleteFormCropPngSafe(png, rect, f.page, plan)).toBe(false)
})

// Matches the actual extractor's folio-conditioned secondary native viewport.
it('publishes a complete cohort with the actual running-head consumer shape', async () => {
  const f = await rasterPanels(4, '', true)
  expect(
    f.context.content.items
      .filter((r: Fixture) => r.str?.trim())
      .slice(0, 6)
      .some((r: Fixture) => r.str === '3')
  ).toBe(true)
  const plan = crop(f)
  expect(plan).toBeDefined()
  const rect = plan.rect.map((n: number, i: number) => n + (i < 2 ? -2 : 2)),
    png = createCanvas(
      Math.ceil((rect[2] - rect[0]) * 2),
      Math.ceil((rect[3] - rect[1]) * 2)
    ).toBuffer('image/png'),
    published = {
      ...plan,
      formCropRaster: {
        ...plan.formCropRaster,
        foreignPaints: [...plan.formCropRaster.foreignPaints]
      }
    }
  expect(nativeCompleteFormCropPngSafe(png, rect, f.page, published)).toBe(true)
  f.context.runningHeadWitness.witnessViewport.width++
  expect(nativeCompleteFormCropPngSafe(png, rect, f.page, published)).toBe(false)
})
it.each(['accessor', 'unknown viewport'])(
  'declines malformed running-head metadata: %s',
  async (mode) => {
    const f = await rasterPanels(4, '', true)
    if (mode === 'accessor')
      Object.defineProperty(f.context.runningHeadWitness, 'witnessViewport', {
        get() {
          throw Error('must not execute')
        }
      })
    else f.context.runningHeadWitness.witnessViewport = new Date()
    expect(crop(f)).toBeUndefined()
  }
)
