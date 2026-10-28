import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousRasterSubcaptions, anonymousDualApiRaster } = await import(
  pathToFileURL(resolve('test/fixtures/ordered-raster-subcaptions.mjs')).href
)
const { nativeOrderedRasterSubcaptionCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-ordered-raster-subcaptions.mjs'))
    .href
)
const { nativePageTextPacketInventory, nativePageTextPacketInventoryWithDualApiCertificate } =
  await import(
    pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
  )
const { attachNativeDualApiEvidence, matchNativeFigureRenderContext } = await import(
  pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href
)
const { addAnonymousUnclaimedFigureGlyph } = await import(
  pathToFileURL(resolve('test/fixtures/closed-save-figure.mjs')).href
)
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')

it.each(['normal', 'underline'])(
  'owns the complete ordered %s raster subcaption without changing literals',
  (mode) => {
    const f = anonymousRasterSubcaptions(mode),
      before = JSON.stringify(f),
      out = nativeOrderedRasterSubcaptionCrop(...f.args)
    expect(out?.rect).toEqual([40, 50, 340, 188])
    expect(out?.sourceItems).toEqual(
      f.args[5].content.items.slice(0, 4).map((r: { sourceItem: unknown }) => r.sourceItem)
    )
    expect(out?.formCropRaster.ownedRects).toHaveLength(mode === 'normal' ? 6 : 7)
    expect(JSON.stringify(f)).toBe(before)
  }
)
it.each([
  'foreign',
  'duplicate-marker',
  'metrics',
  'literal-mismatch',
  'opaque-binding',
  'table',
  'caption',
  'alpha',
  'incomplete-caption',
  'painted-space',
  'extra-image',
  'shared-glyph',
  'white-underline',
  'shifted-underline-payload',
  'bad-underline-bound'
])('refuses incomplete raster ownership: %s', (mode) => {
  const f = anonymousRasterSubcaptions(mode),
    before = JSON.stringify(f)
  expect(nativeOrderedRasterSubcaptionCrop(...f.args)).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
it('does not create ownership for a whole record absent from the caller token inventory', () => {
  const f = anonymousRasterSubcaptions()
  f.args[4].splice(1, 1)
  expect(nativeOrderedRasterSubcaptionCrop(...f.args)).toBeUndefined()
})
it.each([
  ['valid', false, false, true],
  ['missing metrics', false, true, false],
  ['invisible', true, true, true]
])(
  'accounts for every foreign whitespace glyph: %s',
  (_name, emptyOutline, missingMetrics, accepted) => {
    const f = anonymousRasterSubcaptions()
    addAnonymousUnclaimedFigureGlyph(f, { x: 360, emptyOutline, missingMetrics })
    expect(!!nativeOrderedRasterSubcaptionCrop(...f.args)).toBe(accepted)
  }
)
type CertifiedRaster = ReturnType<typeof anonymousDualApiRaster> & {
  snapshot: ReturnType<typeof attachNativeDualApiEvidence>
  context: ReturnType<typeof matchNativeFigureRenderContext>
  args: ReturnType<typeof anonymousRasterSubcaptions>['args']
}
function certified(mode = 'normal'): CertifiedRaster {
  const f = anonymousDualApiRaster(mode),
    snapshot = attachNativeDualApiEvidence(f.bareSnapshot, f.defaultContent, f.rawContent),
    context = matchNativeFigureRenderContext(
      snapshot,
      1,
      f.defaultContent,
      f.fixture.args[5].viewport,
      f.bareSnapshot.graphicsBounds,
      f.bareSnapshot.sourceSha256
    )
  expect(context).toBeDefined()
  f.fixture.args[5] = { ...context, pageNumber: 1, sourceSha256: f.bareSnapshot.sourceSha256 }
  return { ...f, snapshot, context: f.fixture.args[5], args: f.fixture.args }
}
it('captures null-prototype live API styles as snapshots while all default APIs remain strict', () => {
  const f = certified(),
    [page, , , , tokens, c] = f.args,
    e = c.dualApiEvidence
  expect(Object.getPrototypeOf(f.defaultContent.styles)).toBeNull()
  expect(Object.getPrototypeOf(e.defaultContent.styles)).toBe(Object.prototype)
  expect(e.defaultContent.items.at(-1).str).toBe('μ')
  expect(e.rawContent.items.at(-1).str).toBe('µ')
  expect(nativePageTextPacketInventory(page, tokens, c, true)).toBeUndefined()
  expect(nativeOrderedRasterSubcaptionCrop(...f.args)).toBeUndefined()
  expect(
    nativePageTextPacketInventoryWithDualApiCertificate(page, tokens, c, e, true)
  ).toBeDefined()
  expect(nativeOrderedRasterSubcaptionCrop(...f.args, e)?.sourceItems).toHaveLength(4)
  expect(e.renderContext.operators).not.toBe(c.operators)
  expect(e.defaultContent).not.toBe(f.defaultContent)
})
it.each([
  'missing',
  'reversed',
  'other-unicode',
  'wrong-options',
  'wrong-page',
  'wrong-source',
  'wrong-version',
  'wrong-width',
  'wrong-font',
  'wrong-image-id',
  'wrong-operator',
  'missing-font',
  'changed-style'
])('refuses a broken explicit dual-API certificate: %s', (mode) => {
  const f = certified(),
    [page, , , , tokens, c] = f.args
  let e = structuredClone(c.dualApiEvidence)
  if (mode === 'missing') e = undefined
  if (mode === 'reversed') [e.defaultContent, e.rawContent] = [e.rawContent, e.defaultContent]
  if (mode === 'other-unicode') e.rawContent.items.at(-1).str = 'u'
  if (mode === 'wrong-options') e.apiRawOptions = { disableNormalization: false }
  if (mode === 'wrong-page') e.pageNumber = 2
  if (mode === 'wrong-source') e.sourceSha256 = '2'.repeat(64)
  if (mode === 'wrong-version') e.pdfjsVersion = '0.0.0'
  if (mode === 'wrong-width') e.rawContent.items.at(-1).width += 1
  if (mode === 'wrong-font') e.rawContent.items.at(-1).fontName = 'other'
  if (mode === 'wrong-image-id')
    c.operators.argsArray[c.opaqueRasterImages[0].operationIndex][0] = 'other'
  if (mode === 'wrong-operator') c.operators.fnArray[0] = OPS.dependency
  if (mode === 'missing-font') c.glyphBounds = []
  if (mode === 'changed-style') e.rawContent.styles.F.ascent = 0.8
  expect(
    nativePageTextPacketInventoryWithDualApiCertificate(page, tokens, c, e, true)
  ).toBeUndefined()
  expect(nativeOrderedRasterSubcaptionCrop(...f.args, e)).toBeUndefined()
})
it.each(['shared-glyph', 'split-pair-glyph'])(
  'refuses cross-record physical glyph claims in an explicit packet: %s',
  (mode) => {
    const f = certified(mode),
      [p, , , , t, c] = f.args
    expect(
      nativePageTextPacketInventoryWithDualApiCertificate(p, t, c, c.dualApiEvidence, true)
    ).toBeUndefined()
  }
)
it('keeps a missing or excessive evidence request from displacing the original bounded snapshot', () => {
  const f = anonymousDualApiRaster(),
    s = f.bareSnapshot
  expect(attachNativeDualApiEvidence(s, f.defaultContent, undefined)).toBe(s)
  const huge = structuredClone(f.defaultContent)
  huge.items[0].str = 'x'.repeat(9 * 1024 * 1024)
  expect(attachNativeDualApiEvidence(s, huge, f.rawContent)).toBe(s)
})
it('uses an independent render snapshot so caller mutation cannot rewrite its binding', () => {
  const f = certified(),
    e = f.context.dualApiEvidence,
    before = JSON.stringify(e)
  f.context.opaqueRasterImages[0].width = 17
  expect(JSON.stringify(e)).toBe(before)
  expect(nativeOrderedRasterSubcaptionCrop(...f.args, e)).toBeUndefined()
})
it.each([
  ['inside crop', 70, false, false],
  ['outside crop in panel interval', 360, true, false],
  ['exact empty outline', 360, true, true]
])('accounts for empty-Unicode paint: %s', (_name, x, moveInside, emptyOutline) => {
  const f = anonymousRasterSubcaptions(),
    c = f.args[5],
    o = c.operators
  addAnonymousUnclaimedFigureGlyph(f, { text: '', x, emptyOutline })
  if (moveInside) {
    const at = c.opaqueRasterImages[1].operationIndex - 2,
      fs = o.fnArray.splice(-5),
      as = o.argsArray.splice(-5)
    o.fnArray.splice(at, 0, ...fs)
    o.argsArray.splice(at, 0, ...as)
    for (const g of c.graphicsBounds) if (g.operationIndex >= at) g.operationIndex += 5
    for (const g of c.opaqueRasterImages) if (g.operationIndex >= at) g.operationIndex += 5
  }
  expect(!!nativeOrderedRasterSubcaptionCrop(...f.args)).toBe(emptyOutline)
})
it('preserves canonical multicharacter source ownership inside one physical glyph', () => {
  const f = anonymousDualApiRaster(),
    n = 1,
    old = f.bareSnapshot.content.items[n].str
  f.bareSnapshot.content.items[n].str = 'A\u030a'
  f.defaultContent.items[n].str = 'A\u030a'
  f.rawContent.items[n].str = 'A\u030a'
  for (const args of f.bareSnapshot.operators.argsArray)
    if (args?.[0]?.[0]?.unicode === old) args[0][0].unicode = 'Å'
  f.fixture.args[4][n].text = 'A\u030a'
  f.fixture.args[4][n].sourceItem.text = 'A\u030a'
  const snapshot = attachNativeDualApiEvidence(f.bareSnapshot, f.defaultContent, f.rawContent),
    context = matchNativeFigureRenderContext(
      snapshot,
      1,
      f.defaultContent,
      f.fixture.args[5].viewport,
      f.bareSnapshot.graphicsBounds,
      f.bareSnapshot.sourceSha256
    )
  f.fixture.args[5] = { ...context, pageNumber: 1, sourceSha256: f.bareSnapshot.sourceSha256 }
  const out = nativeOrderedRasterSubcaptionCrop(
    ...f.fixture.args,
    f.fixture.args[5].dualApiEvidence
  )
  expect(out?.sourceItems[1].text).toBe('A\u030a')
  expect(snapshot.dualApiEvidence.rawContent.items[n].str).toBe('A\u030a')
})
