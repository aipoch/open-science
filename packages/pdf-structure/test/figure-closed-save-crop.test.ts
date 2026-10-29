import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousClosedSaveFigure, addAnonymousUnclaimedFigureGlyph } = await import(
  pathToFileURL(resolve('test/fixtures/closed-save-figure.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { nativeClosedSaveFigureCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-closed-save.mjs')).href
)
const { nativePageTextPacketInventory } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { nativeCompleteFormCropPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-complete-form.mjs')).href
)
import { createCanvas } from '@napi-rs/canvas'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

it('recovers the whole closed native drawing and every literal owner through public association', () => {
  const f = anonymousClosedSaveFigure(),
    [page, , captions, tables, tokens, context] = f.args,
    before = JSON.stringify(f),
    result = associateFigures(page, captions, tables, [], [], tokens, context)
  expect(result).toHaveLength(1)
  expect(result[0].rect).toEqual([50, 70, 280, 188])
  expect(result[0].sourceItems).toEqual(
    context.content.items.slice(0, 3).map((r: { sourceItem: unknown }) => r.sourceItem)
  )
  expect(result[0].graphicsCount).toBe(3)
  expect(result[0].formCropRaster).toBeDefined()
  expect(JSON.stringify(f)).toBe(before)
})

it.each(['normal', 'owned-alpha'])(
  'proves the complete %s program without changing inputs',
  (mode) => {
    const f = anonymousClosedSaveFigure(mode),
      before = JSON.stringify(f),
      result = nativeClosedSaveFigureCrop(...f.args)
    expect(result.rect).toEqual([50, 70, 280, 188])
    expect(result.sourceItems).toHaveLength(3)
    expect(result.formCropRaster.foreignPaints).toHaveLength(1)
    expect(result.graphicsCount).toBe(3)
    expect(JSON.stringify(f)).toBe(before)
  }
)

it.each([
  'foreign-paint',
  'neutral-BM',
  'isolated-group',
  'foreign-text',
  'micro-sign',
  'narrative',
  'metrics',
  'outlines',
  'duplicate-origin',
  'literal-mismatch',
  'table',
  'caption',
  'open-save'
])('refuses incomplete ownership: %s', (mode) => {
  const f = anonymousClosedSaveFigure(mode),
    before = JSON.stringify(f)
  expect(nativeClosedSaveFigureCrop(...f.args)).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})

it('can recover a caption-only drawing and rejects incomplete old owners', () => {
  const f = anonymousClosedSaveFigure()
  delete f.args[1].rect
  expect(nativeClosedSaveFigureCrop(...f.args)?.sourceItems).toHaveLength(3)
  f.args[1].sourceItems = [{ pageNumber: 1, index: 3, text: 'Unowned' }]
  expect(nativeClosedSaveFigureCrop(...f.args)).toBeUndefined()
})

it('keeps the existing rendered-footprint validator mandatory', () => {
  const f = anonymousClosedSaveFigure(),
    result = nativeClosedSaveFigureCrop(...f.args),
    page = f.args[0],
    rect = result.rect.map((v: number, i: number) => v + (i < 2 ? -2 : 2)),
    canvas = createCanvas(Math.ceil((rect[2] - rect[0]) * 3), Math.ceil((rect[3] - rect[1]) * 3))
  try {
    expect(nativeCompleteFormCropPngSafe(canvas.toBuffer('image/png'), rect, page, result)).toBe(
      true
    )
    canvas.width = 2
    canvas.height = 3
    expect(nativeCompleteFormCropPngSafe(canvas.toBuffer('image/png'), rect, page, result)).toBe(
      false
    )
  } finally {
    canvas.width = canvas.height = 1
  }
})

it('bounds save-scope search before repeatedly partitioning the whole page', () => {
  const f = anonymousClosedSaveFigure(),
    o = f.args[5].operators
  for (let i = 0; i < 513; i++) {
    o.fnArray.push(OPS.save, OPS.restore)
    o.argsArray.push(null, null)
  }
  expect(nativeClosedSaveFigureCrop(...f.args)).toBeUndefined()
})

