import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousOrderedFormRasters } = await import(
  pathToFileURL(resolve('test/fixtures/ordered-form-rasters.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { nativeOrderedFormRasterCrop, nativeOrderedFormRasterPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-ordered-form-rasters.mjs')).href
)
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const { createCanvas } = await import('@napi-rs/canvas')

it('recovers both complete ordered raster Forms and their whole subcaption sources through public association', () => {
  const f = anonymousOrderedFormRasters(),
    [page, , captions, tables, tokens, context] = f.args,
    result = associateFigures(page, captions, tables, [], [], tokens, context)
  expect(result).toHaveLength(1)
  expect(result[0]?.sourceItems).toEqual(
    context.content.items.slice(0, 4).map((r: { sourceItem: unknown }) => r.sourceItem)
  )
  expect(result[0]?.rect[1]).toBeLessThanOrEqual(45)
})

it.each([
  'open-form',
  'nested-form',
  'alpha',
  'missing-font',
  'missing-source',
  'duplicate-source',
  'literal',
  'wrong-image',
  'foreign',
  'table',
  'caption',
  'unclaimed-space',
  'empty-unicode',
  'group',
  'incomplete-caption'
])('rejects an incomplete ordered Form certificate: %s', (fault) => {
  const f = anonymousOrderedFormRasters(),
    [page, figure, captions, tables, tokens, c] = f.args,
    o = c.operators
  if (fault === 'open-form') {
    const i = o.fnArray.indexOf(OPS.paintFormXObjectEnd)
    o.fnArray.splice(i, 1)
    o.argsArray.splice(i, 1)
  }
  if (fault === 'nested-form') {
    o.fnArray.splice(2, 0, OPS.paintFormXObjectBegin)
    o.argsArray.splice(2, 0, [null, [0, 0, 400, 500]])
  }
  if (fault === 'alpha') {
    o.fnArray.unshift(OPS.setGState)
    o.argsArray.unshift([[['ca', 0.5]]])
  }
  if (fault === 'missing-font') delete c.content.styles.F.ascent
  if (fault === 'missing-source') tokens.splice(0, 1)
  if (fault === 'duplicate-source') tokens.push({ ...tokens[0] })
  if (fault === 'literal') tokens[0].text = 'Different'
  if (fault === 'wrong-image') c.opaqueRasterImages[0].imageId = 'wrong'
  if (fault === 'foreign') f.text('Independent body text', 80, 300)
  if (fault === 'table') tables.push([40, 200, 150, 250])
  if (fault === 'caption')
    captions.push({ page: 1, lines: ['Figure 2. Independent'], rect: [40, 200, 150, 250] })
  if (fault === 'group') {
    o.fnArray.unshift(OPS.beginGroup)
    o.argsArray.unshift([
      { isolated: true, knockout: false, smask: null, matrix: null, bbox: [0, 0, 400, 500] }
    ])
  }
  if (fault === 'incomplete-caption') figure.caption.lines[0] = 'Figure 1. Missing text.'
  if (fault === 'unclaimed-space' || fault === 'empty-unicode') {
    o.argsArray[o.fnArray.indexOf(OPS.showText)][0].push({
      unicode: fault === 'empty-unicode' ? '' : ' ',
      fontChar: 'Unclaimed',
      width: 0,
      isInFont: true,
      isSpace: fault === 'unclaimed-space'
    })
    c.glyphBounds[0].glyphs.push({ fontChar: 'Unclaimed', bounds: [0, -0.1, 0.5, 0.7] })
  }
  const before = JSON.stringify([page, figure, captions, tables, tokens, c])
  expect(nativeOrderedFormRasterCrop(...f.args)).toBeUndefined()
  expect(JSON.stringify([page, figure, captions, tables, tokens, c])).toBe(before)
})
it('preserves an already complete visible crop without adding claims just for their absence', () => {
  const f = anonymousOrderedFormRasters()
  f.args[1].rect = [30, 30, 370, 410]
  expect(nativeOrderedFormRasterCrop(...f.args)).toBeUndefined()
})
it.each([
  'page-copy',
  'page-number',
  'rotation',
  'invalid-bounds',
  'token-text',
  'token-rect',
  'native-text',
  'owners',
  'raster',
  'graphics-count'
])('binds the final encoded PNG to the same untouched native invocation: %s', (fault) => {
  const f = anonymousOrderedFormRasters(),
    [page, , , , tokens, c] = f.args,
    out = nativeOrderedFormRasterCrop(...f.args)
  expect(out).toBeDefined()
  const rect = out.rect.map((x: number, i: number) => x + (i < 2 ? -2 : 2)),
    png = createCanvas(
      Math.ceil((rect[2] - rect[0]) * 4),
      Math.ceil((rect[3] - rect[1]) * 4)
    ).toBuffer('image/png')
  expect(nativeOrderedFormRasterPngSafe(png, rect, page, out)).toBe(true)
  let input = page
  if (fault === 'page-copy') input = { ...page }
  if (fault === 'page-number') page.pageNumber++
  if (fault === 'rotation') page.rotation = 90
  if (fault === 'invalid-bounds') page.invalidGraphicsBounds = 1
  if (fault === 'token-text') tokens[0].text = 'Changed'
  if (fault === 'token-rect') tokens[0].rect[0]++
  if (fault === 'native-text') c.content.items[0].str = 'Changed'
  if (fault === 'owners') out.sourceItems.pop()
  if (fault === 'raster') out.formCropRaster.ownedRects[0][0]++
  if (fault === 'graphics-count') out.graphicsCount++
  expect(nativeOrderedFormRasterPngSafe(png, rect, input, out)).toBe(false)
})
it('refuses malformed or over-budget final PNG bytes and an uncertified outer object', () => {
  const f = anonymousOrderedFormRasters(),
    out = nativeOrderedFormRasterCrop(...f.args),
    rect = out.rect.map((x: number, i: number) => x + (i < 2 ? -2 : 2))
  expect(nativeOrderedFormRasterPngSafe(new Uint8Array(), rect, f.args[0], out)).toBe(false)
  expect(
    nativeOrderedFormRasterPngSafe(new Uint8Array(4 * 1024 ** 2 + 1), rect, f.args[0], out)
  ).toBe(false)
  expect(
    nativeOrderedFormRasterPngSafe(
      new Uint8Array(),
      rect,
      f.args[0],
      JSON.parse(JSON.stringify(out))
    )
  ).toBe(false)
})
