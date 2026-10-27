import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousIsolatedForm } = await import(
  pathToFileURL(resolve('test/fixtures/isolated-form-figure.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { nativeIsolatedFormFigureCrop, nativeIsolatedFormPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-isolated-form.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const { createCanvas } = await import('@napi-rs/canvas')
const { nativePageTextPacketInventory } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { getInitialPdfCropRaster } = await import(
  pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
)
it('owns the complete isolated Form with its transparent paint while excluding the independent running header', () => {
  const f = anonymousIsolatedForm(),
    [page, , captions, tables, tokens, c] = f.args,
    result = associateFigures(page, captions, tables, [], [], tokens, c)
  expect(result).toHaveLength(1)
  expect(result[0]?.sourceItems).toEqual(
    c.content.items.slice(1, 3).map((r: { sourceItem: unknown }) => r.sourceItem)
  )
  expect(result[0]?.rect).toEqual([60, 70, 340, 260])
})
it.each(['disjoint-seed', 'caption-above', 'companion-path', 'companion-text', 'companion-table'])(
  'refuses an isolated Form association that would lose current-caption content: %s',
  (mode) => {
    const f = anonymousIsolatedForm(),
      [, figure, , tables, tokens, c] = f.args,
      o = c.operators
    if (mode === 'disjoint-seed') figure.rect = [40, 270, 360, 295]
    if (mode === 'caption-above') {
      const index = c.content.items.findIndex((r: { str: string }) =>
          r.str.startsWith('Figure 1:')
        ),
        shown = o.fnArray.findIndex(
          (op: number, i: number) =>
            op === OPS.showText && o.argsArray[i]?.[0]?.[0]?.unicode?.startsWith('Figure 1:')
        )
      c.content.items[index].transform[5] = o.argsArray[shown - 1][0][5] = 345
      tokens[index] = tableTextToken(c.content.items[index], c.viewport, 0)
      figure.caption.rect = [60, 45, 250, 57]
    }
    if (mode.startsWith('companion-')) figure.rect = [40, 20, 360, 295]
    if (mode === 'companion-path') {
      const shown = o.fnArray.findIndex(
          (op: number, i: number) =>
            op === OPS.showText && o.argsArray[i]?.[0]?.[0]?.unicode?.startsWith('Figure 1:')
        ),
        at = shown - 3
      o.fnArray.splice(at, 0, OPS.constructPath)
      o.argsArray.splice(at, 0, [
        OPS.fill,
        [[0, 40, 110, 1, 360, 110, 1, 360, 130, 1, 40, 130, 4]],
        [40, 110, 360, 130]
      ])
      c.graphicsBounds.push({
        operationIndex: at,
        kind: 'path',
        normalizedRect: [0.1, 0.675, 0.9, 0.725]
      })
    }
    if (mode === 'companion-text') f.text('Companion', 100, 285)
    if (mode === 'companion-table') tables.push([60, 270, 340, 290])
    const before = JSON.stringify(f.args)
    expect(nativeIsolatedFormFigureCrop(...f.args)).toBeUndefined()
    expect(JSON.stringify(f.args)).toBe(before)
  }
)
it('retains an independent column outside the detector, complete Form and caption lane', () => {
  const f = anonymousIsolatedForm()
  f.text('Side', 375, 285)
  expect(nativeIsolatedFormFigureCrop(...f.args)?.rect).toEqual([60, 70, 340, 260])
})
it('retains the default packet and initial optional raster budget while using the bounded final encoded certificate', () => {
  const f = anonymousIsolatedForm(),
    [page, , , , tokens, c] = f.args
  expect(nativePageTextPacketInventory(page, tokens, c, true)).toBeUndefined()
  const out = nativeIsolatedFormFigureCrop(...f.args),
    rect = out.rect.map((x: number, i: number) => x + (i < 2 ? -2 : 2)),
    png = createCanvas(
      Math.ceil((rect[2] - rect[0]) * 4),
      Math.ceil((rect[3] - rect[1]) * 4)
    ).toBuffer('image/png')
  expect(getInitialPdfCropRaster(rect, page)).toBeUndefined()
  expect(nativeIsolatedFormPngSafe(png, rect, page, out)).toBe(true)
})
it.each([
  'knockout',
  'nonisolated',
  'smask',
  'group-matrix',
  'bad-image-hash',
  'nonhex-image-hash',
  'wrong-clip',
  'missing-font',
  'owned-zero-metrics',
  'missing-source',
  'duplicate-source',
  'wrong-owner-literal',
  'foreign-body',
  'extra-caption',
  'table',
  'foreign-painted-space',
  'empty-unicode',
  'nan-alpha',
  'over-alpha',
  'open-form',
  'extra-form',
  'invisible-label',
  'white-label',
  'shared-glyph'
])('refuses incomplete isolated Form evidence: %s', (mode) => {
  const f = anonymousIsolatedForm(),
    [page, figure, captions, tables, tokens, c] = f.args,
    o = c.operators,
    group = o.argsArray[o.fnArray.indexOf(OPS.beginGroup)][0]
  if (mode === 'knockout') group.knockout = true
  if (mode === 'nonisolated') group.isolated = false
  if (mode === 'smask') group.smask = { subtype: 'Alpha' }
  if (mode === 'group-matrix') group.matrix = [1, 0, 0, 1, 0, 0]
  if (mode === 'bad-image-hash') c.graphicsBounds[0].imageHash = 'wrong'
  if (mode === 'nonhex-image-hash') c.graphicsBounds[0].imageHash = '_'.repeat(64)
  if (mode === 'wrong-clip') group.bbox[2] = 150
  if (mode === 'missing-font') delete c.content.styles.F.ascent
  if (mode === 'owned-zero-metrics') Object.assign(c.content.styles.F, { ascent: 0, descent: 0 })
  if (mode === 'missing-source') tokens.splice(1, 1)
  if (mode === 'duplicate-source') tokens.push({ ...tokens[1] })
  if (mode === 'wrong-owner-literal') tokens[1].sourceItem.text = 'Wrong'
  if (mode === 'foreign-body') f.text('Foreign paragraph', 80, 180)
  if (mode === 'extra-caption')
    captions.push({ page: 1, lines: ['Figure 1: Other'], rect: [60, 350, 200, 360] })
  if (mode === 'table') tables.push([100, 100, 200, 200])
  if (mode === 'foreign-painted-space' || mode === 'empty-unicode') {
    const shown = o.fnArray.indexOf(OPS.showText, o.fnArray.indexOf(OPS.showText) + 1)
    o.argsArray[shown][0].push({
      unicode: mode === 'empty-unicode' ? '' : ' ',
      fontChar: 'Unclaimed',
      width: 0,
      isInFont: true,
      isSpace: mode === 'foreign-painted-space'
    })
    c.glyphBounds[0].glyphs.push({ fontChar: 'Unclaimed', bounds: [0, -0.1, 0.5, 0.7] })
  }
  if (mode === 'nan-alpha' || mode === 'over-alpha')
    o.argsArray[o.fnArray.indexOf(OPS.setGState)][0][0][1] = mode === 'nan-alpha' ? NaN : 2
  if (mode === 'open-form') {
    const i = o.fnArray.indexOf(OPS.paintFormXObjectEnd)
    o.fnArray.splice(i, 1)
    o.argsArray.splice(i, 1)
  }
  if (mode === 'extra-form') {
    f.add(OPS.paintFormXObjectBegin, [null, null])
    f.add(OPS.paintFormXObjectEnd, null)
  }
  if (mode === 'invisible-label' || mode === 'white-label') {
    const i = o.fnArray.indexOf(OPS.beginText, o.fnArray.indexOf(OPS.endText) + 1)
    o.fnArray.splice(i, 0, mode === 'white-label' ? OPS.setFillRGBColor : OPS.setGState)
    o.argsArray.splice(i, 0, mode === 'white-label' ? ['#ffffff'] : [[['ca', 0]]])
  }
  if (mode === 'shared-glyph') {
    const i = o.fnArray.indexOf(OPS.showText, o.fnArray.indexOf(OPS.showText) + 1),
      g = o.argsArray[i][0][0]
    Object.assign(g, { unicode: 'AB', fontChar: 'Combined', width: 1000 })
    c.glyphBounds[0].glyphs.push({ fontChar: 'Combined', bounds: [0, -0.1, 1, 0.7] })
    const r = c.content.items[1]
    r.str = r.sourceItem.text = 'A'
    r.width = 10
    const other = structuredClone(r)
    other.str = other.sourceItem.text = 'B'
    c.content.items.splice(2, 0, other)
    tokens.length = 0
    for (const [index, item] of c.content.items.entries()) {
      item.sourceItem.index = index
      tokens.push(tableTextToken(item, c.viewport, 0))
    }
  }
  const before = JSON.stringify([page, figure, captions, tables, tokens, c])
  expect(nativeIsolatedFormFigureCrop(...f.args)).toBeUndefined()
  expect(JSON.stringify([page, figure, captions, tables, tokens, c])).toBe(before)
})
it('preserves the complete transparent overlay and excludes foreign zero-metric native glyphs by their real ink and advance', () => {
  const f = anonymousIsolatedForm(),
    [page, , , , tokens, c] = f.args,
    o = c.operators
  c.content.items[0].fontName = 'Foreign'
  o.argsArray[o.fnArray.indexOf(OPS.setFont)][0] = 'Foreign'
  c.content.styles.Foreign = { ascent: 0, descent: 0, vertical: false }
  c.glyphBounds.push({ fontName: 'Foreign', glyphs: [c.glyphBounds[0].glyphs[0]] })
  const before = JSON.stringify([page, tokens, c]),
    out = nativeIsolatedFormFigureCrop(...f.args)
  expect(out?.sourceItems).toHaveLength(2)
  expect(out?.graphicsCount).toBe(2)
  expect(o.argsArray[o.fnArray.indexOf(OPS.setGState)]).toEqual([
    [
      ['CA', 0.6],
      ['ca', 0.6]
    ]
  ])
  expect(JSON.stringify([page, tokens, c])).toBe(before)
})
it.each([
  'page-copy',
  'page-number',
  'rotation',
  'invalid-bounds',
  'token-text',
  'token-rect',
  'native-text',
  'group-clip',
  'alpha',
  'image-hash',
  'owners',
  'raster',
  'graphics-count'
])('binds final encoded raster protection to the whole unchanged invocation: %s', (mode) => {
  const f = anonymousIsolatedForm(),
    [page, , , , tokens, c] = f.args,
    out = nativeIsolatedFormFigureCrop(...f.args)
  expect(out).toBeDefined()
  const rect = out.rect.map((x: number, i: number) => x + (i < 2 ? -2 : 2)),
    png = createCanvas(
      Math.ceil((rect[2] - rect[0]) * 4),
      Math.ceil((rect[3] - rect[1]) * 4)
    ).toBuffer('image/png')
  expect(nativeIsolatedFormPngSafe(png, rect, page, { ...out })).toBe(true)
  let input = page
  if (mode === 'page-copy') input = { ...page }
  if (mode === 'page-number') page.pageNumber++
  if (mode === 'rotation') page.rotation = 90
  if (mode === 'invalid-bounds') page.invalidGraphicsBounds = 1
  if (mode === 'token-text') tokens[1].text = 'Other'
  if (mode === 'token-rect') tokens[1].rect[0]++
  if (mode === 'native-text') c.content.items[1].str = 'Other'
  if (mode === 'group-clip')
    c.operators.argsArray[c.operators.fnArray.indexOf(OPS.beginGroup)][0].bbox[0]++
  if (mode === 'alpha')
    c.operators.argsArray[c.operators.fnArray.indexOf(OPS.setGState)][0][0][1] = 0.5
  if (mode === 'image-hash') c.graphicsBounds[0].imageHash = 'b'.repeat(64)
  if (mode === 'owners') out.sourceItems.pop()
  if (mode === 'raster') out.formCropRaster.ownedRects[0][0]++
  if (mode === 'graphics-count') out.graphicsCount++
  expect(nativeIsolatedFormPngSafe(png, rect, input, out)).toBe(false)
})
it('rejects uncertified, malformed, over-budget or wrong-scale encoded PNGs', () => {
  const f = anonymousIsolatedForm(),
    out = nativeIsolatedFormFigureCrop(...f.args),
    rect = out.rect.map((x: number, i: number) => x + (i < 2 ? -2 : 2)),
    png = createCanvas(2400, 2400).toBuffer('image/png')
  expect(nativeIsolatedFormPngSafe(png, rect, f.args[0], out)).toBe(false)
  expect(nativeIsolatedFormPngSafe(new Uint8Array(), rect, f.args[0], out)).toBe(false)
  expect(nativeIsolatedFormPngSafe(new Uint8Array(4 * 1024 ** 2 + 1), rect, f.args[0], out)).toBe(
    false
  )
  expect(nativeIsolatedFormPngSafe(png, rect, f.args[0], JSON.parse(JSON.stringify(out)))).toBe(
    false
  )
})
