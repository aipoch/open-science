import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { anonymousForeignProcedureFigure } = await import(
  pathToFileURL(resolve('test/fixtures/foreign-procedure-figure.mjs')).href
)
const { nativeCertifiedFigurePixelCrop, nativeCertifiedFigurePixelPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-whole-paint-scope.mjs')).href
)
const { renderPdfCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
)
const { createNativeFigurePaintCertificate } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)

it.each(['width', 'transform'])(
  'closes the original procedure %s in native units',
  async (field) => {
    const f = await anonymousForeignProcedureFigure()
    try {
      const source = f.context.content.items[0]
      if (field === 'width') {
        source.width += 0.04
        f.tokens[0].rect[2] += 0.04
      } else {
        source.transform[4] += 0.04
        f.tokens[0].rect[0] += 0.04
        f.tokens[0].rect[2] += 0.04
      }
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

it('keeps a whole native chart while excluding an independently closed foreign procedure', async () => {
  const f = await anonymousForeignProcedureFigure()
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
    )
    expect(plan).toBeDefined()
    expect(plan.rect[0]).toBeGreaterThan(300)
    expect(plan.rect[2]).toBeGreaterThan(560)
    expect(plan.sourceItems).toBeUndefined()
    const png = await renderPdfCrop(f.nativePage, plan.rect)
    expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  } finally {
    await f.cleanup()
  }
})

it.each(['clipped-headers', 'clipped-closure'])(
  'requires the complete original procedure glyphs inside exact clips: %s',
  async (fault) => {
    const f = await anonymousForeignProcedureFigure(fault)
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

it.each([
  'missing-input',
  'missing-output',
  'missing-number',
  'missing-closure',
  'missing-return',
  'missing-rail',
  'white-rail',
  'panel-title',
  'foreign-paint',
  'foreign-label',
  'composite-caption',
  'algorithm-reference-caption'
])(
  'preserves foreign content when the complete independent procedure proof is absent: %s',
  async (fault) => {
    const f = await anonymousForeignProcedureFigure(fault)
    try {
      if (fault === 'panel-title') expect(f.captions).toHaveLength(2)
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
      expect(plan).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  }
)

it.each(['str', 'fontName', 'width', 'transform'])(
  'rejects a forged native procedure %s',
  async (field) => {
    const f = await anonymousForeignProcedureFigure()
    try {
      const source = f.context.content.items[0]
      source[field] =
        field === 'width'
          ? source.width + 2
          : field === 'transform'
            ? source.transform.map((n: number, i: number) => (i === 4 ? n + 2 : n))
            : 'unbound native value'
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
