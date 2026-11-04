import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { resolve } from './paths'

const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const {
  retainCaptionedRuledMathTableBody: retain,
  recoverCaptionedNativeMathematicalBodies: recover
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-captioned-ruled-math-body.mjs')).href
)

// Two anonymous table-only mathematical source islands, separated by complete
// captions. The fixture has no guessed grid or cell assignment.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- anonymous native fixture
function anonymousSourceFencedBodies(
  kind: 'stack' | 'phase' | 'closed' | 'ordinary' | 'coefficient' = 'stack'
) {
  const width = 220,
    height = 250,
    items: Item[] = [],
    segments: number[][] = [],
    operators: Operators = { fnArray: [], argsArray: [] },
    graphicsBounds: Graphic[] = [],
    glyphs: { fontChar: string; bounds: number[] }[] = []
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
      width: (str.length * size) / 2,
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
  const captionItems: Item[] = []
  if (kind === 'stack' || kind === 'ordinary')
    for (const [number, offset] of [
      [1, 0],
      [2, 99]
    ]) {
      line(20, 35 + offset, 185, 35 + offset)
      line(70, 20 + offset, 70, 83 + offset)
      line(120, 20 + offset, 120, 83 + offset)
      for (const [n, symbol] of (kind === 'ordinary' ? ['a', 'n', 'b'] : ['σ', 'n', 'λ']).entries())
        text(symbol, 30 + n * 50, 28 + offset)
      for (let row = 0; row < 3; row++)
        for (let column = 0; column < 3; column++)
          text(String(row + column + 1), 30 + column * 50, 45 + row * 17 + offset)
      captionItems.push(text('Table ' + number + ': Example', 20, 102 + offset))
    }
  if (kind === 'phase') {
    captionItems.push(text('Table 1: Example', 20, 20))
    text('a=0', 120, 43)
    for (let column = 0; column < 3; column++) text('a', 30 + column * 20, 50)
    line(20, 55, 185, 55)
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 3; column++)
        text(row % 2 ? 's' : 'c', 30 + column * 20, 68 + row * 16)
      text('[+]', 130, 68 + row * 16)
    }
    text('Next paragraph', 20, 145)
  }
  if (kind === 'closed') {
    line(20, 40, 185, 40)
    text('Bounds', 30, 52)
    line(20, 58, 185, 58)
    for (let row = 0; row < 3; row++) {
      text('θ', 30, 76 + row * 24)
      text('≤', 55, 76 + row * 24)
      text(String(row + 1), 90, 76 + row * 24)
      text('z', 110, 73 + row * 24, 6)
    }
    line(20, 139, 185, 139)
    captionItems.push(text('Table 1: Example', 20, 164))
  }
  if (kind === 'coefficient') {
    for (const [x, str] of [
      [85, 'α'],
      [125, 'β'],
      [165, 'γ']
    ] as const)
      text(str, x, 40)
    for (let row = 0; row < 5; row++) {
      line(55, 26 + row * 20, 55, 43 + row * 20)
      if (!row) continue
      text(row === 4 ? 'sum' : 'G' + row, 25, 40 + row * 20)
      for (let column = 0; column < 3; column++)
        text(row === 4 ? 'z+1' : row + column + 1 + 'z', 85 + column * 40, 40 + row * 20)
    }
    line(20, 45, 200, 45)
    line(20, 105, 200, 105)
    captionItems.push(text('Table 1.', 20, 145), text('Example', 65, 145))
  }
  text('1', 108, 240)
  const viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number) => [x, height - y]
    },
    content = { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
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
      tokens: items.map((item) => tableTextToken(item, viewport, 0)),
      context: {
        operators,
        glyphBounds: [{ fontName: 'F', glyphs }],
        viewport,
        content,
        graphicsBounds,
        pageNumber: 1,
        sourceSha256: 'a'.repeat(64)
      },
      captions:
        kind === 'coefficient'
          ? [
              {
                page: 1,
                lines: ['Table 1. Example'],
                rect: [20, 137, 93, 145]
              }
            ]
          : captionItems.map((item) => ({
              page: 1,
              lines: [item.str],
              rect: tableTextToken(item, viewport, 0).rect
            })),
      competingRects: [] as number[][]
    }
  const render = (rect: number[], erase = false): Buffer => {
    const canvas = createCanvas(
        Math.ceil((rect[2] - rect[0]) * 4),
        Math.ceil((rect[3] - rect[1]) * 4)
      ),
      ctx = canvas.getContext('2d')
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.scale(4, 4)
    ctx.translate(-rect[0], -rect[1])
    ctx.strokeStyle = 'black'
    ctx.lineWidth = 0.6
    for (const [x0, y0, x1, y1] of segments) {
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
      ctx.stroke()
    }
    ctx.fillStyle = 'black'
    for (const item of items) {
      const baseline = height - item.transform[5],
        size = item.height
      for (let n = 0; n < item.str.length; n++)
        ctx.fillRect(
          item.transform[4] + (n * size) / 2,
          baseline - size * 0.7,
          size / 2,
          size * 0.8
        )
    }
    if (erase) {
      ctx.fillStyle = 'white'
      ctx.fillRect(29.9, 22.3, 4.2, 6.6)
    }
    const png = canvas.toBuffer('image/png')
    canvas.width = canvas.height = 1
    return png
  }
  return { options, items, render }
}

