import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas } from '@napi-rs/canvas'

const { anonymousGroupedAxis } = await import(
  pathToFileURL(resolve('test/fixtures/grouped-symbol-axis.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { nativeGroupedSymbolAxisCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-symbol-axis.mjs')).href
)
const {
  nativePageTextPacketInventory,
  nativeTypedPlotPacketInventory,
  nativeGroupedAxisPacketInventory
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { nativeCompleteFormCropPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-complete-form.mjs')).href
)
const prove = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  nativeGroupedSymbolAxisCrop(f.args[0], f.figure, f.args[1], f.args[2], f.args[5], f.args[6])

it('retains the complete native symbol axis title below shorter numeric ticks on a grouped page', () => {
  const fixture = anonymousGroupedAxis(),
    [figure] = associateFigures(...fixture.args),
    title = fixture.args[5].find(
      (token: { sourceItem: { index: number } }) => token.sourceItem.index === fixture.title.index
    )
  expect(figure.rect).toBeDefined()
  expect(figure.rect[3]).toBeGreaterThanOrEqual(title.nativeLabelRect[3])
  expect(figure.sourceItems).toContainEqual(fixture.title)
  expect(figure.fallbackFigure.rect[3]).toBe(165)
  expect(figure.caption).toEqual(fixture.figure.caption)
})

it('preserves exact original streams and the old packet entry refusals', () => {
  const f = anonymousGroupedAxis(),
    a = f.args,
    before = JSON.stringify(a),
    result = prove(f)
  expect(result?.sourceItems).toEqual(
    a[6].content.items.slice(0, 4).map((r: { sourceItem: unknown }) => r.sourceItem)
  )
  expect(nativePageTextPacketInventory(a[0], a[5], a[6])).toBeUndefined()
  expect(
    nativeTypedPlotPacketInventory(a[0], f.figure, a[1], a[2], a[3], a[5], a[6])
  ).toBeUndefined()
  expect(JSON.stringify(a)).toBe(before)
})

it('normalizes only one-to-one unclaimed foreign literals without altering either original stream', () => {
  const f = anonymousGroupedAxis({ foreignUnicode: true }),
    a = f.args,
    before = JSON.stringify(a)
  expect(prove(f)).toBeDefined()
  const packet = nativeGroupedAxisPacketInventory(a[0], f.figure, a[1], a[2], a[3], a[5], a[6], [
    f.title
  ])
  expect(packet.records).toHaveLength(6)
  const foreign = packet.records.find((r: { index: number }) => r.index === 5)
  expect(foreign.r.str).toBe('μ')
  expect(foreign.part[0].g.text).toBe('µ')
  expect(foreign.foreignSourceNormalized).toBe(true)
  expect(JSON.stringify(a)).toBe(before)
  const claimed = anonymousGroupedAxis({ claimedUnicode: true })
  expect(prove(claimed)).toBeUndefined()
})

it.each([
  'owned font ascent',
  'foreign font descent',
  'foreign glyph outline',
  'source literal',
  'source advance',
  'missing type3 program',
  'vertical font',
  'title clipping',
  'nonisolated group',
  'knockout group',
  'masked group',
  'group matrix',
  'unmatched group',
  'caption crossing',
  'table crossing',
  'foreign image',
  'foreign path',
  'competing owner'
])('refuses incomplete group-axis ownership: %s', (kind) => {
  const f = anonymousGroupedAxis(),
    a = f.args,
    c = a[6],
    o = c.operators,
    group = o.fnArray.indexOf(OPS.beginGroup),
    end = o.fnArray.indexOf(OPS.endGroup),
    form = o.fnArray.findIndex(
      (op: number, i: number) => op === OPS.paintFormXObjectBegin && o.argsArray[i]?.[1] !== null
    )
  if (kind === 'owned font ascent') delete c.content.styles.T.ascent
  if (kind === 'foreign font descent') delete c.content.styles.G.descent
  if (kind === 'foreign glyph outline')
    c.partialFontGlyphBounds[1].glyphs.find(
      (g: { fontChar: string }) => g.fontChar === 'C'
    ).bounds[3] = 100
  if (kind === 'source literal') c.content.items[3].sourceItem.text = 'z'
  if (kind === 'source advance') c.content.items[3].width += 1
  if (kind === 'missing type3 program') c.type3GlyphPrograms[0].glyphs = []
  if (kind === 'vertical font') c.content.styles.T.vertical = true
  if (kind === 'title clipping') o.argsArray[form][1][1] = 130
  if (kind === 'nonisolated group') o.argsArray[group][0].isolated = false
  if (kind === 'knockout group') o.argsArray[group][0].knockout = true
  if (kind === 'masked group') o.argsArray[group][0].smask = { subtype: 'Alpha' }
  if (kind === 'group matrix') o.argsArray[group][0].matrix = [1, 0, 0, 1, 0, 0]
  if (kind === 'unmatched group')
    o.argsArray[end] = [{ ...o.argsArray[end][0], bbox: [10, 275, 40, 280] }]
  if (kind === 'caption crossing')
    a[1].push({ page: 1, lines: ['Other'], rect: [180, 175, 200, 185] })
  if (kind === 'table crossing') a[2].push([180, 175, 200, 185])
  if (kind === 'foreign path') {
    const index = o.fnArray.length
    o.fnArray.push(OPS.constructPath)
    o.argsArray.push([
      OPS.fill,
      [[0, 180, 125, 1, 200, 125, 1, 200, 115, 1, 180, 115, 4]],
      [180, 115, 200, 125]
    ])
    c.graphicsBounds.push({
      operationIndex: index,
      kind: 'path',
      normalizedRect: [180 / 400, 175 / 300, 200 / 400, 185 / 300]
    })
  }
  if (kind === 'foreign image') {
    const index = o.fnArray.length + 2
    o.fnArray.push(OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore)
    o.argsArray.push(null, [20, 0, 0, 10, 180, 115], ['foreign', 20, 10], null)
    c.graphicsBounds.push({
      operationIndex: index,
      kind: 'image',
      normalizedRect: [180 / 400, 175 / 300, 200 / 400, 185 / 300]
    })
  }
  expect(
    nativeGroupedSymbolAxisCrop(
      a[0],
      f.figure,
      a[1],
      a[2],
      a[5],
      c,
      () => kind === 'competing owner'
    )
  ).toBeUndefined()
})

it('requires the actual PNG footprint to retain complete native labels and exclude foreign paint', () => {
  const f = anonymousGroupedAxis(),
    candidate = prove(f),
    page = f.args[0],
    rect = [98.4, 38.4, 281.6, 187.6],
    png = (scale: number): Buffer =>
      createCanvas(
        Math.ceil((rect[2] - rect[0]) * scale),
        Math.ceil((rect[3] - rect[1]) * scale)
      ).toBuffer('image/png')
  expect(nativeCompleteFormCropPngSafe(png(4), rect, page, candidate)).toBe(true)
  expect(nativeCompleteFormCropPngSafe(png(0.5), rect, page, candidate)).toBe(false)
  expect(nativeCompleteFormCropPngSafe(Buffer.from('invalid'), rect, page, candidate)).toBe(false)
  const contaminated = structuredClone(candidate)
  contaminated.formCropRaster.foreignPaints.push({ rect: [180, 175, 200, 185], floor: 0 })
  expect(nativeCompleteFormCropPngSafe(png(4), rect, page, contaminated)).toBe(false)
})
