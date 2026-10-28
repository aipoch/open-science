import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { resolve } from './paths'

const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { retainCaptionedRuledMathTableBody: retain } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-captioned-ruled-math-body.mjs')).href
)
const { getInitialPdfCropRaster } = await import(
  pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
)
const { nativePageTextPacketInventory, nativeWholeCellInkPacket } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)

type Glyph = { unicode: string; fontChar: string; width: number; isInFont: boolean }
type Item = {
  str: string
  dir: string
  width: number
  height: number
  transform: number[]
  fontName: string
  hasEOL: boolean
  sourceItem: { pageNumber: number; index: number; text: string }
}
type Operators = { fnArray: number[]; argsArray: (unknown[] | null)[] }
type Caption = { page: number; lines: string[]; rect: number[] }
type Viewport = {
  width: number
  height: number
  scale: number
  rotation: number
  transform: number[]
  convertToViewportPoint: (x: number, y: number) => number[]
}
type Graphic = { kind: string; operationIndex: number; normalizedRect: number[] }
type Fixture = {
  table: { rect: number[]; caption: Caption }
  options: {
    page: {
      pageNumber: number
      width: number
      height: number
      rotation: number
      renderRotation: number
      invalidGraphicsBounds: number
      graphicsBounds: Graphic[]
    }
    tokens: ReturnType<typeof tableTextToken>[]
    context: {
      operators: Operators
      glyphBounds: { fontName: string; glyphs: { fontChar: string; bounds: number[] }[] }[]
      viewport: Viewport
      content: {
        items: Item[]
        styles: { F: { ascent: number; descent: number; vertical: boolean } }
      }
      graphicsBounds: Graphic[]
      pageNumber: number
      sourceSha256: string
    }
    captions: Caption[]
    competingRects: number[][]
  }
  png: Buffer
  crop: number[]
  items: Item[]
  segments: number[][]
}