it('retains whole caption-fenced mathematical sources without inventing cells', async () => {
  const f = anonymousSourceFencedBodies(),
    seeds = recover(f.options)
  assert.equal(seeds.length, 2)
  for (const seed of seeds) {
    const out = await retain(seed, f.options, async (rect: number[]) => f.render(rect))
    assert(out && out.current())
    assert.equal(out.table.caption, seed.caption)
    assert.equal(out.table.nativeBody.sourceItems.length, 12)
    assert.equal(out.table.cells, undefined)
    assert.equal(out.table.grid, undefined)
    assert(
      out.table.nativeBody.sourceItems.every(
        (origin: { text: string }) => !origin.text.startsWith('Table')
      )
    )
    out.table.nativeBody.sourceItems[0].text += ' changed'
    assert.equal(out.current(), false)
  }
})

it.each(['phase', 'closed'] as const)(
  'retains a complete anonymous %s mathematical body',
  async (kind) => {
    const f = anonymousSourceFencedBodies(kind),
      seeds = recover(f.options)
    assert.equal(seeds.length, 1)
    const out = await retain(seeds[0], f.options, async (rect: number[]) => f.render(rect))
    assert(out && out.current())
    assert.equal(out.table.nativeBody.sourceItems.length, kind === 'phase' ? 20 : 13)
    assert.equal(out.table.cells, undefined)
    assert.equal(out.table.grid, undefined)
    assert(
      !out.table.nativeBody.sourceItems.some((origin: { text: string }) =>
        /Table|paragraph/.test(origin.text)
      )
    )
  }
)

it.each(['font', 'caption', 'native source', 'ordinary prose', 'stroke opacity'])(
  'does not issue a source-fenced certificate with incomplete %s evidence',
  (kind) => {
    const f = anonymousSourceFencedBodies()
    if (kind === 'font') f.options.context.glyphBounds = []
    if (kind === 'caption') f.options.captions[0].lines[0] = 'Table 1: Other'
    if (kind === 'native source') f.options.tokens[0].sourceItem.text = 'Other'
    if (kind === 'ordinary prose') {
      f.items[0].str = 'Ordinary paragraph'
      f.items[0].sourceItem.text = 'Ordinary paragraph'
    }
    if (kind === 'stroke opacity') {
      f.options.context.operators.fnArray.unshift(OPS.setGState)
      f.options.context.operators.argsArray.unshift([[['CA', 0.5]]])
      f.options.page.graphicsBounds.forEach((graphic) => graphic.operationIndex++)
    }
    assert.equal(recover(f.options).length, 0)
  }
)

