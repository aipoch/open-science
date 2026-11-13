import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import * as fontkit from 'fontkit'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument, PDFName } from 'pdf-lib'
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

// Generated with the redistributable Liberation font bundled by PDF.js.
async function vectorPair(foreign = ''): Promise<Fixture> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    page = pdf.addPage([440, 320]),
    font = await pdf.embedFont(
      await readFile(join(assets, 'standard_fonts/LiberationSans-Regular.ttf')),
      { subset: false }
    ),
    text = (s: string, x: number, y: number): string =>
      `BT /F 10 Tf 1 0 0 1 ${x} ${320 - y} Tm ${font.encodeText(s)} Tj ET`,
    drawing = (x: number): string => `q 0 0 0 RG 1 w ${x} 175 m ${x + 110} 175 l ${x + 40} 250 l h S
${text('x', x + 100, 135)}
${text('y', x + 40, 90)}
Q`,
    captionText = 'Figure 1: Comparison of two measurement errors.',
    obstacle =
      foreign === 'glyph'
        ? text('Independent legend', 360, 185)
        : foreign === 'fill'
          ? '365 130 10 10 re f'
          : '',
    stream = `${drawing(55)}
${text('(a) General error', 60, 185)}
${drawing(235)}
${text('(b) Symmetric measured error', 235, 185)}
${obstacle}
${text(captionText, 50, 220)}`
  page.node.set(PDFName.of('Resources'), pdf.context.obj({ Font: { F: font.ref } }))
  page.node.addContentStream(pdf.context.register(pdf.context.flateStream(stream)))
  const data = await pdf.save(),
    loading = getDocument({
      data: data.slice(),
      useSystemFonts: false,

      standardFontDataUrl: join(assets, 'standard_fonts') + '/',
      isEvalSupported: false
    })
  try {
    const document = await loading.promise,
      native = await document.getPage(1),
      viewport = native.getViewport({ scale: 1 }),
      canvas = createCanvas(440, 320),
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
        1,
        raw,
        viewport,
        graphics.graphicsBounds,
        sourceSha256,
        native.commonObjs
      ),
      context = matchNativeFigureRenderContext(
        snapshot,
        1,
        raw,
        viewport,
        graphics.graphicsBounds,
        sourceSha256
      )
    expect(context).toBeDefined()
    context.pageNumber = 1
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
        page: 1,
        lines: [captionText],
        rect: tokens.find((t: Fixture) => t.text === captionText).rect.slice()
      }
    canvas.width = canvas.height = 0
    return {
      page: { pageNumber: 1, width: 440, height: 320, rotation: 0, ...graphics },
      figure: { rect: [45, 60, 357, 180], caption },
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

it('completes both native vector subcaptions beyond the old horizontal and bottom bounds', async () => {
  const f = await vectorPair(),
    plan = crop(f)
  expect(plan).toBeDefined()
  expect(plan.rect[2]).toBeGreaterThan(f.figure.rect[2])
  expect(plan.rect[3]).toBeGreaterThan(f.figure.rect[3])
  expect(plan.sourceItems).toBeUndefined()
})

it.each(['glyph', 'fill'])('declines a foreign %s in the recovered strip', async (mode) => {
  expect(crop(await vectorPair(mode))).toBeUndefined()
})

it('binds the completed crop to current native input and proof identity', async () => {
  const f = await vectorPair(),
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
  expect(nativeCompleteFormCropPngSafe(png, rect, { ...f.page }, published)).toBe(false)
  expect(nativeCompleteFormCropPngSafe(png, rect, f.page, structuredClone(plan))).toBe(false)
  expect(
    nativeCompleteFormCropPngSafe(createCanvas(2, 2).toBuffer('image/png'), rect, f.page, plan)
  ).toBe(false)
  f.context.content.items.find((r: Fixture) => r.str.startsWith('(b)')).str += ' changed'
  expect(nativeCompleteFormCropPngSafe(png, rect, f.page, plan)).toBe(false)
})

it.each(['literal', 'font', 'width', 'operator', 'caption', 'unclosed', 'clip'])(
  'declines changed %s membership',
  async (mode) => {
    const f = await vectorPair(),
      key = f.context.content.items.find((r: Fixture) => r.str.startsWith('(b)'))
    if (mode === 'literal') key.str = key.str.replace('Symmetric', 'Sym metric')
    if (mode === 'font') key.fontName = 'Unknown'
    if (mode === 'width') key.width += 3
    if (mode === 'operator') f.context.operators.fnArray.splice(2, 0, OPS.setCharSpacing)
    if (mode === 'unclosed')
      f.context.operators.fnArray.splice(f.context.operators.fnArray.indexOf(OPS.restore), 1)
    if (mode === 'clip')
      f.context.operators.fnArray[f.context.operators.fnArray.indexOf(OPS.restore)] = OPS.clip
    if (mode === 'caption') f.figure.caption.lines = ['Figure 2: Independent observation.']
    expect(crop(f)).toBeUndefined()
  }
)
