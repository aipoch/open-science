import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { anonymousOrdinaryFormFigure } = await import(
  pathToFileURL(resolve('test/fixtures/ordinary-form-figure.mjs')).href
)
const { nativeRecoveryFigureCrop, nativeRecoveryFigurePngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-whole-paint-scope.mjs')).href
)
const { nativePageTextPacketInventory } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { renderPdfCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
)
const { tableTextToken, nativeFigureLabelBounds } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const productionTokens = (f): typeof f.tokens => {
  const viewport = f.nativePage.getViewport({ scale: 1.5 })
  return f.context.content.items
    .filter((item) => item.str?.trim())
    .map((item) => ({
      ...tableTextToken(item, viewport, 0),
      fontAscent: f.context.content.styles[item.fontName]?.ascent,
      fontDescent: f.context.content.styles[item.fontName]?.descent,
      nativeLabelRect: nativeFigureLabelBounds(
        item,
        f.context.content.styles[item.fontName],
        viewport
      )
    }))
    .map((token) => ({
      ...token,
      rect: token.rect.map((value) => value / 1.5),
      nativeLabelRect: token.nativeLabelRect?.map((value) => value / 1.5),
      baseline: token.baseline / 1.5,
      height: token.height / 1.5
    }))
}
const crop = (f, tables = []): ReturnType<typeof nativeRecoveryFigureCrop> =>
  nativeRecoveryFigureCrop(f.page, f.figure, f.captions, tables, f.tokens, f.context)

it('restores every panel and title in a complete ordinary raster Form without public Sources', async () => {
  const f = await anonymousOrdinaryFormFigure()
  try {
    expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeUndefined()
    const plan = crop(f)
    expect(plan).toBeDefined()
    expect(plan.rect[1]).toBeLessThan(80)
    expect(plan.rect[3]).toBeGreaterThan(500)
    expect(plan.sourceItems).toEqual([])
    expect(plan.graphicsCount).toBe(6)
    const png = await renderPdfCrop(f.nativePage, plan.rect)
    expect(nativeRecoveryFigurePngSafe(png, plan.rect, f.page, plan)).toBe(true)
  } finally {
    await f.cleanup()
  }
})

it('binds the exact actual render-to-native caption metric tuple at fractional coordinates', async () => {
  const f = await anonymousOrdinaryFormFigure()
  try {
    const direct = f.tokens.find((t) => t.text.startsWith('Complete anonymous'))
    f.tokens = productionTokens(f)
    const projected = f.tokens.find((t) => t.text.startsWith('Complete anonymous'))
    expect(projected.rect).not.toEqual(direct.rect)
    expect(Math.abs(projected.rect[0] - direct.rect[0])).toBeLessThan(1e-12)
    const plan = crop(f)
    expect(plan).toBeDefined()
    expect(plan.sourceItems).toEqual([])
    const png = await renderPdfCrop(f.nativePage, plan.rect)
    expect(nativeRecoveryFigurePngSafe(png, plan.rect, f.page, plan)).toBe(true)
  } finally {
    await f.cleanup()
  }
})

it.each(['baseline', 'height', 'rect', 'source'])(
  'refuses an intentional change to the original projected caption %s',
  async (field) => {
    const f = await anonymousOrdinaryFormFigure()
    try {
      f.tokens = productionTokens(f)
      const token = f.tokens.find((t) => t.text.startsWith('Complete anonymous'))
      if (field === 'baseline') token.baseline += 0.000001
      if (field === 'height') token.height += 0.000001
      if (field === 'rect') token.rect[0] += 0.000001
      if (field === 'source') token.sourceItem = { ...token.sourceItem, pageNumber: 2 }
      expect(crop(f)).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  }
)

it.each([
  'no-form',
  'multiple-forms',
  'nested-form',
  'foreign-own',
  'foreign-lane',
  'foreign-image',
  'clipped-label'
])('declines an incomplete or ambiguous original Form: %s', async (fault) => {
  const f = await anonymousOrdinaryFormFigure(fault)
  try {
    expect(crop(f)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it.each([
  'complete-seed',
  'table',
  'lane-table',
  'caption-clone',
  'caption-literal',
  'duplicate-caption',
  'image-hash',
  'image-geometry'
])('retains complete output and original caption/image exclusions: %s', async (fault) => {
  const f = await anonymousOrdinaryFormFigure()
  try {
    const tables = fault === 'table' ? [[100, 100, 200, 200]] : []
    if (fault === 'lane-table') tables.push([100, 505, 200, 520])
    if (fault === 'complete-seed') f.figure.rect = [55, 75, 485, 505]
    if (fault === 'caption-clone') f.figure.caption = { ...f.figure.caption }
    if (fault === 'caption-literal') f.figure.caption.lines = ['Figure 1: Other text.']
    if (fault === 'duplicate-caption')
      f.captions.push({ page: 1, lines: ['Figure 1: Other text.'], rect: [60, 650, 300, 670] })
    if (fault === 'image-hash')
      delete f.context.graphicsBounds.find((g) => g.kind === 'image').imageHash
    if (fault === 'image-geometry') {
      const image = f.context.graphicsBounds.find((g) => g.kind === 'image')
      image.normalizedRect = image.normalizedRect.map((x) => x + 1 / 256)
    }
    expect(crop(f, tables)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it.each(['source', 'operator', 'image', 'caption', 'output', 'png', 'raster'])(
  'withdraws PNG permission when the original %s proof changes',
  async (fault) => {
    const f = await anonymousOrdinaryFormFigure()
    try {
      const plan = crop(f)
      expect(plan).toBeDefined()
      const png = await renderPdfCrop(f.nativePage, plan.rect)
      expect(nativeRecoveryFigurePngSafe(png, plan.rect, f.page, plan)).toBe(true)
      if (fault === 'source') f.context.content.items[0].width += 0.1
      if (fault === 'operator') f.context.operators.argsArray[0] = []
      if (fault === 'image')
        f.context.graphicsBounds.find((g) => g.kind === 'image').imageHash = '0'.repeat(64)
      if (fault === 'caption') f.figure.caption.lines = []
      if (fault === 'output') plan.rect[1] -= 1
      if (fault === 'png') png[0] = 0
      if (fault === 'raster')
        new DataView(png.buffer, png.byteOffset, png.byteLength).setUint32(16, 1)
      expect(nativeRecoveryFigurePngSafe(png, plan.rect, f.page, plan)).toBe(false)
    } finally {
      await f.cleanup()
    }
  }
)