it('keeps an independent island when another already has an owner', () => {
  const f = anonymousSourceFencedBodies()
  f.options.competingRects.push([20, 20, 185, 85])
  const seeds = recover(f.options)
  assert.equal(seeds.length, 1)
  assert.equal(seeds[0].caption.lines[0], 'Table 2: Example')
})

it('does not promote ordinary short-label numeric tables to mathematical bodies', () => {
  const f = anonymousSourceFencedBodies('ordinary')
  assert(
    nativeWholeCellInkPacket(f.options.page, f.options.tokens, f.options.context, {
      text: f.options.tokens.map((token: { text: string }) => token.text).join(''),
      sourceItems: f.options.tokens.map((token: { sourceItem: unknown }) => token.sourceItem),
      sourceRects: f.options.tokens.map((token: { rect: number[] }) => token.rect)
    })
  )
  assert.equal(recover(f.options).length, 0)
})

it.each([
  'cloned seed',
  'await source change',
  'wrong PNG',
  'erased glyph',
  'late PNG change',
  'late rectangle change'
])('refuses a source-fenced publication with %s', async (kind) => {
  const f = anonymousSourceFencedBodies(),
    seed = recover(f.options)[0]
  assert(seed)
  const out = await retain(
    kind === 'cloned seed' ? structuredClone(seed) : seed,
    f.options,
    async (rect: number[]) => {
      if (kind === 'await source change') f.options.context.sourceSha256 = 'b'.repeat(64)
      return kind === 'wrong PNG' ? Buffer.from('wrong') : f.render(rect, kind === 'erased glyph')
    }
  )
  if (kind === 'late PNG change' || kind === 'late rectangle change') {
    assert(out && out.current())
    if (kind === 'late PNG change') out.png[0] ^= 1
    else out.table.rect[0] -= 1
    assert.equal(out.current(), false)
  } else assert.equal(out, undefined)
})
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

class AnonymousWitnessViewport {
  transform = [1, 0, 0, -1, 0, 250]
  point(x: number, y: number): number[] {
    return [x, y]
  }
}

it.each([
  'complete',
  'peer',
  'late source',
  'late caption',
  'witness',
  'equal witness',
  'witness prototype',
  'witness transform'
])(
  'retains only complete two-rail coefficient bodies with original Source lifetimes: %s',
  async (mode) => {
    const f = anonymousSourceFencedBodies('coefficient'),
      viewport = new AnonymousWitnessViewport(),
      options = {
        ...f.options,
        context: {
          ...f.options.context,
          ...(mode.includes('witness') ? { runningHeadWitness: { witnessViewport: viewport } } : {})
        }
      }
    expectCompleteNative(options)
    if (mode === 'peer') options.competingRects.push([80, 55, 105, 70])
    const seeds = recover(options)
    assert.equal(seeds.length, mode === 'peer' ? 0 : 1)
    if (!seeds.length) return
    const out = await retain(seeds[0], options, async (crop: number[]) => {
      const png = f.render(crop)
      if (mode === 'late source') options.tokens[5].sourceItem = { ...options.tokens[5].sourceItem }
      if (mode === 'late caption') options.captions[0].rect = [...options.captions[0].rect]
      if (mode === 'equal witness')
        options.context.runningHeadWitness!.witnessViewport = new AnonymousWitnessViewport()
      if (mode === 'witness prototype') Object.setPrototypeOf(viewport, Object.prototype)
      if (mode === 'witness transform') viewport.transform[4] = 1
      return png
    })
    if (!['complete', 'witness'].includes(mode)) return assert.equal(out, undefined)
    assert(out && out.current())
    assert.deepEqual(
      out.table.nativeBody.sourceItems,
      f.items.slice(0, 19).map((i) => i.sourceItem)
    )
    assert.equal(out.table.cells, undefined)
    assert.equal(out.table.grid, undefined)
    assert(!out.table.nativeBody.sourceItems.some((i: { index: number }) => i.index >= 19))
  }
)