// A small anonymous native page: two diagonal numeric panels and two captions.
// No real PDF, font program, page identifier or recorded packet is checked in.
export function anonymousRuledMathBody(
  prose = false,
  right = 180,
  unowned?: 'gap' | 'cross-panel'
): Fixture {
  const width = right + 20,
    height = 230,
    operators = { fnArray: [] as number[], argsArray: [] as (unknown[] | null)[] },
    items: Item[] = [],
    glyphs: { fontChar: string; bounds: number[] }[] = [],
    graphicsBounds: Graphic[] = [],
    segments: number[][] = []
  const add = (op: number, args: unknown[] | null): void => {
    operators.fnArray.push(op)
    operators.argsArray.push(args)
  }
  const text = (str: string, x: number, baseline: number, size = 8): Item => {
    add(OPS.beginText, null)
    add(OPS.setFont, ['F', size])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - baseline]])
    add(OPS.showText, [
      [...str].map((ch) => ({ unicode: ch, fontChar: ch, width: 500, isInFont: true }))
    ])
    add(OPS.endText, null)
    const item = {
      str,
      dir: 'ltr',
      width: ([...str].length * size) / 2,
      height: size,
      transform: [size, 0, 0, size, x, height - baseline],
      fontName: 'F',
      hasEOL: true,
      sourceItem: { pageNumber: 1, index: items.length, text: str }
    }
    items.push(item)
    for (const ch of str)
      if (!glyphs.some((g) => g.fontChar === ch))
        glyphs.push({ fontChar: ch, bounds: [0, -0.1, 0.5, 0.7] })
    return item
  }
  const line = (x0: number, y0: number, x1: number, y1: number): void => {
    add(OPS.constructPath, [
      OPS.stroke,
      [[0, x0, height - y0, 1, x1, height - y1]],
      [Math.min(x0, x1), height - Math.max(y0, y1), Math.max(x0, x1), height - Math.min(y0, y1)]
    ])
    graphicsBounds.push({
      kind: 'path',
      operationIndex: operators.fnArray.length - 1,
      normalizedRect: [
        (Math.min(x0, x1) - 0.3) / width,
        (Math.min(y0, y1) - 0.3) / height,
        (Math.max(x0, x1) + 0.3) / width,
        (Math.max(y0, y1) + 0.3) / height
      ]
    })
    segments.push([x0, y0, x1, y1])
  }
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.6])
  const cap = text('Table 1. Example', 20, 20)
  for (const y of [40, 52, 78, 112, 116, 128, 154, 188]) line(20, y, right, y)
  line(20, 56, 55, 76)
  line(20, 132, 55, 152)
  for (const [offset, title] of [
    [0, 'First'],
    [76, 'Second']
  ] as const) {
    text(title, 65, 49 + offset)
    text('L', 25, 72 + offset)
    text('κ', 62, 66 + offset)
    text('0', 80, 72 + offset)
    text('1', 35, 84 + offset)
    text(prose ? 'Remark' : '2', 95, 84 + offset)
    text('3', 35, 104 + offset)
    text('4', 95, 104 + offset)
  }
  if (unowned) text('Remark', 70, unowned === 'gap' ? 115.4 : 119, unowned === 'gap' ? 2 : 8)
  const next = text('Table 2. Other', 20, 210)
  const viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number) => [x, height - y]
    },
    content = { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
    tokens = items.map((i) => tableTextToken(i, viewport, 0)),
    caption = (i: Item): Caption => ({
      page: 1,
      lines: [i.str],
      rect: tableTextToken(i, viewport, 0).rect
    })
  const table = { rect: [19, 42, right + 1, 171], caption: caption(cap) },
    options = {
      page: {
        pageNumber: 1,
        width,
        height,
        rotation: 0,
        renderRotation: 0,
        invalidGraphicsBounds: 0,
        graphicsBounds
      },
      tokens,
      context: {
        operators,
        glyphBounds: [{ fontName: 'F', glyphs }],
        viewport,
        content,
        graphicsBounds,
        pageNumber: 1,
        sourceSha256: 'a'.repeat(64)
      },
      captions: [caption(cap), caption(next)],
      competingRects: [] as number[][]
    }
  const crop = [19, 39.7, right + 1, 188.3],
    canvas = createCanvas(Math.ceil((crop[2] - crop[0]) * 4), Math.ceil((crop[3] - crop[1]) * 4)),
    ctx = canvas.getContext('2d')
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.scale(4, 4)
  ctx.translate(-crop[0], -crop[1])
  ctx.strokeStyle = 'black'
  ctx.lineWidth = 0.6
  for (const [x0, y0, x1, y1] of segments) {
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
  }
  ctx.fillStyle = 'black'
  for (const i of items.slice(1, -1)) {
    const x = i.transform[4],
      baseline = height - i.transform[5]
    const size = i.height
    for (let n = 0; n < i.str.length; n++)
      ctx.fillRect(x + (n * size) / 2, baseline - size * 0.7, size / 2, size * 0.8)
  }
  const png = canvas.toBuffer('image/png')
  canvas.width = canvas.height = 1
  return { table, options, png, crop, items, segments }
}

it('retains complete numeric panels and leaves both captions separate', async () => {
  const f = anonymousRuledMathBody(),
    before = JSON.stringify(f.table),
    out = await retain(f.table, f.options, async (rect: number[]) => {
      assert.deepEqual(rect, f.crop)
      return f.png
    })
  assert(out)
  assert.deepEqual(out.table.rect, f.crop)
  assert.equal(out.table.nativeBody.kind, 'math-table')
  assert.equal(out.table.caption, f.table.caption)
  assert.equal(JSON.stringify(f.table), before)
  assert(out.table.nativeBody.sourceItems.length === f.items.length - 2)
  assert(
    out.table.nativeBody.sourceItems.every(
      (s: { index: number }) => s.index !== 0 && s.index !== f.items.length - 1
    )
  )
  assert.deepEqual(out.png, f.png)
})

it('uses actual bounded PNG protection without increasing the initial raster budget', async () => {
  const f = anonymousRuledMathBody(false, 330)
  assert.equal(getInitialPdfCropRaster(f.crop, f.options.page), undefined)
  assert(await retain(f.table, f.options, async () => f.png))
})

it('refuses ordinary translatable data even when the complete ruled shape agrees', async () => {
  const f = anonymousRuledMathBody(true)
  let calls = 0
  assert(nativePageTextPacketInventory(f.options.page, f.options.tokens, f.options.context))
  assert(
    nativeWholeCellInkPacket(f.options.page, f.options.tokens, f.options.context, {
      text: f.options.tokens.map((t) => t.text).join(''),
      sourceItems: f.options.tokens.map((t) => t.sourceItem),
      sourceRects: f.options.tokens.map((t) => t.rect)
    })
  )
  assert.equal(
    await retain(f.table, f.options, async () => {
      calls++
      return f.png
    }),
    undefined
  )
  assert.equal(calls, 0)
})

