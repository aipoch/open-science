import { beforeAll, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import * as fontkit from 'fontkit'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument, drawObject, pushGraphicsState, popGraphicsState } from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectGraphicsBounds } from '../resources/literature-pdf-graphics.mjs'
import {
  recordPaintedOperationBounds,
  captureNativeFigureRenderContext,
  matchNativeFigureRenderContext
} from '../resources/literature-pdf-render-bounds.mjs'
import { tableTextToken } from '../resources/literature-pdf-orientation.mjs'
import { nativeFigureLabelBounds } from '../resources/literature-pdf-figure-crop-geometry.mjs'
import { nativeOwnedRasterColumnHeadings } from '../resources/literature-pdf-native-owned-figure-labels.mjs'

type Fixture = ReturnType<typeof JSON.parse>
let base: Fixture

// An invented comparison plate, rendered through the real PDF.js operations,
// font metrics, image hashes and clipping context. No external document data.
async function nativePlate(columns = 5): Promise<Fixture> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    page = pdf.addPage([600, 500]),
    font = await pdf.embedFont(
      await readFile(join(assets, 'standard_fonts/LiberationSans-Regular.ttf')),
      { subset: false }
    ),
    images: Record<string, unknown> = {},
    content: string[] = [],
    titles = Array.from({ length: columns }, (_, i) => (i ? (i % 2 ? 'Near' : 'Far') : 'Seed'))
  const text = (s: string, x: number, baseline: number): void => {
    content.push(`BT /F 8 Tf 1 0 0 1 ${x} ${500 - baseline} Tm ${font.encodeText(s)} Tj ET`)
  }
  for (const [i, title] of titles.entries())
    text(title, 50 + i * 72 + 32 - font.widthOfTextAtSize(title, 8) / 2, 80)
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < columns; column++) {
      const canvas = createCanvas(8, 8),
        context = canvas.getContext('2d')
      context.fillStyle = `rgb(${40 + row * 50},${60 + column * 20},${80 + row * 10 + column})`
      context.fillRect(0, 0, 8, 8)
      const image = await pdf.embedPng(canvas.toBuffer('image/png')),
        key = `Panel${row * columns + column}`
      images[key] = image.ref
      const h = column % 2 ? 64 : 70,
        top = 90 + row * 80 + (70 - h) / 2
      content.push(`q 64 0 0 ${h} ${50 + column * 72} ${500 - top - h} cm /${key} Do Q`)
      canvas.width = canvas.height = 0
    }
  text('Input', 65, 331)
  text('Output', 300, 331)
  const form = pdf.context.register(
      pdf.context.flateStream(content.join('\n'), {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 600, 500],
        Group: { S: 'Transparency', I: false, K: false },
        Resources: { Font: { F: font.ref }, XObject: images }
      })
    ),
    name = page.node.newXObject('Plate', form)
  page.pushOperators(pushGraphicsState(), drawObject(name), popGraphicsState())
  const captionText = 'Figure1:Comparison.',
    captionTop = 337
  page.drawText(captionText, { x: 50, y: 500 - captionTop - 8, size: 8, font })
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
    expect(
      matchNativeFigureRenderContext(
        snapshot,
        1,
        raw,
        viewport,
        graphics.graphicsBounds,
        createHash('sha256').update('different source').digest('hex')
      )
    ).toBeUndefined()
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
      },
      result = {
        page: { pageNumber: 1, width: 600, height: 500, rotation: 0, ...graphics },
        figure: {
          reason: 'native-raster-composite-grid',
          rect: [48, 85, 50 + columns * 72 - 6, 327],
          caption
        },
        captions: [caption],
        tables: [],
        tokens,
        context
      }
    canvas.width = canvas.height = 0
    return result
  } finally {
    await loading.destroy()
  }
}

beforeAll(async () => {
  base = await nativePlate()
})
function fixture(): Fixture {
  const context = { ...base.context, viewport: undefined },
    copy = structuredClone({ ...base, context })
  copy.context.viewport = { ...base.context.viewport }
  return copy
}
const invoke = (f: Fixture): Fixture =>
  nativeOwnedRasterColumnHeadings(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    () => false,
    f.context
  )

it('retains one complete repeated native title row and keeps lower labels independent', () => {
  const f = fixture(),
    before = JSON.stringify(f),
    found = invoke(f)
  expect(found?.sourceItems).toHaveLength(5)
  expect(found.rects.filter((r: number[]) => r[1] < f.figure.rect[1])).toHaveLength(5)
  expect(found.rects.filter((r: number[]) => r[3] > f.figure.rect[3])).toHaveLength(2)
  expect(found.sourceItems.map((s: Fixture) => s.text)).toEqual([
    'Seed',
    'Near',
    'Far',
    'Near',
    'Far'
  ])
  expect(found.sourceItems.some((s: Fixture) => ['Input', 'Output'].includes(s.text))).toBe(false)
  expect(JSON.stringify(f)).toBe(before)
})

it.each(['left', 'right'])(
  'closes the whole native raster side without fixed padding: %s',
  (side) => {
    const f = fixture()
    f.figure.rect[side === 'left' ? 0 : 2] += side === 'left' ? 8 : -8
    const found = invoke(f),
      crop = [
        Math.min(f.figure.rect[0], ...found.rects.map((r: number[]) => r[0])),
        Math.max(f.figure.rect[2], ...found.rects.map((r: number[]) => r[2]))
      ]
    expect(crop[side === 'left' ? 0 : 1]).toBe(side === 'left' ? 50 : 402)
    expect(found.sourceItems).toHaveLength(5)
    // A foreign outline can enter this added side even when its advance does not.
    const shown =
        f.context.operators.argsArray[
          f.context.operators.fnArray.findLastIndex((op: number) => op === OPS.showText)
        ][0],
      glyph = shown.find((g: Fixture) => g.unicode === '1')
    f.context.glyphBounds[0].glyphs.find((g: Fixture) => g.fontChar === glyph.fontChar).bounds = [
      -100, 0, 100, 100
    ]
    expect(invoke(f)).toBeUndefined()
  }
)