function expectCompleteNative(
  options: ReturnType<typeof anonymousSourceFencedBodies>['options']
): void {
  assert(nativePageTextPacketInventory(options.page, options.tokens, options.context))
  assert(
    nativeWholeCellInkPacket(options.page, options.tokens, options.context, {
      text: options.tokens.map((t: { text: string }) => t.text).join(''),
      sourceItems: options.tokens.map((t: { sourceItem: Item['sourceItem'] }) => t.sourceItem),
      sourceRects: options.tokens.map((t: { rect: number[] }) => t.rect)
    })
  )
}

it('keeps the original secondary-viewport refusal for existing mathematical body families', () => {
  const f = anonymousSourceFencedBodies(),
    viewport = new AnonymousWitnessViewport()
  assert.equal(recover(f.options).length, 2)
  const options = {
    ...f.options,
    context: { ...f.options.context, runningHeadWitness: { witnessViewport: viewport } }
  }
  expectCompleteNative(options)
  assert.equal(recover(options).length, 0)
})

const pixelMathApi = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-captioned-ruled-math-body.mjs')).href
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- anonymous native paint fixture
function anonymousThreeRulePixelTable(kind = 'normal') {
  const width = 220,
    height = 250,
    items: Item[] = [],
    glyphs: { fontChar: string; bounds: number[] }[] = [],
    operators: Operators = { fnArray: [], argsArray: [] },
    graphicsBounds: Graphic[] = []
  const add = (op: number, args: unknown[] | null): void => {
    operators.fnArray.push(op)
    operators.argsArray.push(args)
  }
  const text = (str: string, x: number, y: number): Item => {
    add(OPS.beginText, null)
    add(OPS.setFont, ['F', 8])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - y]])
    add(OPS.showText, [
      [...str].map((c) => ({ unicode: c, fontChar: c, width: 500, isInFont: true }))
    ])
    add(OPS.endText, null)
    const item = {
      str,
      dir: 'ltr',
      width: [...str].length * 4,
      height: 8,
      transform: [8, 0, 0, 8, x, height - y],
      fontName: 'F',
      hasEOL: true,
      sourceItem: { pageNumber: 1, index: items.length, text: str }
    }
    items.push(item)
    for (const c of str)
      if (!glyphs.some((g) => g.fontChar === c))
        glyphs.push({ fontChar: c, bounds: [0, -0.1, 0.5, 0.7] })
    return item
  }
  const line = (a: number, y: number, b: number): void => {
    add(OPS.constructPath, [
      OPS.stroke,
      [[0, a, height - y, 1, b, height - y]],
      [a, height - y, b, height - y]
    ])
    graphicsBounds.push({
      kind: 'path',
      operationIndex: operators.fnArray.length - 1,
      normalizedRect: [a / width, (y - 0.3) / height, b / width, (y + 0.3) / height]
    })
  }
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.6])
  const cap = text(kind === 'prose' ? 'Table 1 shows a trend' : 'Table 1', 20, 20),
    explanation = text('Full comparison of model conditions', 20, 30)
  line(20, 40, 200)
  for (const [x, s] of [
    [30, 'Type'],
    [75, 'Limit'],
    [120, 'Form'],
    [165, 'Error']
  ] as const)
    text(s, x, 52)
  line(20, 58, 200)
  for (let i = 0; i < 3; i++) {
    text('case', 30, 76 + i * 24)
    text(i ? 'σ+1' : 'x≤1', 75, 76 + i * 24)
    text('root', 120, 76 + i * 24)
    text('0.1', 165, 76 + i * 24)
  }
  line(122, 94, 130)
  if (kind !== 'missing-rail') line(20, 139, 200)
  const accent = text('̂', kind === 'overlap' ? 18 : 25, kind === 'overlap' ? 90 : 180)
  accent.width = 0
  text('Following paragraph', 20, 205)
  const viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number) => [x, height - y]
    },
    content = { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
    page = {
      pageNumber: 1,
      width,
      height,
      rotation: 0,
      renderRotation: 0,
      invalidGraphicsBounds: 0,
      graphicsBounds
    },
    options = {
      page,
      tokens: items.map((r) => tableTextToken(r, viewport, 0)),
      context: {
        operators,
        glyphBounds: [{ fontName: 'F', glyphs }],
        viewport,
        content,
        graphicsBounds,
        pageNumber: 1,
        sourceSha256: 'a'.repeat(64)
      },
      captions: [
        { page: 1, lines: [cap.str, explanation.str], rect: [20, 12, 20 + explanation.width, 30] }
      ],
      competingRects: [] as number[][]
    }
  const png = (rect: number[], scale = 4): Buffer => {
    const c = createCanvas(
        Math.ceil((rect[2] - rect[0]) * scale),
        Math.ceil((rect[3] - rect[1]) * scale)
      ),
      ctx = c.getContext('2d')
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.fillStyle = 'black'
    ctx.fillRect(2, 2, c.width - 4, c.height - 4)
    const out = c.toBuffer('image/png')
    c.width = c.height = 1
    return out
  }
  return { options, accent, png }
}

