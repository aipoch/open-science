import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { anonymousCaptionedSingleForm } = await import(
  pathToFileURL(resolve('test/fixtures/captioned-single-form.mjs')).href
)
const { nativeCertifiedFigurePixelCrop, nativeCertifiedFigurePixelPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-whole-paint-scope.mjs')).href
)
const { createNativeFigurePaintCertificate, nativePageTextPacketInventory } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { renderPdfCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
)
const crop = (f, tables = []): ReturnType<typeof nativeCertifiedFigurePixelCrop> =>
  nativeCertifiedFigurePixelCrop(
    f.page,
    f.figure,
    f.captions,
    tables,
    f.tokens,
    f.context,
    f.peers,
    f.figure.rect
  )

it('restores one complete Type3 Form beside an independently captioned Form without Source claims', async () => {
  const f = await anonymousCaptionedSingleForm()
  try {
    expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeDefined()
    expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeUndefined()
    const plan = crop(f)
    expect(plan).toBeDefined()
    expect(plan.rect[3]).toBeGreaterThan(290)
    expect(plan.sourceItems).toBeUndefined()
    expect(plan.rect[2]).toBeLessThan(300)
    const png = await renderPdfCrop(f.nativePage, plan.rect)
    expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  } finally {
    await f.cleanup()
  }
})

it.each([
  'foreign-text',
  'foreign-paint',
  'single-caption',
  'clipped-label',
  'outside-form-label',
  'gap-label',
  'unproved-pre-path-state'
])('preserves complete Form, caption and foreign-paint exclusions: %s', async (fault) => {
  const f = await anonymousCaptionedSingleForm(fault)
  try {
    expect(crop(f)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it.each(['outer-form-clip', 'null-endpath'])(
  'preserves the original visible Form and unchanged nonpaint operation admission: %s',
  async (fault) => {
    const f = await anonymousCaptionedSingleForm(fault)
    try {
      expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeDefined()
      expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeUndefined()
      const plan = crop(f)
      expect(plan).toBeDefined()
      expect(plan.sourceItems).toBeUndefined()
      const png = await renderPdfCrop(f.nativePage, plan.rect)
      expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
    } finally {
      await f.cleanup()
    }
  }
)

it('also retains the separately captioned right Form', async () => {
  const f = await anonymousCaptionedSingleForm()
  try {
    f.figure = f.peers[1]
    const plan = crop(f)
    expect(plan).toBeDefined()
    expect(plan.rect[0]).toBeGreaterThan(300)
    expect(plan.rect[3]).toBeGreaterThan(290)
    expect(plan.sourceItems).toBeUndefined()
    const png = await renderPdfCrop(f.nativePage, plan.rect)
    expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  } finally {
    await f.cleanup()
  }
})

it.each([
  'caption-clone',
  'caption-literal',
  'caption-cleared',
  'caption-peer',
  'caption-token',
  'caption-baseline',
  'caption-height',
  'form-end',
  'competing-table'
])('rejects an unbound or competing native owner: %s', async (fault) => {
  const f = await anonymousCaptionedSingleForm()
  try {
    const token = f.tokens.find((t) => t.text.startsWith('Figure 1:'))
    if (fault === 'caption-clone') f.figure.caption = { ...f.figure.caption }
    if (fault === 'caption-literal') f.figure.caption.lines = ['Figure 1: Different complete text.']
    if (fault === 'caption-cleared') f.figure.caption.lines = []
    if (fault === 'caption-peer') f.peers.push({ ...f.figure })
    if (fault === 'caption-token') f.tokens = f.tokens.filter((t) => t !== token)
    if (fault === 'caption-baseline') token.baseline += 1
    if (fault === 'caption-height') token.height += 1
    if (fault === 'form-end') f.context.operators.fnArray.splice(0, 1)
    expect(crop(f, fault === 'competing-table' ? [[80, 150, 200, 300]] : [])).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it.each(['style', 'source', 'operator', 'caption', 'output'])(
  'withdraws final PNG permission after original %s evidence changes',
  async (fault) => {
    const f = await anonymousCaptionedSingleForm()
    try {
      const plan = crop(f)
      expect(plan).toBeDefined()
      const png = await renderPdfCrop(f.nativePage, plan.rect)
      expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
      const raw = f.context.content.items.find((r) => r.str.startsWith('Figure 1:'))
      if (fault === 'style') f.context.content.styles[raw.fontName].ascent += 0.1
      if (fault === 'source') raw.width += 0.04
      if (fault === 'operator') f.context.operators.argsArray[0] = []
      if (fault === 'caption') f.figure.caption.lines = []
      if (fault === 'output') plan.rect[0] -= 1
      expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
    } finally {
      await f.cleanup()
    }
  }
)