it.each([' ', '', '\t', '\u00a0'])(
  'excludes unclaimed painted glyph ink even for literal %j',
  (text) => {
    const f = addAnonymousUnclaimedFigureGlyph(anonymousClosedSaveFigure(), { text }),
      a = f.args,
      before = JSON.stringify(f),
      packet = nativePageTextPacketInventory(a[0], a[4], a[5], true)
    expect(packet).toBeDefined()
    expect(packet.records).toHaveLength(4)
    expect(packet.glyphs.at(-1).ink).toEqual([70, 173, 75, 181])
    expect(nativeClosedSaveFigureCrop(...a)).toBeUndefined()
    const publicFigure = associateFigures(a[0], a[2], a[3], [], [], a[4], a[5])[0]
    expect(publicFigure.formCropRaster).toBeUndefined()
    expect(JSON.stringify(f)).toBe(before)
  }
)

it('refuses an incomplete native save program even when its unclaimed glyph is outside the crop', () => {
  const f = addAnonymousUnclaimedFigureGlyph(anonymousClosedSaveFigure(), {
    insideScope: true,
    x: 330
  })
  expect(nativeClosedSaveFigureCrop(...f.args)).toBeUndefined()
})

it('retains distant foreign glyph ink for the final PNG exclusion check', () => {
  const f = addAnonymousUnclaimedFigureGlyph(anonymousClosedSaveFigure(), { x: 330 }),
    result = nativeClosedSaveFigureCrop(...f.args)
  expect(result.sourceItems).toHaveLength(3)
  expect(result.formCropRaster.foreignPaints).toContainEqual({
    rect: [330, 173, 335, 181],
    floor: 0
  })
})

it('requires explicit metrics for a foreign font used only by an unclaimed painted glyph', () => {
  const f = addAnonymousUnclaimedFigureGlyph(anonymousClosedSaveFigure(), {
    x: 330,
    missingMetrics: true
  })
  expect(nativeClosedSaveFigureCrop(...f.args)).toBeUndefined()
})

it.each([false, true])(
  'retains certified zero-outline whitespace with insideScope=%s',
  (insideScope) => {
    const f = addAnonymousUnclaimedFigureGlyph(anonymousClosedSaveFigure(), {
      insideScope,
      emptyOutline: true
    })
    expect(nativeClosedSaveFigureCrop(...f.args)?.sourceItems).toHaveLength(3)
  }
)

it('checks the antialias separation of foreign glyph ink beyond the nominal crop', () => {
  const near = addAnonymousUnclaimedFigureGlyph(anonymousClosedSaveFigure(), { x: 282 }),
    far = addAnonymousUnclaimedFigureGlyph(anonymousClosedSaveFigure(), { x: 284 })
  expect(nativeClosedSaveFigureCrop(...near.args)).toBeUndefined()
  expect(nativeClosedSaveFigureCrop(...far.args)).toBeDefined()
})

it('does not claim one painted glyph as two independent whole source items', () => {
  const f = anonymousClosedSaveFigure(),
    a = f.args,
    ctx = a[5],
    first = ctx.content.items[0],
    second = structuredClone(first)
  first.str = first.sourceItem.text = 'First'
  second.str = second.sourceItem.text = ' block'
  ctx.content.items.splice(1, 0, second)
  for (const [index, r] of ctx.content.items.entries()) r.sourceItem.index = index
  a[4] = ctx.content.items.map((r: unknown) => tableTextToken(r, ctx.viewport, 0))
  const packet = nativePageTextPacketInventory(a[0], a[4], ctx, true)
  expect(packet).toBeDefined()
  expect(packet.records[0].part[0].g).toBe(packet.records[1].part[0].g)
  expect(nativeClosedSaveFigureCrop(...a)).toBeUndefined()
})
