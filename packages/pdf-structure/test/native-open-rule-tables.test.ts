import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { anonymousCertifiedPicture } from './fixtures/figure-recovery-program.mjs'

const { recoverCaptionedNativeOpenRuleFrames: recover } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-table-boundary-ink.mjs')).href
)
type Packet = ReturnType<typeof JSON.parse>
const packet = (): Packet => {
  const f = anonymousCertifiedPicture(),
    n = f.context
  n.operators.fnArray.length = n.operators.argsArray.length = 0
  n.content.items.length = n.glyphBounds[0].glyphs.length = f.tokens.length = 0
  f.page.graphicsBounds.length = f.page.lines.length = 0
  for (const x of [140, 220]) for (let y = 80; y < 140; y += 12) f.shape(x - 0.2, y, 0.4, 12)
  for (const y of [94, 130]) f.shape(60, y - 0.2, 260, 0.4)
  f.text('Setting', 70, 90)
  f.text('Score', 150, 90)
  f.text('Value', 230, 90)
  for (let i = 0; i < 5; i++) {
    f.text('Mode' + i, 70, 105 + i * 10)
    f.text(String(i + 1), 150, 105 + i * 10)
    f.text(String(i + 2), 230, 105 + i * 10)
  }
  const text = 'Table 1: Measurements.'
  f.text(text, 60, 165)
  n.glyphBounds[0].glyphs = [
    ...new Map(n.glyphBounds[0].glyphs.map((g: Packet) => [g.fontChar, g])).values()
  ]
  const caption = { page: 1, rect: [60, 155, 330, 165], lines: [text] }
  return { ...f, captions: [caption] }
}
it('retains an open ruled native table as a complete visual without guessing cell spans', () => {
  const f = packet(),
    before = JSON.stringify([f.page, f.tokens, f.context, f.captions]),
    [r] = recover(f.page, f.tokens, f.context, f.captions)
  expect(r).toBeDefined()
  expect(r.sourceIndices).toHaveLength(18)
  expect(r.table.caption).toBe(f.captions[0])
  expect(r.table.rect[0]).toBeLessThan(60)
  expect(r.table.rect[2]).toBeGreaterThan(320)
  expect(r.table.grid).toBeUndefined()
  expect(r.current()).toBe(true)
  expect(JSON.stringify([f.page, f.tokens, f.context, f.captions])).toBe(before)
  f.tokens[1].text = 'Changed'
  expect(r.current()).toBe(false)
})
it.each([
  'caption',
  'competing-caption',
  'far-caption',
  'two-rows',
  'source-text',
  'native-program',
  'disconnected',
  'foreign-image'
])('declines open-rule visual ownership with %s', (change) => {
  const f = packet()
  if (change === 'caption') f.captions = []
  if (change === 'competing-caption')
    f.captions.push({ ...f.captions[0], rect: [100, 120, 300, 130], lines: ['Table 2: Other.'] })
  if (change === 'far-caption') f.captions[0].rect = [60, 220, 330, 230]
  if (change === 'two-rows') for (let i = 9; i < 18; i++) f.tokens[i].text = 'Word'
  if (change === 'source-text') f.tokens[1].text = 'Other'
  if (change === 'native-program')
    f.context.operators.argsArray[
      f.context.operators.argsArray.findIndex((a: Packet) => a?.[0]?.[0]?.unicode === 'Score')
    ][0][0].unicode = 'Changed'
  if (change === 'disconnected') f.page.invalidGraphicsBounds = 1
  if (change === 'foreign-image')
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex: 999,
      normalizedRect: [0.2, 0.2, 0.3, 0.3]
    })
  expect(recover(f.page, f.tokens, f.context, f.captions)).toEqual([])
})

