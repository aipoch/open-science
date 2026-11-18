import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import * as fontkit from 'fontkit'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument, PDFName } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectGraphicsBounds } from '../resources/literature-pdf-graphics.mjs'
import {
  associateFigures,
  recoverNativePeerFigureBarrier
} from '../resources/literature-pdf-association.mjs'
import {
  findCaptionCandidates,
  projectPdfTextLines
} from '../resources/literature-pdf-caption-group.mjs'
import { nativeFigureLabelBounds } from '../resources/literature-pdf-figure-crop-geometry.mjs'
import { tableTextToken } from '../resources/literature-pdf-orientation.mjs'
import {
  recordPaintedOperationBounds,
  captureNativeFigureRenderContext,
  matchNativeFigureRenderContext
} from '../resources/literature-pdf-render-bounds.mjs'

type Fixture = ReturnType<typeof JSON.parse>

// Two invented diagrams with staggered, unequal-width captions. A physical
// cross-diagram path must keep the ordinary ambiguity guard active.
async function diagrams(crossing = false, peerCaption = true): Promise<Fixture> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    font = await pdf.embedFont(
      await readFile(join(assets, 'standard_fonts/LiberationSans-Regular.ttf')),
      { subset: false }
    ),
    page = pdf.addPage([600, 500])
  for (const x of [75, 145, 215]) {
    page.drawRectangle({ x, y: 500 - 145, width: 35, height: 50, borderWidth: 0.15 })
    page.drawLine({ start: { x, y: 500 - 125 }, end: { x: x + 35, y: 500 - 125 }, thickness: 0.15 })
    page.drawLine({
      start: { x: x + 35, y: 500 - 125 },
      end: { x: x + 30, y: 500 - 120 },
      thickness: 0.15
    })
  }
  page.drawLine({ start: { x: 110, y: 375 }, end: { x: 215, y: 375 }, thickness: 0.15 })
  for (const x of [330, 420, 510]) {
    page.drawCircle({ x, y: 500 - 80, size: 12, borderWidth: 0.15 })
    if (x < 510)
      page.drawLine({
        start: { x: x + 12, y: 500 - 80 },
        end: { x: x + 78, y: 500 - 80 },
        thickness: 0.15
      })
  }
  if (crossing)
    page.drawLine({
      start: { x: 190, y: 500 - 125 },
      end: { x: 330, y: 500 - 80 },
      thickness: 0.15
    })
  page.node.setFontDictionary(PDFName.of('F'), font.ref)
  const text = (value: string, x: number, y: number): string =>
    `BT /F 8 Tf 1 0 0 1 ${x} ${500 - y} Tm ${font.encodeText(value)} Tj ET`
  page.node.addContentStream(
    pdf.context.register(
      pdf.context.flateStream(
        [
          ...(peerCaption ? [text('Fig. 1. Receiver.', 50, 175)] : []),
          text('Fig. 2. Connected variable and factor nodes.', 310, 110)
        ].join('\n')
      )
    )
  )
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
      canvas = createCanvas(600, 500),
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
      sha = createHash('sha256').update(data).digest('hex'),
      snapshot = captureNativeFigureRenderContext(
        task,
        1,
        raw,
        viewport,
        graphics.graphicsBounds,
        sha,
        native.commonObjs
      ),
      context = matchNativeFigureRenderContext(
        snapshot,
        1,
        raw,
        viewport,
        graphics.graphicsBounds,
        sha
      )
    expect(context).toBeDefined()
    context.pageNumber = 1
    context.sourceSha256 = sha
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
      geometry = {
        pageNumber: 1,
        width: 600,
        height: 500,
        rotation: 0,
        ...graphics,
        lines: projectPdfTextLines(context.content, viewport)
      },
      captions = findCaptionCandidates([geometry])
    return {
      page: geometry,
      captions,
      tokens,
      context,
      close: async () => {
        canvas.width = canvas.height = 0
        await loading.destroy()
      }
    }
  } catch (error) {
    await loading.destroy()
    throw error
  }
}

const associate = (f: Fixture, native = true, tables: number[][] = []): Fixture[] =>
  associateFigures(f.page, f.captions, tables, [], [], f.tokens, native ? f.context : undefined)

function candidates(f: Fixture): Fixture[] {
  return f.captions.map((caption: Fixture) =>
    caption.lines[0].startsWith('Fig. 1.')
      ? { caption, rect: [70, 90, 255, 150], graphicsCount: 10 }
      : { caption, reason: 'ambiguous-graphic-direction' }
  )
}
const recover = (f: Fixture, found = candidates(f), tables: number[][] = []): Fixture[] =>
  recoverNativePeerFigureBarrier(f.page, f.captions, found, tables, [], [], f.tokens, f.context)

it('uses complete native peer paths as a negative barrier and preserves the peer', async () => {
  const f = await diagrams()
  try {
    const found = candidates(f),
      result = recover(f, found)
    expect(result[0].reason).toBeUndefined()
    expect(result[0].rect[0]).toBeGreaterThan(300)
    expect(result[0].rect[2]).toBeGreaterThan(520)
    expect(result[1]).toBe(found[1])
  } finally {
    await f.close()
  }
})

it('retains ambiguity when a native path crosses peer ownership', async () => {
  const f = await diagrams(true)
  try {
    const found = candidates(f)
    expect(recover(f, found)).toEqual(found)
  } finally {
    await f.close()
  }
})

it('does not infer a peer or page column without its caption', async () => {
  const f = await diagrams(false, false)
  try {
    const found = candidates(f)
    expect(recover(f, found)).toEqual(found)
  } finally {
    await f.close()
  }
})

it('keeps competing tables and incomplete peer paths as barriers', async () => {
  const f = await diagrams()
  try {
    const found = candidates(f)
    expect(recover(f, found, [[70, 90, 255, 150]])).toEqual(found)
    const clipped = candidates(f)
    clipped[1].rect[2] = 220
    expect(recover(f, clipped)).toEqual(clipped)
  } finally {
    await f.close()
  }
})

it('keeps normal association unchanged without matching native paint', async () => {
  const f = await diagrams()
  try {
    const found = candidates(f)
    // An incomplete native font inventory cannot certify page ownership.
    f.context.glyphBounds = []
    expect(recover(f, found)).toEqual(found)
    expect(associate(f)).toEqual(associate(f, false))
  } finally {
    await f.close()
  }
})
