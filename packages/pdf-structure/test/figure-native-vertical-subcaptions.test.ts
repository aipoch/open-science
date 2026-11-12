import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousVerticalNativeSubcaptions } = await import(
  pathToFileURL(resolve('test/fixtures/vertical-native-subcaptions.mjs')).href
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
const crop = (f): ReturnType<typeof nativeCertifiedFigurePixelCrop> =>
  nativeCertifiedFigurePixelCrop(
    f.page,
    f.figure,
    f.captions,
    [],
    f.tokens,
    f.context,
    [f.figure],
    f.figure.rect
  )
it.each(['', 'mixed-fonts', 'unclaimed-header'])(
  'retains complete vertical native panels and shared-BT subcaptions: %s',
  async (fault) => {
    const f = await anonymousVerticalNativeSubcaptions(fault)
    try {
      expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeDefined()
      expect(
        nativePageTextPacketInventory(
          f.page,
          f.tokens,
          f.context,
          true,
          new Set(f.tokens.map((t) => t.sourceItem.index))
        )
      ).toBeDefined()
      const plan = crop(f)
      expect(plan).toBeDefined()
      expect(plan.rect[1]).toBeLessThan(80)
      expect(plan.rect[3]).toBeGreaterThan(490)
      expect(plan.sourceItems).toBeUndefined()
      const png = await renderPdfCrop(f.nativePage, plan.rect)
      expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
    } finally {
      await f.cleanup()
    }
  }
)

it.each([
  'duplicate-letter',
  'missing-form',
  'foreign-label',
  'foreign-paint',
  'clipped-label',
  'caption-rule'
])('refuses incomplete rows, foreign paint and partial original text: %s', async (fault) => {
  const f = await anonymousVerticalNativeSubcaptions(fault)
  try {
    expect(crop(f)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it.each(['width', 'transform', 'text'])(
  'requires complete original subcaption %s evidence',
  async (field) => {
    const f = await anonymousVerticalNativeSubcaptions()
    try {
      const raw = f.context.content.items.find((r) => r.str.startsWith('(a)'))
      const token = f.tokens.find((t) => t.sourceItem.index === raw.sourceItem.index)
      if (field === 'width') {
        raw.width += 0.04
        token.rect[2] += 0.04
      } else if (field === 'transform') {
        raw.transform[4] += 0.04
        token.rect[0] += 0.04
        token.rect[2] += 0.04
      } else {
        raw.str += ' changed'
        raw.sourceItem.text = raw.str
        token.text = raw.str
        token.sourceItem.text = raw.str
      }
      expect(crop(f)).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  }
)

it.each([
  'clone',
  'literal',
  'competing-table',
  'peer',
  'missing-own-token',
  'missing-caption-token'
])('keeps authentic captions and global competing-owner exclusions: %s', async (fault) => {
  const f = await anonymousVerticalNativeSubcaptions()
  try {
    if (fault === 'clone') f.figure.caption = { ...f.figure.caption }
    if (fault === 'missing-own-token') f.tokens = f.tokens.filter((t) => !t.text.startsWith('(a)'))
    if (fault === 'missing-caption-token')
      f.tokens = f.tokens.filter((t) => !t.text.startsWith('Figure'))
    if (fault === 'literal') f.figure.caption.lines = ['Figure 7: Different complete description.']
    const tables = fault === 'competing-table' ? [[50, 100, 520, 220]] : []
    const peers = fault === 'peer' ? [f.figure, { rect: [50, 100, 520, 220] }] : [f.figure]
    expect(
      nativeCertifiedFigurePixelCrop(
        f.page,
        f.figure,
        f.captions,
        tables,
        f.tokens,
        f.context,
        peers,
        f.figure.rect
      )
    ).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it.each(['source', 'operator', 'output'])(
  'withdraws final PNG permission after retained %s mutation',
  async (fault) => {
    const f = await anonymousVerticalNativeSubcaptions()
    try {
      const plan = crop(f),
        png = await renderPdfCrop(f.nativePage, plan.rect)
      expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
      if (fault === 'source')
        f.context.content.items.find((r) => r.str.startsWith('(a)')).width += 0.04
      if (fault === 'operator')
        f.context.operators.argsArray
          .find(
            (a) => Array.isArray(a) && a.some((x) => Array.isArray(x) && x.some((y) => y?.unicode))
          )
          ?.push(0)
      if (fault === 'output') plan.rect[0] -= 1
      expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
    } finally {
      await f.cleanup()
    }
  }
)