it.each([
  'missing-image',
  'duplicate-image',
  'missing-hash',
  'misaligned-panel',
  'wrong-source',
  'source-alias',
  'foreign-font',
  'changed-metric',
  'partial-item',
  'other-caption',
  'table',
  'prose',
  'broken-pair',
  'unknown-group',
  'masked-group',
  'knockout',
  'changed-program',
  'changed-font',
  'opacity',
  'malformed-state',
  'outside-group',
  'unclosed-form',
  'bad-clip',
  'changed-text-matrix',
  'changed-advance',
  'foreign-ink',
  'header-overhang',
  'missing-footer',
  'footer-caption-overlap'
])('declines a partial, foreign or unbound native row: %s', (change) => {
  const f = fixture(),
    o = f.context.operators,
    images = f.page.graphicsBounds.filter((g: Fixture) => g.kind === 'image'),
    group = o.fnArray.indexOf(OPS.beginGroup),
    firstText = o.fnArray.indexOf(OPS.showText)
  if (change === 'missing-image') f.page.graphicsBounds.pop()
  if (change === 'duplicate-image') images[1].operationIndex = images[0].operationIndex
  if (change === 'missing-hash') delete images[0].imageHash
  if (change === 'misaligned-panel') {
    const at = images.at(-1).operationIndex
    const transform = o.fnArray.findLastIndex(
      (op: number, i: number) => i < at && op === OPS.transform
    )
    o.argsArray[transform][4] += 25
  }
  if (change === 'wrong-source') f.tokens[0].sourceItem.index += 1
  if (change === 'source-alias') f.tokens.push({ ...f.tokens[0] })
  if (change === 'foreign-font')
    f.tokens.push({
      ...f.tokens[0],
      text: 'Other',
      sourceItem: { pageNumber: 1, index: 10000, text: 'Other' }
    })
  if (change === 'changed-metric')
    f.context.content.styles[f.context.content.items[0].fontName].ascent -= 0.1
  if (change === 'partial-item')
    f.tokens[0].sourceSegment = { ...f.tokens[0].sourceItem, start: 0, end: 2 }
  if (change === 'other-caption')
    f.captions.push({ page: 1, rect: [50, 70, 180, 84], lines: ['Figure 2: Other.'] })
  if (change === 'table') f.tables.push([50, 70, 180, 84])
  if (change === 'prose') f.tokens[0].text = 'This is ordinary running prose.'
  if (change === 'broken-pair') {
    f.tokens[3].text = 'Other'
    f.tokens[3].sourceItem.text = 'Other'
  }
  if (change === 'unknown-group') o.argsArray[group][0].matrix = [1, 0, 0, 1, 2, 0]
  if (change === 'masked-group') o.argsArray[group][0].smask = { subtype: 'Alpha' }
  if (change === 'knockout') o.argsArray[group][0].knockout = true
  if (change === 'changed-program') o.argsArray[firstText][0][0].unicode = 'Q'
  if (change === 'changed-font') o.argsArray[o.fnArray.indexOf(OPS.setFont)][1] += 1
  if (change === 'outside-group') o.argsArray[group][0].bbox[3] = 400
  if (change === 'unclosed-form')
    o.fnArray[o.fnArray.indexOf(OPS.paintFormXObjectEnd)] = OPS.dependency
  if (change === 'bad-clip') o.fnArray[firstText] = OPS.clip
  if (change === 'changed-text-matrix') o.argsArray[o.fnArray.indexOf(OPS.setTextMatrix)][4] += 0.1
  if (change === 'changed-advance') o.argsArray[firstText][0][0].width += 30
  if (change === 'foreign-ink') {
    const item = f.context.content.items.find((r: Fixture) => r.str === 'Input')
    const shown =
      o.argsArray[
        o.fnArray.findIndex(
          (op: number, i: number) =>
            op === OPS.showText &&
            o.argsArray[i][0].map((g: Fixture) => g.unicode ?? '').join('') === 'Input'
        )
      ][0][0]
    f.context.glyphBounds
      .find((font: Fixture) => font.fontName === item.fontName)
      .glyphs.find((g: Fixture) => g.fontChar === shown.fontChar).bounds[3] += 40
  }
  if (change === 'header-overhang') {
    const glyph = o.argsArray[firstText][0][0]
    f.context.glyphBounds[0].glyphs.find((g: Fixture) => g.fontChar === glyph.fontChar).bounds[3] +=
      1
  }
  if (change === 'missing-footer') {
    const item = f.context.content.items.find((r: Fixture) => r.str === 'Output')
    item.sourceItem.text = 'Other'
  }
  if (change === 'footer-caption-overlap') f.figure.caption.rect[1] = 330
  if (change === 'opacity' || change === 'malformed-state') {
    o.fnArray.splice(firstText, 0, OPS.setGState)
    o.argsArray.splice(firstText, 0, change === 'opacity' ? [[['ca', 0.5]]] : [[1]])
    for (const g of f.page.graphicsBounds) if (g.operationIndex >= firstText) g.operationIndex++
  }
  expect(invoke(f)).toBeUndefined()
})