it.each(['gap', 'cross-panel'] as const)(
  'refuses complete foreign source in the %s domain',
  async (domain) => {
    const f = anonymousRuledMathBody(false, 180, domain)
    assert(nativePageTextPacketInventory(f.options.page, f.options.tokens, f.options.context))
    assert(
      nativeWholeCellInkPacket(f.options.page, f.options.tokens, f.options.context, {
        text: f.options.tokens.map((t) => t.text).join(''),
        sourceItems: f.options.tokens.map((t) => t.sourceItem),
        sourceRects: f.options.tokens.map((t) => t.rect)
      })
    )
    let calls = 0
    assert.equal(
      await retain(f.table, f.options, async () => {
        calls++
        return f.png
      }),
      undefined
    )
    assert.equal(calls, 0)
  }
)

it.each([
  'missing font',
  'missing source',
  'wrong caption',
  'competing table',
  'foreign caption',
  'missing rail',
  'translucent stroke',
  'round cap',
  'missing mathematical header',
  'unknown glyph',
  'wrong PNG',
  'await mutation'
])('keeps the original fallback for %s', async (kind) => {
  const f = anonymousRuledMathBody(),
    o = f.options.context.operators
  if (kind === 'missing font') f.options.context.glyphBounds = []
  if (kind === 'missing source') delete f.options.tokens[1].sourceItem
  if (kind === 'wrong caption') f.options.captions[0].lines = ['Table 1. Different']
  if (kind === 'competing table') f.options.competingRects.push([30, 80, 100, 100])
  if (kind === 'foreign caption')
    f.options.captions.push({ page: 1, lines: ['Other'], rect: [30, 90, 80, 100] })
  if (kind === 'missing rail')
    (o.argsArray[o.fnArray.indexOf(OPS.constructPath)] as unknown[])[0] = OPS.endPath
  if (kind === 'translucent stroke' || kind === 'round cap') {
    o.fnArray.unshift(kind === 'round cap' ? OPS.setLineCap : OPS.setGState)
    o.argsArray.unshift(kind === 'round cap' ? [1] : [[['CA', 0.5]]])
  }
  if (kind === 'missing mathematical header') {
    for (const i of f.items)
      if (i.str === 'κ') {
        i.str = 'Q'
        i.sourceItem.text = 'Q'
      }
    for (const t of f.options.tokens)
      if (t.text === 'κ') {
        t.text = 'Q'
        t.sourceItem.text = 'Q'
      }
    for (const [i, op] of o.fnArray.entries())
      if (op === OPS.showText)
        for (const g of (o.argsArray[i] as Glyph[][])[0])
          if (g.unicode === 'κ') {
            g.unicode = 'Q'
            g.fontChar = 'Q'
          }
    for (const g of f.options.context.glyphBounds[0].glyphs)
      if (g.fontChar === 'κ') g.fontChar = 'Q'
    assert(nativePageTextPacketInventory(f.options.page, f.options.tokens, f.options.context))
    assert(
      nativeWholeCellInkPacket(f.options.page, f.options.tokens, f.options.context, {
        text: f.options.tokens.map((t) => t.text).join(''),
        sourceItems: f.options.tokens.map((t) => t.sourceItem),
        sourceRects: f.options.tokens.map((t) => t.rect)
      })
    )
  }
  if (kind === 'unknown glyph')
    (o.argsArray[o.fnArray.indexOf(OPS.showText)] as Glyph[][])[0][0].fontChar = '?'
  assert.equal(
    await retain(f.table, f.options, async () => {
      if (kind === 'await mutation') f.options.context.sourceSha256 = 'b'.repeat(64)
      return kind === 'wrong PNG' ? Buffer.from('wrong') : f.png
    }),
    undefined
  )
})

it('rejects erased body ink in an otherwise valid PNG', async () => {
  const f = anonymousRuledMathBody(),
    image = await loadImage(f.png),
    canvas = createCanvas(image.width, image.height),
    ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  ctx.fillStyle = 'white'
  ctx.fillRect((95 - f.crop[0]) * 4, (84 - 5.6 - f.crop[1]) * 4, 20, 27)
  const png = canvas.toBuffer('image/png')
  canvas.width = canvas.height = 1
  assert.equal(await retain(f.table, f.options, async () => png), undefined)
})
