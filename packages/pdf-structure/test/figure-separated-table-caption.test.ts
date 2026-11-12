import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { anonymousSeparatedTableCaption } = await import(
  pathToFileURL(resolve('test/fixtures/separated-table-caption-figure.mjs')).href
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

it('retains both whole native subcaptions after an independent earlier table', async () => {
  const f = await anonymousSeparatedTableCaption()
  try {
    expect(f.captions).toHaveLength(2)
    expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeDefined()
    const plan = nativeCertifiedFigurePixelCrop(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context,
      f.peers,
      f.figure.rect
    )
    expect(plan).toBeDefined()
    expect(plan.rect[3]).toBeGreaterThan(412)
    expect(plan.sourceItems).toBeUndefined()
    expect(
      nativeCertifiedFigurePixelPngSafe(
        plan,
        await renderPdfCrop(f.nativePage, plan.rect),
        plan.rect,
        f.page
      )
    ).toBe(true)
    expect(f.captions).toHaveLength(2)
    expect(f.tables).toHaveLength(1)
  } finally {
    await f.cleanup()
  }
})

it.each([
  'intersecting-caption',
  'crossing-caption',
  'same-figure-caption',
  'foreign-figure-caption',
  'nearby-table',
  'no-table',
  'ambiguous-table',
  'width-mismatch',
  'fake-caption-label',
  'fake-caption-rect',
  'clipped-caption'
])(
  'retains caption and table competition when the independent separation proof fails: %s',
  async (fault) => {
    const f = await anonymousSeparatedTableCaption(fault)
    try {
      expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeDefined()
      expect(
        nativeCertifiedFigurePixelCrop(
          f.page,
          f.figure,
          f.captions,
          f.tables,
          f.tokens,
          f.context,
          f.peers,
          f.figure.rect
        )
      ).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  }
)

it('withdraws a complete plan if the external caption or its table exclusion changes', async () => {
  const f = await anonymousSeparatedTableCaption()
  try {
    const plan = nativeCertifiedFigurePixelCrop(
        f.page,
        f.figure,
        f.captions,
        f.tables,
        f.tokens,
        f.context,
        f.peers,
        f.figure.rect
      ),
      png = await renderPdfCrop(f.nativePage, plan.rect)
    f.tables[0][3] += 0.01
    expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
    f.tables[0][3] -= 0.01
    f.captions.find((c: { lines: string[] }) => c.lines[0].startsWith('Table')).lines[0] +=
      ' changed'
    expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  } finally {
    await f.cleanup()
  }
})