const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const normalPacket = (): Packet => {
  const f = packet(),
    o = f.context.operators
  o.fnArray.unshift(OPS.beginMarkedContentProps, OPS.setGState)
  o.argsArray.unshift(
    ['Span', null],
    [
      [
        ['BM', 'source-over'],
        ['ca', 1],
        ['CA', 1],
        ['LC', 0],
        ['LJ', 0],
        ['LW', 1],
        ['ML', 4]
      ]
    ]
  )
  for (const g of f.page.graphicsBounds) g.operationIndex += 2
  f.add(OPS.endMarkedContent, null)
  return f
}
it('retains full glyph ownership under privately validated normal compositing and balanced structural spans', () => {
  const f = normalPacket(),
    [r] = recover(f.page, f.tokens, f.context, f.captions)
  expect(r?.current()).toBe(true)
  expect(r.sourceIndices).toHaveLength(18)
})
it.each([
  'blend',
  'alpha',
  'mask',
  'line-width',
  'line-cap',
  'line-join',
  'miter',
  'rich-span',
  'unclosed-span',
  'unclosed-save',
  'foreign-ink'
])('requires complete normal native program and foreign exclusion with %s', (change) => {
  const f = normalPacket(),
    a = f.context.operators.argsArray[1][0]
  if (change === 'blend') a[0][1] = 'multiply'
  if (change === 'alpha') a[1][1] = 0.5
  if (change === 'mask') a.push(['SMask', true])
  if (change === 'line-width') a[5][1] = Infinity
  if (change === 'line-cap') a[3][1] = 3
  if (change === 'line-join') a[4][1] = -1
  if (change === 'miter') a[6][1] = 0
  if (change === 'rich-span') f.context.operators.argsArray[0][1] = { ActualText: 'replacement' }
  if (change === 'unclosed-span') {
    f.context.operators.fnArray.pop()
    f.context.operators.argsArray.pop()
  }
  if (change === 'unclosed-save') f.add(OPS.save, null)
  if (change === 'foreign-ink') {
    f.text('Foreign', 330, 115)
    f.context.glyphBounds[0].glyphs.find((g: Packet) => g.fontChar === 'Foreign').bounds[0] = -3
  }
  expect(recover(f.page, f.tokens, f.context, f.captions)).toEqual([])
})

const { createCanvas } = await import('@napi-rs/canvas')
const pngFor = (rect: number[]): Buffer => {
  const c = createCanvas(Math.ceil((rect[2] - rect[0]) * 4), Math.ceil((rect[3] - rect[1]) * 4))
  const png = c.toBuffer('image/png')
  c.width = c.height = 0
  return png
}
it('binds the complete visual to the actual PNG footprint and excludes adjacent paint', () => {
  const f = packet(),
    [r] = recover(f.page, f.tokens, f.context, f.captions)
  expect(r.pngSafe(pngFor(r.table.rect))).toBe(true)
  expect(r.pngSafe(Buffer.alloc(0))).toBe(false)
  const g = packet()
  g.shape(59.1, 105, 0.05, 0.1)
  const [q] = recover(g.page, g.tokens, g.context, g.captions)
  expect(q).toBeDefined()
  expect(q.pngSafe(pngFor(q.table.rect))).toBe(false)
})
it('keeps the ordinary strict whole-cell program contract unchanged', async () => {
  const { nativeWholeCellInkPacket } = await import(
    pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
  )
  const f = normalPacket()
  expect(
    nativeWholeCellInkPacket(f.page, f.tokens, f.context, {
      sourceItems: f.tokens.map((t: Packet) => t.sourceItem),
      sourceRects: f.tokens.map((t: Packet) => t.rect),
      text: f.tokens.map((t: Packet) => t.text).join('')
    })
  ).toBeUndefined()
})
it('accepts a balanced structural span with absent properties and refuses imbalance', () => {
  const f = normalPacket()
  f.context.operators.argsArray[0][1] = undefined
  expect(recover(f.page, f.tokens, f.context, f.captions)).toHaveLength(1)
  f.context.operators.fnArray.pop()
  f.context.operators.argsArray.pop()
  expect(recover(f.page, f.tokens, f.context, f.captions)).toEqual([])
})
