import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousCaptionLane } = await import(
  pathToFileURL(resolve('test/fixtures/native-caption-lane.mjs')).href
)
const { recoverNativeCaptionLane } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
it('completes a whole native caption lane only after its actual raster closes', async () => {
  const f = anonymousCaptionLane()
  const out = await recoverNativeCaptionLane(f.args)
  expect(out?.lines).toEqual(f.args.page.lines.map((l: { text: string }) => l.text))
  expect(out?.rect).toEqual([60, 290, 260, 329])
  expect(f.args.candidate.lines).toHaveLength(2)
})
it.each([
  'font',
  'source',
  'duplicate-source',
  'competing-caption',
  'competing-anchor',
  'unclosed',
  'continuation',
  'sha',
  'size',
  'foreign-owner'
])('refuses an incomplete caption certificate: %s', async (mode) => {
  const f = anonymousCaptionLane(),
    a = f.args
  if (mode === 'font') a.context.glyphBounds = []
  if (mode === 'source') a.tokens[0].text += 'x'
  if (mode === 'duplicate-source') a.tokens.push({ ...a.tokens[0] })
  if (mode === 'competing-caption') a.otherCaptions.push({ ...a.candidate })
  if (mode === 'competing-anchor') a.anchors.push({ ...a.anchors[0] })
  if (mode === 'unclosed') a.page.lines[2].text = 'unfinished caption'
  if (mode === 'continuation')
    a.page.lines.push({ ...a.page.lines[2], y: 332, text: 'continued prose', width: 90 })
  if (mode === 'sha') a.raster.sha256 = 'b'.repeat(64)
  if (mode === 'size') a.raster.width--
  if (mode === 'foreign-owner') a.anchors[0].sourceItems = [a.tokens[0].sourceItem]
  expect(await recoverNativeCaptionLane(a)).toBeUndefined()
})
it.each([
  'content',
  'glyphs',
  'operators',
  'transform',
  'converter',
  'caption',
  'anchor',
  'raster',
  'png'
])('rejects equal-value reference replacement or mutation during PNG loading: %s', async (mode) => {
  const f = anonymousCaptionLane(),
    a = f.args,
    load = a.loadPng
  a.loadPng = async (): Promise<Uint8Array> => {
    if (mode === 'content') a.context.content = { ...a.context.content }
    if (mode === 'glyphs') a.context.glyphBounds = [...a.context.glyphBounds]
    if (mode === 'operators') a.context.operators = { ...a.context.operators }
    if (mode === 'transform') a.context.viewport.transform = [...a.context.viewport.transform]
    if (mode === 'converter')
      a.context.viewport.convertToViewportPoint = (x: number, y: number): number[] => [x, 400 - y]
    if (mode === 'caption') a.candidate.lines = [...a.candidate.lines]
    if (mode === 'anchor') a.anchors[0].rect = [...a.anchors[0].rect]
    if (mode === 'raster') a.raster.width--
    if (mode === 'png') f.png[100] ^= 1
    return load()
  }
  expect(await recoverNativeCaptionLane(a)).toBeUndefined()
})
const { anonymousThreeRailTable } = await import(
  pathToFileURL(resolve('test/fixtures/native-caption-lane.mjs')).href
)
const { recoverNativeClosedTableBorder } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-caption-lane.mjs')).href
)
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const { nativeClosedProgramInkPacket } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
it('separates adjacent native caption baselines bridged by complete subscript and superscript sources', async () => {
  const rows: (string | number)[][] = [
    ['Figure 1: A complete native picture with', 60, 300],
    ['mixed font styles in the description and', 60, 314]
  ]
  for (let i = 0; i < 35; i++)
    rows.push(i === 17 ? ['H', 60 + i * 5, 330.5, 7.6] : ['a', 60 + i * 5, 328])
  for (let i = 0; i < 35; i++)
    rows.push(i === 14 ? ['2', 60 + i * 5, 338, 7.6] : ['a', 60 + i * 5, 342])
  rows.push(['.', 235, 342])
  const f = anonymousCaptionLane(rows)
  expect(
    nativeClosedProgramInkPacket(
      f.args.page,
      f.args.tokens,
      f.args.context,
      f.args.tokens.map((t: { sourceItem: unknown }) => t.sourceItem)
    )
  ).toBeUndefined()
  const out = await recoverNativeCaptionLane(f.args)
  expect(out?.lines).toHaveLength(4)
  expect(out?.lines[2].replace(/\s/gu, '')).toBe('a'.repeat(17) + 'H' + 'a'.repeat(17))
  expect(out?.lines[3].replace(/\s/gu, '')).toBe('a'.repeat(14) + '2' + 'a'.repeat(20) + '.')
})
it('retains the model frame and whole cell sources when completing visible three-rail stroke ink', async () => {
  const f = anonymousThreeRailTable(),
    before = JSON.stringify(f.args.table)
  const out = await recoverNativeClosedTableBorder(f.args)
  expect(out?.region).toEqual(f.rect.map((n: number) => n / 400))
  expect(out?.png).toEqual(f.png)
  expect(JSON.stringify(f.args.table)).toBe(before)
})
it.each(['edge', 'cap', 'alpha', 'source', 'foreign-paint', 'color', 'await-reference', 'png'])(
  'refuses an unclosed stroke crop: %s',
  async (mode) => {
    const f = anonymousThreeRailTable(),
      a = f.args,
      o = a.context.operators,
      at = o.fnArray.indexOf(OPS.constructPath)
    if (mode === 'edge') {
      o.fnArray.push(o.fnArray[at])
      o.argsArray.push(structuredClone(o.argsArray[at]))
    }
    if (mode === 'cap') {
      o.fnArray.splice(at, 0, OPS.setLineCap)
      o.argsArray.splice(at, 0, [1])
    }
    if (mode === 'alpha') {
      o.fnArray.splice(at, 0, OPS.setGState)
      o.argsArray.splice(at, 0, [[['CA', 0.5]]])
    }
    if (mode === 'source') a.table.cells[0].sourceItems = []
    if (mode === 'foreign-paint') {
      o.fnArray.push(OPS.constructPath)
      o.argsArray.push([
        OPS.fill,
        [new Float32Array([0, 100, 200, 1, 110, 200, 1, 110, 210, 1, 100, 210, 4])],
        new Float32Array([100, 200, 110, 210])
      ])
    }
    if (mode === 'color') {
      o.fnArray.splice(at, 0, OPS.setStrokeRGBColor)
      o.argsArray.splice(at, 0, ['#ffffff'])
    }
    if (mode === 'await-reference')
      a.renderCrop = async (): Promise<Uint8Array> => {
        a.table.cells = [...a.table.cells]
        return f.png
      }
    if (mode === 'png') a.renderCrop = async (): Promise<Uint8Array> => new Uint8Array()
    expect(await recoverNativeClosedTableBorder(a)).toBeUndefined()
  }
)
it('keeps a previously complete wrapped caption separate from following prose', async () => {
  const f = anonymousCaptionLane()
  f.args.candidate.lines[1] += '.'
  expect(await recoverNativeCaptionLane(f.args)).toBeUndefined()
})
it('retains the owned-compound and unknown-font refusals', async () => {
  const f = anonymousCaptionLane()
  const at = f.args.context.operators.fnArray.indexOf(OPS.showText)
  f.args.context.operators.argsArray[at][0][0].accent = {
    fontChar: 'accent',
    offset: { x: 0, y: 0 }
  }
  expect(await recoverNativeCaptionLane(f.args)).toBeUndefined()
})
it('refuses a geometry caption row whose characters agree but native word order differs', async () => {
  const f = anonymousCaptionLane()
  f.args.page.lines[2].text = 'caption a closed.'
  expect(await recoverNativeCaptionLane(f.args)).toBeUndefined()
})
it('refuses two complete native sources with the same ambiguous row start', async () => {
  const f = anonymousCaptionLane()
  f.text('a.', 60, 328)
  f.args.page.lines[2].text += 'a.'
  expect(await recoverNativeCaptionLane(f.args)).toBeUndefined()
})
const { nativeCaptionLaneAnchors } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-caption-lane.mjs')).href
)
it('retains a single native model frame and its original owner without changing table data', () => {
  const f = anonymousThreeRailTable(),
    table = f.args.table,
    before = JSON.stringify(table)
  const anchors = nativeCaptionLaneAnchors(f.args.page, [table], [], [])
  expect(anchors).toHaveLength(1)
  expect(anchors[0].rect).toEqual(table.cropRect.map((n: number) => n / table.sourceViewport.scale))
  expect(anchors[0].sourceItems).toEqual(
    table.cells.flatMap((c: { sourceItems: unknown[] }) => c.sourceItems)
  )
  expect(anchors[0].sourceOwner).toBe(table)
  expect(JSON.stringify(table)).toBe(before)
})
it.each([
  'multipart-no-crop',
  'multipart-with-crop',
  'image-only',
  'empty-crop',
  'short-crop',
  'nan-crop',
  'reversed-crop',
  'zero-scale',
  'infinite-scale',
  'wrong-frame',
  'invalid-cells'
])('abstains from an unsupported caption body anchor while retaining its data: %s', (mode) => {
  const f = anonymousThreeRailTable(),
    table = f.args.table
  if (mode === 'multipart-no-crop') {
    table.cropRects = [
      [30, 60, 100, 150],
      [100, 60, 300, 150]
    ]
    delete table.cropRect
  }
  if (mode === 'multipart-with-crop') table.parts = [{ cropRect: [30, 60, 100, 150] }]
  if (mode === 'image-only') {
    delete table.cropRect
    table.region = [0.1, 0.1, 0.5, 0.5]
  }
  if (mode === 'empty-crop') table.cropRect = []
  if (mode === 'short-crop') table.cropRect = [1, 2, 3]
  if (mode === 'nan-crop') table.cropRect[0] = NaN
  if (mode === 'reversed-crop') table.cropRect = [300, 150, 30, 60]
  if (mode === 'zero-scale') table.sourceViewport.scale = 0
  if (mode === 'infinite-scale') table.sourceViewport.scale = Infinity
  if (mode === 'wrong-frame') table.sourceViewport.width--
  if (mode === 'invalid-cells') table.cells = {}
  const before = JSON.stringify(table)
  expect(nativeCaptionLaneAnchors(f.args.page, [table], [], [])).toEqual([])
  expect(JSON.stringify(table)).toBe(before)
})
it('binds the original figure owner through caption PNG loading', async () => {
  const f = anonymousCaptionLane(),
    body = f.args.anchors[0],
    figure = {
      page: 1,
      caption: body.caption,
      region: body.rect.map((n: number) => n / 400)
    }
  f.args.anchors = nativeCaptionLaneAnchors(f.args.page, [], [figure], [])
  const load = f.args.loadPng
  f.args.loadPng = async (): Promise<Uint8Array> => {
    figure.region = [...figure.region]
    return load()
  }
  expect(await recoverNativeCaptionLane(f.args)).toBeUndefined()
})
