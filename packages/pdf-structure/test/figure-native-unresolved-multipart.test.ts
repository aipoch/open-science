import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousUnresolvedNativeRasterSubcaptions } = await import(
  pathToFileURL(resolve('test/fixtures/unresolved-native-raster-subcaptions.mjs')).href
)
const { nativeCertifiedFigurePixelCrop, nativeCertifiedFigurePixelPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-whole-paint-scope.mjs')).href
)
const { createNativeFigurePaintCertificate } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { renderPdfCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
)
const crop = (f): ReturnType<typeof nativeCertifiedFigurePixelCrop> =>
  nativeCertifiedFigurePixelCrop(f.page, f.figure, f.captions, [], f.tokens, f.context, [f.figure])
it('proves a missing original two-image owner through the existing multipart pixel plan', async () => {
  const f = await anonymousUnresolvedNativeRasterSubcaptions()
  try {
    expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeDefined()
    expect(f.figure.rect).toBeUndefined()
    const plan = crop(f)
    expect(plan?.kind).toBe('complete-native-subcaption-family')
    expect(plan.sourceItems).toBeUndefined()
    const png = await renderPdfCrop(f.nativePage, plan.rect)
    expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  } finally {
    await f.cleanup()
  }
})
it.each(['duplicate-letter', 'foreign-label', 'foreign-paint', 'clipped-label'])(
  'retains unresolved ownership without complete native proof: %s',
  async (fault) => {
    const f = await anonymousUnresolvedNativeRasterSubcaptions(fault)
    try {
      expect(crop(f)).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  }
)
it.each([
  'reason',
  'original-boundary',
  'caption-clone',
  'missing-own-token',
  'missing-caption-token',
  'width',
  'transform',
  'hash'
])('requires exact unresolved inputs and original native evidence: %s', async (fault) => {
  const f = await anonymousUnresolvedNativeRasterSubcaptions()
  try {
    let boundary
    const raw = f.context.content.items.find((r) => r.str.startsWith('(a)')),
      token = f.tokens.find((t) => t.sourceItem.index === raw.sourceItem.index)
    if (fault === 'reason') f.figure.reason = 'some-other-reason'
    if (fault === 'original-boundary') boundary = [100, 80, 500, 340]
    if (fault === 'caption-clone') f.figure.caption = { ...f.figure.caption }
    if (fault === 'missing-own-token') f.tokens = f.tokens.filter((t) => t !== token)
    if (fault === 'missing-caption-token')
      f.tokens = f.tokens.filter((t) => !t.text.startsWith('Figure'))
    if (fault === 'width') {
      raw.width += 0.04
      token.rect[2] += 0.04
    }
    if (fault === 'transform') {
      raw.transform[4] += 0.04
      token.rect[0] += 0.04
      token.rect[2] += 0.04
    }
    if (fault === 'hash') delete f.context.graphicsBounds.find((g) => g.kind === 'image').imageHash
    expect(
      nativeCertifiedFigurePixelCrop(
        f.page,
        f.figure,
        f.captions,
        [],
        f.tokens,
        f.context,
        [f.figure],
        boundary
      )
    ).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})
it.each(['candidate', 'source-clone', 'caption', 'peer', 'output'])(
  'withdraws actual PNG permission after retained %s mutation',
  async (fault) => {
    const f = await anonymousUnresolvedNativeRasterSubcaptions(),
      peers = [f.figure]
    try {
      const plan = nativeCertifiedFigurePixelCrop(
          f.page,
          f.figure,
          f.captions,
          [],
          f.tokens,
          f.context,
          peers
        ),
        png = await renderPdfCrop(f.nativePage, plan.rect)
      expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
      if (fault === 'candidate') f.figure.reason = 'changed'
      if (fault === 'source-clone') f.context.content.items[0] = { ...f.context.content.items[0] }
      if (fault === 'caption') f.figure.caption.lines = [...f.figure.caption.lines]
      if (fault === 'peer') peers.push({ rect: [50, 100, 520, 250] })
      if (fault === 'output') plan.rect[0] -= 1
      expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
    } finally {
      await f.cleanup()
    }
  }
)