it('captioned three-rule pixel keeps the image while a foreign zero-width accent declines Source authority', () => {
  const f = anonymousThreeRulePixelTable(),
    before = JSON.stringify(f.options),
    plan = (
      pixelMathApi.recoverCaptionedNativeThreeRulePixelTable ??
      ((o: typeof f.options) => recover(o)[0])
    )(f.options)
  assert(plan, 'the complete captioned image must survive unreliable native cells')
  assert.equal(plan.nativeBody, undefined)
  assert.equal(plan.cells, undefined)
  assert.equal(pixelMathApi.captionedNativeThreeRulePixelTableCurrent(plan, f.options.page), true)
  assert.equal(
    nativeWholeCellInkPacket(f.options.page, f.options.tokens, f.options.context, {
      text: f.options.tokens.map((t) => t.text).join(''),
      sourceItems: f.options.tokens.map((t) => t.sourceItem),
      sourceRects: f.options.tokens.map((t) => t.rect)
    }),
    undefined
  )
  assert.equal(JSON.stringify(f.options), before)
})
it('captioned three-rule pixel rejects a prose prefix without an independent numbered caption', () => {
  const f = anonymousThreeRulePixelTable('prose')
  assert.equal(pixelMathApi.recoverCaptionedNativeThreeRulePixelTable(f.options), undefined)
})
it('captioned three-rule pixel requires the complete bottom native rail', () => {
  const f = anonymousThreeRulePixelTable('missing-rail')
  assert.equal(pixelMathApi.recoverCaptionedNativeThreeRulePixelTable(f.options), undefined)
})
it('captioned three-rule pixel retains a foreign zero-width glyph crossing the body boundary', () => {
  const f = anonymousThreeRulePixelTable('overlap')
  assert.equal(pixelMathApi.recoverCaptionedNativeThreeRulePixelTable(f.options), undefined)
})
it('captioned three-rule pixel rejects cloned plans and stale original foreign data', () => {
  const f = anonymousThreeRulePixelTable(),
    plan = pixelMathApi.recoverCaptionedNativeThreeRulePixelTable(f.options)
  assert(plan)
  assert.equal(
    pixelMathApi.captionedNativeThreeRulePixelTableCurrent({ ...plan }, f.options.page),
    false
  )
  f.accent.width = 1
  assert.equal(pixelMathApi.captionedNativeThreeRulePixelTableCurrent(plan, f.options.page), false)
})
it('captioned three-rule pixel validates the actual PNG footprint and minimum scale', () => {
  const f = anonymousThreeRulePixelTable(),
    plan = pixelMathApi.recoverCaptionedNativeThreeRulePixelTable(f.options)
  assert(plan)
  assert.equal(
    pixelMathApi.captionedNativeThreeRulePixelTablePngSafe(
      plan,
      f.png(plan.rect),
      plan.rect,
      f.options.page
    ),
    true
  )
  assert.equal(
    pixelMathApi.captionedNativeThreeRulePixelTablePngSafe(
      plan,
      f.png(plan.rect, 1),
      plan.rect,
      f.options.page
    ),
    false
  )
})
