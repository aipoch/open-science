import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import * as fontkit from 'fontkit'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument, drawObject } from 'pdf-lib'
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
  nativeCaptionedFormPixelCrop,
  nativeCaptionedFormPixelPngSafe,
  nativeCaptionedFormScope
} from '../resources/literature-pdf-figure-native-captioned-form.mjs'

type Fixture = ReturnType<typeof JSON.parse>

// Invented drawing: a gradient and labels share a renderer-clipped Form.
// The old strip misses its upper label and right edge; prose stays outside.
async function shadedDrawing(foreign = false, nested = false): Promise<Fixture> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    page = pdf.addPage([400, 300]),
    font = await pdf.embedFont(
      await readFile(join(assets, 'standard_fonts/LiberationSans-Regular.ttf')),
      { subset: false }
    ),
    shading = pdf.context.register(
      pdf.context.obj({
        ShadingType: 2,
        ColorSpace: 'DeviceRGB',
        Coords: [40, 120, 240, 260],
        Function: { FunctionType: 2, Domain: [0, 1], C0: [0.8, 0.9, 1], C1: [0.2, 0.5, 0.8], N: 1 },
        Extend: [true, true]
      })
    ),
    drawing = pdf.context.register(
      pdf.context.flateStream(
        `/Gradient sh\n0 0 0 rg\nBT /F 10 Tf 1 0 0 1 60 244 Tm ${font.encodeText('UpperBranch')} Tj ET\nBT /F 10 Tf 1 0 0 1 195 135 Tm ${font.encodeText('Output')} Tj ET`,
        {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [40, 120, 240, 260],
          Resources: { Font: { F: font.ref }, Shading: { Gradient: shading } },
          ...(nested ? { Group: { S: 'Transparency', I: false, K: false } } : {})
        }
      )
    )
  const form = nested
    ? pdf.context.register(
        pdf.context.flateStream('/Alpha gs /Inner Do', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [40, 120, 240, 260],
          Group: { S: 'Transparency', I: false, K: false },
          Resources: { XObject: { Inner: drawing }, ExtGState: { Alpha: { ca: 0.3, CA: 0.5 } } }
        })
      )
    : drawing
  page.pushOperators(drawObject(page.node.newXObject('Drawing', form)))
  const captionText = 'Figure1:BranchComparison.'
  page.drawText(captionText, { x: 40, y: 98, size: 10, font })
  page.drawText('IndependentParagraph.', { x: foreign ? 200 : 270, y: 210, size: 10, font })
  const data = await pdf.save(),
    loading = getDocument({
      data: data.slice(),
      useSystemFonts: false,
      fontExtraProperties: true,
      standardFontDataUrl: join(assets, 'standard_fonts') + '/',
      isEvalSupported: false
    })
  try {
    const document = await loading.promise,
      native = await document.getPage(1),
      viewport = native.getViewport({ scale: 1 }),
      canvas = createCanvas(400, 300),
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
      page: { pageNumber: 1, width: 400, height: 300, rotation: 0, ...graphics },
      figure: { rect: [40, 80, 210, 180], caption },
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
  nativeCaptionedFormPixelCrop(f.page, f.figure, f.captions, f.tables, f.tokens, f.context)

it('restores the complete shaded original Form instead of extending a strip toward the caption', async () => {
  const f = await shadedDrawing()
  expect(f.context.operators.fnArray).toContain(OPS.shadingFill)
  expect(crop(f)?.rect).toEqual([39.5, 39.5, 240.5, 180.5])
  expect(crop(f).rect[3]).toBeLessThan(f.figure.caption.rect[1])
})

it('declines a complete Form whose domain overlaps independent prose', async () => {
  expect(crop(await shadedDrawing(true))).toBeUndefined()
})

it.each(['outside-form', 'malformed-pattern', 'table'])(
  'keeps shaded crop ownership closed: %s',
  async (change) => {
    const f = await shadedDrawing(),
      o = f.context.operators,
      shading = o.fnArray.indexOf(OPS.shadingFill)
    if (change === 'outside-form')
      o.fnArray[o.fnArray.indexOf(OPS.paintFormXObjectBegin)] = OPS.save
    if (change === 'malformed-pattern') o.argsArray[shading] = [null]
    if (change === 'table') f.tables.push([100, 100, 150, 150])
    expect(crop(f)).toBeUndefined()
  }
)

it('retains the complete original pixels of nested non-isolated transparency groups', async () => {
  const f = await shadedDrawing(false, true),
    o = f.context.operators
  expect(o.fnArray.filter((op: number) => op === OPS.beginGroup)).toHaveLength(2)
  expect(o.argsArray[o.fnArray.indexOf(OPS.beginGroup)][0].isolated).toBe(false)
  expect(crop(f)?.rect).toEqual([38, 38, 242, 182])
  expect(
    nativeCaptionedFormScope(f.page, f.figure, f.captions, [], f.tokens, f.context)
  ).toBeUndefined()
  const plan = crop(f),
    png = createCanvas(816, 576).toBuffer('image/png')
  expect(nativeCaptionedFormPixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  expect(
    nativeCaptionedFormPixelPngSafe(
      plan,
      createCanvas(204, 144).toBuffer('image/png'),
      plan.rect,
      f.page
    )
  ).toBe(false)
  expect(nativeCaptionedFormPixelPngSafe(plan, png, [38, 38, 243, 182], f.page)).toBe(false)
  // Internal writing direction supplies no independent glyph/source authority.
  f.context.content.items[0].dir = 'ttb'
  expect(crop(f)?.rect).toEqual([38, 38, 242, 182])
  expect(nativeCaptionedFormPixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
})

it.each([
  'unclosed',
  'matrix',
  'smask',
  'knockout',
  'outside-paint',
  'foreign-prose',
  'invalid-direction'
])('declines unsafe nested original-pixel ownership: %s', async (change) => {
  const f = await shadedDrawing(change === 'foreign-prose', true),
    o = f.context.operators,
    group = o.fnArray.indexOf(OPS.beginGroup)
  if (change === 'unclosed') o.fnArray[o.fnArray.lastIndexOf(OPS.endGroup)] = OPS.restore
  if (change === 'matrix') o.argsArray[group][0].matrix = [1, 0, 0, 1, 10, 0]
  if (change === 'smask') o.argsArray[group][0].smask = {}
  if (change === 'knockout') o.argsArray[group][0].knockout = true
  if (change === 'invalid-direction') f.context.content.items[0].dir = 'unknown'
  if (change === 'outside-paint') {
    o.fnArray.push(OPS.shadingFill)
    o.argsArray.push(['foreign-gradient'])
  }
  expect(crop(f)).toBeUndefined()
})
