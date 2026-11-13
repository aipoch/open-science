import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')

const { anonymousFramedForeignProcedureFigure } = await import(
  pathToFileURL(resolve('test/fixtures/framed-foreign-procedure-figure.mjs')).href
)
const { nativeCertifiedFigurePixelCrop, nativeCertifiedFigurePixelPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-whole-paint-scope.mjs')).href
)
const { createNativeFigurePaintCertificate, nativeFigurePaintCertificateData } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { renderPdfCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
)
const { nativeFramedForeignProcedureTopCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-foreign-procedure-scope.mjs')).href
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

it('removes only the foreign closing rule above a complete native chart', async () => {
  const f = await anonymousFramedForeignProcedureFigure()
  try {
    const plan = crop(f)
    expect(plan).toBeDefined()
    expect(plan.rect[1]).toBeGreaterThan(230)
    expect([plan.rect[0], plan.rect[2], plan.rect[3]]).toEqual([
      f.figure.rect[0],
      f.figure.rect[2],
      f.figure.rect[3]
    ])
    expect(plan.sourceItems).toBeUndefined()
    const png = await renderPdfCrop(f.nativePage, plan.rect)
    expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  } finally {
    await f.cleanup()
  }
})

it.each([
  'missing-title',
  'double-title',
  'missing-ordinal',
  'duplicate-ordinal',
  'missing-return',
  'missing-closing',
  'white-closing',
  'short-closing',
  'dashed-closing',
  'round-cap',
  'square-cap',
  'hairline',
  'clipped-title',
  'clipped-body',
  'foreign-paint',
  'foreign-label',
  'own-intersection',
  'composite-caption',
  'partial-caption-exclusion'
])('preserves the existing crop without a complete independent block: %s', async (fault) => {
  const f = await anonymousFramedForeignProcedureFigure(fault)
  try {
    expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeDefined()
    expect(crop(f)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it.each(['width', 'transform'])('requires original whole native %s closure', async (field) => {
  const f = await anonymousFramedForeignProcedureFigure()
  try {
    const source = f.context.content.items.find((r) => r.str === 'Procedure 3')
    const token = f.tokens.find((t) => t.text === 'Procedure 3')
    if (field === 'width') {
      source.width += 0.04
      token.rect[2] += 0.04
    } else {
      source.transform[4] += 0.04
      token.rect[0] += 0.04
      token.rect[2] += 0.04
    }
    expect(createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeDefined()
    expect(crop(f)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it.each(['source', 'glyph', 'operator', 'output'])(
  'withdraws an accepted plan after its original %s changes',
  async (field) => {
    const f = await anonymousFramedForeignProcedureFigure()
    try {
      const plan = crop(f)
      expect(plan).toBeDefined()
      const png = await renderPdfCrop(f.nativePage, plan.rect)
      expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
      if (field === 'source') {
        const i = f.context.content.items.findIndex((r) => r.str === 'Procedure 3')
        f.context.content.items[i] = { ...f.context.content.items[i] }
      } else if (field === 'glyph') {
        const glyph = f.context.operators.argsArray
          .flatMap((a) => (Array.isArray(a?.[0]) ? a[0] : []))
          .find((g) => g?.unicode === 'P')
        expect(glyph).toBeDefined()
        glyph.unicode = 'X'
      } else if (field === 'operator') {
        const i = f.context.operators.fnArray.findIndex((op) => op === OPS.constructPath)
        expect(i).toBeGreaterThanOrEqual(0)
        f.context.operators.argsArray[i] = f.context.operators.argsArray[i].slice()
      } else plan.rect[1] += 0.04
      expect(nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
    } finally {
      await f.cleanup()
    }
  }
)

it('withdraws derived paint data after a certified glyph is forged', async () => {
  const f = await anonymousFramedForeignProcedureFigure()
  try {
    const handle = createNativeFigurePaintCertificate(f.page, f.tokens, f.context)
    const data = nativeFigurePaintCertificateData(handle, f.page, f.tokens, f.context)
    expect(data).toBeDefined()
    data.pieces.find((p) => p.kind === 'glyph').text = 'Forged'
    expect(nativeFigurePaintCertificateData(handle, f.page, f.tokens, f.context)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it.each(['subset', 'mixed', 'clone', 'other', 'duplicate', 'fake-glyph', 'missing-glyph'])(
  'accepts only the exact complete previously excluded caption: %s',
  async (fault) => {
    const f = await anonymousFramedForeignProcedureFigure()
    try {
      const handle = createNativeFigurePaintCertificate(f.page, f.tokens, f.context)
      const data = nativeFigurePaintCertificateData(handle, f.page, f.tokens, f.context)
      expect(data).toBeDefined()
      const items = data.pieces.map((p, serial) => ({ ...p, serial, bound: p.rect }))
      const scope = data.scopes.find((s) => s.op === OPS.paintFormXObjectBegin)
      const own = items.filter(
        (p) => p.operationIndex > scope.begin && p.operationIndex < scope.end
      )
      const caption = items.filter((p) => p.kind === 'glyph' && p.operationIndex > scope.end)
      const picked = { kind: 'complete-native-saved-picture', own, excluded: caption }
      const valid = nativeFramedForeignProcedureTopCrop(
        data,
        items,
        picked,
        f.page,
        f.figure,
        f.context,
        f.figure.rect,
        f.captions
      )
      expect(valid).toBeDefined()
      expect(valid.excluded.slice(0, caption.length).every((p, i) => p === caption[i])).toBe(true)
      expect(valid.excluded).toHaveLength(caption.length + 1)
      if (fault === 'subset') picked.excluded = caption.slice(1)
      else if (fault === 'mixed') picked.excluded = [items[0], ...caption.slice(1)]
      else if (fault === 'clone') picked.excluded = caption.map((p) => ({ ...p }))
      else if (fault === 'other') picked.excluded = [items[0]]
      else if (fault === 'duplicate') picked.excluded = [...caption, caption[0]]
      let supplied = data
      if (fault === 'fake-glyph' || fault === 'missing-glyph') {
        const pieces = data.pieces.slice()
        const i = pieces.findIndex((p) => p.kind === 'glyph')
        if (fault === 'fake-glyph') pieces[i] = { ...pieces[i], text: 'Forged' }
        else pieces.splice(i, 1)
        supplied = { ...data, pieces }
      }
      expect(
        nativeFramedForeignProcedureTopCrop(
          supplied,
          items,
          picked,
          f.page,
          f.figure,
          f.context,
          f.figure.rect,
          f.captions
        )
      ).toBeUndefined()
      expect(nativeFigurePaintCertificateData(handle, f.page, f.tokens, f.context)).toBe(data)
    } finally {
      await f.cleanup()
    }
  }
)
