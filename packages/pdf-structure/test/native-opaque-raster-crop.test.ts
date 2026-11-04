import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const {
  nativeOpaqueRasterCrop,
  nativeIsolatedOpaqueRasterCrop,
  nativeIsolatedOpaqueRasterPngSafe,
  nativeIsolatedRasterImagePng,
  nativeIsolatedRasterCropMetadata
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-opaque-raster-crop.mjs')).href
)
const { anonymousIsolatedForm } = await import(
  pathToFileURL(resolve('test/fixtures/isolated-form-figure.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { createCanvas, Path2D, ImageData } = await import('@napi-rs/canvas')

const isolatedFixture = (): ReturnType<typeof JSON.parse> => {
  const f = anonymousIsolatedForm(),
    [page, , , , tokens, c] = f.args,
    o = c.operators,
    at = o.fnArray.indexOf(OPS.paintImageXObject),
    indexes = [
      ...Array.from({ length: 6 }, (_, i) => i),
      ...Array.from({ length: 4 }, (_, i) => at - 2 + i),
      ...Array.from({ length: 5 }, (_, i) => o.fnArray.length - 5 + i)
    ]
  o.fnArray = indexes.map((i) => o.fnArray[i])
  o.argsArray = indexes.map((i) => o.argsArray[i])
  c.content.items.splice(1, 2)
  c.content.items[1].sourceItem.index = 1
  tokens.splice(0, tokens.length, ...c.content.items.map((r) => tableTextToken(r, c.viewport, 0)))
  c.glyphBounds[0].glyphs = c.glyphBounds[0].glyphs.filter(
    (g) => !['Axis', 'Value'].includes(g.fontChar)
  )
  c.graphicsBounds[0].operationIndex = 8
  c.opaqueRasterImages = [{ operationIndex: 8, imageId: 'image', width: 100, height: 100, kind: 2 }]
  c.pageNumber = page.pageNumber
  c.sourceSha256 = 'a'.repeat(64)
  return f
}
const isolatedPng = (rect: number[]): Uint8Array => {
  const canvas = createCanvas(
    Math.ceil((rect[2] - rect[0]) * 4),
    Math.ceil((rect[3] - rect[1]) * 4)
  )
  try {
    return canvas.toBuffer('image/png')
  } finally {
    canvas.width = canvas.height = 0
  }
}
const pairedFixture = (): ReturnType<typeof JSON.parse> => {
  const f = isolatedFixture(),
    [page, figure, , , , c] = f.args
  c.operators.argsArray[7] = [110, 0, 0, 130, 70, 170]
  c.graphicsBounds[0].normalizedRect = [70 / 400, 100 / 400, 180 / 400, 230 / 400]
  f.add(OPS.save, null)
  f.add(OPS.transform, [110, 0, 0, 130, 210, 170])
  const operationIndex = c.operators.fnArray.length
  f.add(OPS.paintImageXObject, ['right', 100, 100])
  f.add(OPS.restore, null)
  page.graphicsBounds.push({
    kind: 'image',
    operationIndex,
    normalizedRect: [210 / 400, 100 / 400, 320 / 400, 230 / 400]
  })
  c.opaqueRasterImages.push({ operationIndex, imageId: 'right', width: 100, height: 100, kind: 2 })
  f.text('(a) Alpha.', 75, 250)
  f.text('(b) Beta.', 215, 250)
  f.text('continued.', 215, 264)
  c.glyphBounds[0].glyphs = c.content.items.map((r) => ({
    fontChar: r.str,
    bounds: [0, -0.1, r.str.length * 0.5, 0.7]
  }))
  figure.rect = [60, 95, 330, 251]
  figure.issue = 'native-raster-side-by-side'
  return f
}
const liveFixture = (mode = ''): ReturnType<typeof JSON.parse> => {
  const f = mode === 'pair-reason' ? pairedFixture() : isolatedFixture(),
    [page, figure, , , tokens, c] = f.args
  if (mode === 'pair-reason') {
    figure.reason = figure.issue
    delete figure.issue
  }
  if (mode === 'cut') figure.rect = [75, 95, 325, 239]
  if (mode === 'nearby') {
    c.content.items[0].transform[5] = 300.9
    c.glyphBounds[0].glyphs[0].bounds[1] = 0
    c.operators.argsArray[3] = [[1, 0, 0, 1, 40, 300.9]]
    tokens[0] = tableTextToken(c.content.items[0], c.viewport, 0)
  }
  if (mode === 'missing') {
    const r = c.content.items[1]
    r.transform[5] = 140
    c.operators.argsArray[12] = [[1, 0, 0, 1, 60, 140]]
    tokens[1] = tableTextToken(r, c.viewport, 0)
    figure.caption.rect = [60, 250, 250, 262]
    delete figure.rect
    figure.issue = 'ambiguous-graphic-direction'
  }
  const pathIndex = c.operators.fnArray.length
  f.add(OPS.clip, null)
  f.add(OPS.constructPath, [
    OPS.endPath,
    [new Float32Array([0, 0, 0, 1, 400, 0, 1, 400, 400, 1, 0, 400, 4])],
    new Float32Array([0, 0, 400, 400])
  ])
  const operators = structuredClone(c.operators),
    pageContent = structuredClone(c.content)
  pageContent.styles = { Native: pageContent.styles.F }
  pageContent.items.forEach((r) => {
    r.fontName = 'Native'
  })
  let imageCount = 0
  operators.fnArray.forEach((op, i) => {
    if (op === OPS.setFont) operators.argsArray[i][0] = 'Native'
    if (op === OPS.paintImageXObject)
      operators.argsArray[i][0] = imageCount++ ? 'native-right' : 'native-image'
  })
  const data = new Uint8ClampedArray(40000)
  for (let i = 0; i < data.length; i += 4) data.set([20, 80, 120, 253], i)
  const image = { width: 100, height: 100, kind: 3, data, interpolate: false, ref: 'anonymous' },
    displayImage = { ...image, data: new Uint8ClampedArray(data) },
    images = new Map([
      ['native-image', image],
      ['display-image', displayImage]
    ]),
    display = structuredClone(operators),
    path = new Path2D()
  path.moveTo(0, 0)
  path.lineTo(400, 0)
  path.lineTo(400, 400)
  path.lineTo(0, 400)
  path.closePath()
  display.argsArray[pathIndex + 1][1][0] = path
  operators.fnArray.forEach((op, i) => {
    if (op !== OPS.paintImageXObject) return
    const id = operators.argsArray[i][0]
    display.argsArray[i][0] = id.replace('native-', 'display-')
    if (id === 'native-right') {
      images.set(id, { ...image, data: new Uint8ClampedArray(data) })
      images.set('display-right', { ...image, data: new Uint8ClampedArray(data) })
    }
  })
  const state = {
      onRender: undefined as (() => void) | undefined,
      foreignPaint: false,
      viewportOffset: 0
    },
    nativePage = {
      rotate: 0,
      objs: { get: (id: string) => images.get(id) },
      getViewport: ({ scale, offsetX = 0, offsetY = 0 }): object => ({
        width: page.width * scale,
        height: page.height * scale,
        scale,
        rotation: 0,
        transform: [
          scale,
          0,
          0,
          -scale,
          offsetX + state.viewportOffset,
          page.height * scale + offsetY
        ]
      }),
      render: (options): object => ({
        _internalRenderTask: { operatorList: display },
        promise: Promise.resolve().then(() => {
          const ctx = options.canvasContext,
            m = options.viewport.transform
          ctx.fillStyle = 'white'
          ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
          ctx.setTransform(...m)
          for (const graphic of c.graphicsBounds.filter((g) => g.kind === 'image')) {
            if (options.operationsFilter && !options.operationsFilter(graphic.operationIndex))
              continue
            const source = images.get(operators.argsArray[graphic.operationIndex][0]),
              bitmap = createCanvas(source.width, source.height),
              box = graphic.normalizedRect
            try {
              bitmap
                .getContext('2d')
                .putImageData(new ImageData(source.data, source.width, source.height), 0, 0)
              ctx.save()
              ctx.translate(box[0] * page.width, (1 - box[1]) * page.height)
              ctx.scale(
                ((box[2] - box[0]) * page.width) / source.width,
                (-(box[3] - box[1]) * page.height) / source.height
              )
              ctx.drawImage(bitmap, 0, 0)
              ctx.restore()
            } finally {
              bitmap.width = bitmap.height = 0
            }
          }
          if (state.foreignPaint && (!options.operationsFilter || options.operationsFilter(4))) {
            ctx.fillStyle = 'black'
            ctx.fillRect(85, 300.2, 3, 0.1)
          }
          state.onRender?.()
        })
      })
    }
  c.opaqueRasterImages = []
  f.args.push(figure.rect, { nativePage, pageContent, operators })
  return {
    ...f,
    nativePage,
    pageContent,
    operators,
    display,
    image,
    displayImage,
    images,
    path,
    state
  }
}
const resizeLiveOwner = (f, operationIndex: number, width: number, height: number): void => {
  for (const list of [f.args[5].operators, f.operators, f.display]) {
    list.argsArray[operationIndex][1] = width
    list.argsArray[operationIndex][2] = height
  }
  for (const id of [
    f.operators.argsArray[operationIndex][0],
    f.display.argsArray[operationIndex][0]
  ]) {
    const image = f.images.get(id),
      data = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < data.length; i += 4) data.set([20, 80, 120, 253], i)
    Object.assign(image, { width, height, data })
  }
}
it('binds ordinary RGBA bytes and display-intent resource identities without an opaque claim', async () => {
  const f = liveFixture(),
    out = nativeIsolatedOpaqueRasterCrop(...f.args)
  expect(out?.rect).toEqual([79.5, 99.5, 320.5, 240.5])
  expect(nativeIsolatedOpaqueRasterPngSafe(out, isolatedPng(out.rect), out.rect, f.args[0])).toBe(
    false
  )
  const png = await nativeIsolatedRasterImagePng(out, f.nativePage, out.rect, 0)
  expect(png).toBeTruthy()
  expect(nativeIsolatedOpaqueRasterPngSafe(out, png, out.rect, f.args[0])).toBe(true)
  expect(nativeIsolatedRasterCropMetadata(out, png, out.rect, f.args[0])).toBeUndefined()
})
it('publishes missing-image metadata only after its private live RGBA render is current', async () => {
  const f = liveFixture('missing'),
    out = nativeIsolatedOpaqueRasterCrop(...f.args)
  expect(out).toBeTruthy()
  expect(
    nativeIsolatedRasterCropMetadata(out, isolatedPng(out.rect), out.rect, f.args[0])
  ).toBeUndefined()
  const png = await nativeIsolatedRasterImagePng(out, f.nativePage, out.rect, 0)
  expect(nativeIsolatedRasterCropMetadata(out, png, out.rect, f.args[0])).toEqual({
    graphicsCount: 1,
    resolvedIssue: 'ambiguous-graphic-direction'
  })
  f.image.data[0]++
  expect(nativeIsolatedRasterCropMetadata(out, png, out.rect, f.args[0])).toBeUndefined()
})
it.each(['pair-reason', 'missing'])(
  'accepts the two native producer reason values without rewriting the candidate: %s',
  async (mode) => {
    const f = liveFixture(mode),
      figure = f.args[1]
    if (mode === 'missing') {
      figure.reason = figure.issue
      delete figure.issue
    }
    const before = JSON.stringify(f.args),
      out = nativeIsolatedOpaqueRasterCrop(...f.args)
    expect(out).toBeTruthy()
    const png = await nativeIsolatedRasterImagePng(out, f.nativePage, out.rect, 0)
    expect(png).toBeTruthy()
    expect(nativeIsolatedOpaqueRasterPngSafe(out, png, out.rect, f.args[0])).toBe(true)
    expect(JSON.stringify(f.args)).toBe(before)
  }
)
it.each(['unknown reason', 'conflicting issue', 'private raster flag', 'source claim'])(
  'does not grant a native producer reason additional authority: %s',
  (mode) => {
    const f = liveFixture('pair-reason'),
      figure = f.args[1]
    if (mode === 'unknown reason') figure.reason = 'other-native-reason'
    if (mode === 'conflicting issue') figure.issue = 'ambiguous-graphic-direction'
    if (mode === 'private raster flag') figure.formCropRaster = true
    if (mode === 'source claim') figure.sourceItems = [f.args[5].content.items[0].sourceItem]
    expect(nativeIsolatedOpaqueRasterCrop(...f.args)).toBeUndefined()
  }
)
it('retains two bounded image owners whose combined data exceeds the single-owner budget', async () => {
  const f = liveFixture('pair-reason')
  for (const graphic of f.args[5].graphicsBounds)
    resizeLiveOwner(f, graphic.operationIndex, 1100, 1000)
  const out = nativeIsolatedOpaqueRasterCrop(...f.args)
  expect(out).toBeTruthy()
  const png = await nativeIsolatedRasterImagePng(out, f.nativePage, out.rect, 0)
  expect(png).toBeTruthy()
  expect(nativeIsolatedOpaqueRasterPngSafe(out, png, out.rect, f.args[0])).toBe(true)
})
it.each(['single over 8 MiB', 'pair over 16 MiB'])(
  'rejects full native owner data outside the bounded image budget: %s',
  (mode) => {
    const f = liveFixture(mode.startsWith('pair') ? 'pair-reason' : '')
    for (const graphic of f.args[5].graphicsBounds)
      resizeLiveOwner(f, graphic.operationIndex, 1450, 1450)
    expect(nativeIsolatedOpaqueRasterCrop(...f.args)).toBeUndefined()
  }
)
it('recovers clipped own image paint when the preliminary association is already free of foreign prose', async () => {
  const f = liveFixture('cut'),
    out = nativeIsolatedOpaqueRasterCrop(...f.args)
  expect(out?.rect).toEqual([79.5, 99.5, 320.5, 240.5])
  expect(nativeIsolatedOpaqueRasterPngSafe(out, isolatedPng(out.rect), out.rect, f.args[0])).toBe(
    false
  )
  const png = await nativeIsolatedRasterImagePng(out, f.nativePage, out.rect, 0)
  expect(png).toBeTruthy()
  expect(nativeIsolatedOpaqueRasterPngSafe(out, png, out.rect, f.args[0])).toBe(true)
})
it('preserves an image whose bbox exceeds the published crop only through a white edge', async () => {
  const f = liveFixture('cut')
  for (const image of [f.image, f.displayImage]) image.data.fill(255, 90 * 100 * 4)
  const out = nativeIsolatedOpaqueRasterCrop(...f.args)
  expect(out).toBeTruthy()
  expect(await nativeIsolatedRasterImagePng(out, f.nativePage, out.rect, 0)).toBeUndefined()
  expect(nativeIsolatedOpaqueRasterPngSafe(out, isolatedPng(out.rect), out.rect, f.args[0])).toBe(
    false
  )
})
it.each([251, 253])(
  'does not treat a near-white image edge as missing visible contrast: %s',
  async (shade) => {
    const f = liveFixture('cut')
    for (const image of [f.image, f.displayImage]) {
      for (let i = 90 * 100 * 4; i < image.data.length; i += 4)
        image.data.set([shade, shade, shade, 255], i)
    }
    const out = nativeIsolatedOpaqueRasterCrop(...f.args)
    expect(out).toBeTruthy()
    expect(await nativeIsolatedRasterImagePng(out, f.nativePage, out.rect, 0)).toBeUndefined()
    expect(nativeIsolatedOpaqueRasterPngSafe(out, isolatedPng(out.rect), out.rect, f.args[0])).toBe(
      false
    )
  }
)
it('keeps a complete clean published image unchanged even when a producer seed is too short', () => {
  const f = liveFixture('cut')
  f.args[6] = [75, 95, 325, 245]
  expect(nativeIsolatedOpaqueRasterCrop(...f.args)).toBeUndefined()
})
it('seals an exact-image exception only when normal, clipped and image-only native renders agree', async () => {
  const f = liveFixture('nearby'),
    out = nativeIsolatedOpaqueRasterCrop(...f.args)
  expect(out).toBeTruthy()
  const png = await nativeIsolatedRasterImagePng(out, f.nativePage, out.rect, 0)
  expect(png).toBeTruthy()
  expect(nativeIsolatedOpaqueRasterPngSafe(out, png, out.rect, f.args[0])).toBe(true)
  const other = new Uint8Array(png)
  other[other.length - 1] ^= 1
  expect(nativeIsolatedOpaqueRasterPngSafe(out, other, out.rect, f.args[0])).toBe(false)
})
it('rejects a live page whose scale-one native viewport disagrees with the retained source', () => {
  const f = liveFixture()
  f.state.viewportOffset = 1
  expect(nativeIsolatedOpaqueRasterCrop(...f.args)).toBeUndefined()
})
it('rejects a crop render with a rotation different from its native evidence', async () => {
  const f = liveFixture(),
    out = nativeIsolatedOpaqueRasterCrop(...f.args)
  expect(out).toBeTruthy()
  expect(await nativeIsolatedRasterImagePng(out, f.nativePage, out.rect, 90)).toBeUndefined()
})
it.each(['interpolate', 'dataLen'])(
  'rejects different image sampling evidence across native intents: %s',
  async (key) => {
    const f = liveFixture(),
      out = nativeIsolatedOpaqueRasterCrop(...f.args)
    expect(out).toBeTruthy()
    f.displayImage[key] = key === 'interpolate' ? true : f.displayImage.data.byteLength
    expect(await nativeIsolatedRasterImagePng(out, f.nativePage, out.rect, 0)).toBeUndefined()
  }
)
it('rechecks viewport output when the native function identity remains unchanged', async () => {
  const f = liveFixture(),
    out = nativeIsolatedOpaqueRasterCrop(...f.args),
    png = await nativeIsolatedRasterImagePng(out, f.nativePage, out.rect, 0)
  expect(png).toBeTruthy()
  f.state.viewportOffset = 1
  expect(nativeIsolatedOpaqueRasterPngSafe(out, png, out.rect, f.args[0])).toBe(false)
})
it.each(['dimensions', 'kind', 'byte length', 'budget', 'font source', 'image op'])(
  'rejects incomplete live image evidence: %s',
  (mode) => {
    const f = liveFixture()
    if (mode === 'dimensions') f.image.width++
    if (mode === 'kind') f.image.kind = 1
    if (mode === 'byte length') f.image.data = new Uint8ClampedArray(3)
    if (mode === 'budget') {
      f.image.width = 3000
      f.image.height = 3000
      f.image.data = new Uint8ClampedArray(36000000)
    }
    if (mode === 'font source') f.pageContent.styles.Native.ascent = 0.1
    if (mode === 'image op') f.operators.argsArray[8][1]++
    expect(nativeIsolatedOpaqueRasterCrop(...f.args)).toBeUndefined()
  }
)
it.each([
  'wrong path geometry',
  'path own method',
  'path own field',
  'different display bytes',
  'foreign pixels',
  'late bytes',
  'equal image slot',
  'equal operator slot',
  'late viewport'
])('rejects failed live render proof: %s', async (mode) => {
  const f = liveFixture('nearby'),
    out = nativeIsolatedOpaqueRasterCrop(...f.args)
  expect(out).toBeTruthy()
  if (mode === 'wrong path geometry') f.path.lineTo(1, 1)
  if (mode === 'path own method') f.path.equals = () => true
  if (mode === 'path own field') f.path.extra = true
  if (mode === 'different display bytes') f.displayImage.data[0]++
  if (mode === 'foreign pixels') f.state.foreignPaint = true
  if (mode === 'late bytes')
    f.state.onRender = () => {
      f.image.data[0]++
    }
  if (mode === 'equal image slot')
    f.state.onRender = () => {
      f.image.data = new Uint8ClampedArray(f.image.data)
    }
  if (mode === 'equal operator slot')
    f.state.onRender = () => {
      f.operators.argsArray[8] = [...f.operators.argsArray[8]]
    }
  if (mode === 'late viewport')
    f.state.onRender = () => {
      f.state.viewportOffset = 1
    }
  expect(await nativeIsolatedRasterImagePng(out, f.nativePage, out.rect, 0)).toBeUndefined()
})
it.each([
  'path geometry',
  'equal cache slot',
  'typed path bytes',
  'display image slot',
  'source bytes'
])(
  'invalidates a sealed live image after a same-reference or equal-value change: %s',
  async (mode) => {
    const f = liveFixture(),
      out = nativeIsolatedOpaqueRasterCrop(...f.args),
      png = await nativeIsolatedRasterImagePng(out, f.nativePage, out.rect, 0)
    expect(png).toBeTruthy()
    if (mode === 'path geometry') f.path.lineTo(2, 2)
    if (mode === 'equal cache slot') f.display.argsArray.at(-1)[1][0] = new Path2D(f.path)
    if (mode === 'typed path bytes') f.operators.argsArray.at(-1)[1][0][1]++
    if (mode === 'display image slot')
      f.displayImage.data = new Uint8ClampedArray(f.displayImage.data)
    if (mode === 'source bytes') f.pageContent.items[0].str = 'Changed'
    expect(nativeIsolatedOpaqueRasterPngSafe(out, png, out.rect, f.args[0])).toBe(false)
  }
)
it('keeps the complete foreign inventory on a dense page without granting Source claims', () => {
  const f = isolatedFixture(),
    c = f.args[5]
  for (let n = 0; n < 70; n++) f.text(`Aside ${n}`, 20, 370)
  c.glyphBounds[0].glyphs = c.content.items.map((r) => ({
    fontChar: r.str,
    bounds: [0, -0.1, r.str.length * 0.5, 0.7]
  }))
  const out = nativeIsolatedOpaqueRasterCrop(...f.args)
  expect(out?.rect).toEqual([79.5, 99.5, 320.5, 240.5])
  expect(Object.keys(out)).toEqual(['rect'])
  expect(nativeIsolatedOpaqueRasterPngSafe(out, isolatedPng(out.rect), out.rect, f.args[0])).toBe(
    true
  )
  c.glyphBounds[0].glyphs.pop()
  expect(nativeIsolatedOpaqueRasterCrop(...f.args)).toBeUndefined()
})
it('includes both whole subcaptions of an opaque image pair without claiming their text', () => {
  const f = pairedFixture(),
    before = JSON.stringify(f.args),
    out = nativeIsolatedOpaqueRasterCrop(...f.args)
  expect(out?.rect).toEqual([69.5, 99.5, 320.5, 265.5])
  expect(Object.keys(out)).toEqual(['rect'])
  expect(nativeIsolatedOpaqueRasterPngSafe(out, isolatedPng(out.rect), out.rect, f.args[0])).toBe(
    true
  )
  expect(JSON.stringify(f.args)).toBe(before)
})
it('preserves an already complete published crop even when the preliminary association cuts a label', () => {
  const f = pairedFixture()
  expect(nativeIsolatedOpaqueRasterCrop(...f.args, [60, 95, 330, 270])).toBeUndefined()
})
it.each([
  'complete crop',
  'third image',
  'missing label',
  'wrong marker',
  'unknown glyph',
  'table',
  'caption halo'
])('declines an unproved or already complete paired crop: %s', (mode) => {
  const f = pairedFixture(),
    [page, figure, , tables, , c] = f.args
  if (mode === 'complete crop') figure.rect[3] = 270
  if (mode === 'third image') {
    f.add(OPS.save, null)
    f.add(OPS.transform, [20, 0, 0, 20, 190, 180])
    const operationIndex = c.operators.fnArray.length
    f.add(OPS.paintImageXObject, ['third', 100, 100])
    f.add(OPS.restore, null)
    page.graphicsBounds.push({
      kind: 'image',
      operationIndex,
      normalizedRect: [0.475, 0.5, 0.525, 0.55]
    })
    c.opaqueRasterImages.push({
      operationIndex,
      imageId: 'third',
      width: 100,
      height: 100,
      kind: 2
    })
  }
  if (mode === 'missing label') c.content.items[2].str = ''
  if (mode === 'wrong marker') c.content.items[2].str = '(c) Alpha.'
  if (mode === 'unknown glyph') c.glyphBounds[0].glyphs.pop()
  if (mode === 'table') tables.push([80, 100, 320, 240])
  if (mode === 'caption halo')
    c.glyphBounds[0].glyphs.find((g) => g.fontChar.startsWith('Figure')).bounds[3] = 8
  expect(nativeIsolatedOpaqueRasterCrop(...f.args)).toBeUndefined()
})
it.each(['source bytes', 'equal context slot', 'serialized plan', 'png dimensions'])(
  'retains the whole paired-image certificate through publication: %s',
  (mode) => {
    const f = pairedFixture(),
      out = nativeIsolatedOpaqueRasterCrop(...f.args),
      rect = [...out.rect],
      png = isolatedPng(rect)
    if (mode === 'source bytes') f.args[5].content.items[2].str = 'Changed'
    if (mode === 'equal context slot')
      f.args[5].glyphBounds = structuredClone(f.args[5].glyphBounds)
    if (mode === 'png dimensions') new DataView(png.buffer, png.byteOffset).setUint32(16, 10)
    expect(
      nativeIsolatedOpaqueRasterPngSafe(
        mode === 'serialized plan' ? structuredClone(out) : out,
        png,
        rect,
        f.args[0]
      )
    ).toBe(false)
  }
)
it('preserves a missing image without a live page and image identity', () => {
  const f = isolatedFixture(),
    figure = f.args[1]
  delete figure.rect
  figure.issue = 'ambiguous-graphic-direction'
  // Place the complete caption close to the image while retaining its native text identity.
  const c = f.args[5],
    r = c.content.items[1]
  r.transform[5] = 400 - 260
  c.operators.argsArray[12] = [[1, 0, 0, 1, 60, 140]]
  f.args[4][1] = tableTextToken(r, c.viewport, 0)
  figure.caption.rect = [60, 250, 250, 262]
  expect(nativeIsolatedOpaqueRasterCrop(...f.args)).toBeUndefined()
  figure.issue = 'other-reason'
  expect(nativeIsolatedOpaqueRasterCrop(...f.args)).toBeUndefined()
})
it('isolates a complete opaque image from an unrelated native heading without claiming its text', () => {
  const f = isolatedFixture(),
    before = JSON.stringify(f.args),
    out = nativeIsolatedOpaqueRasterCrop(...f.args)
  expect(out?.rect).toEqual([79.5, 99.5, 320.5, 240.5])
  expect(Object.keys(out)).toEqual(['rect'])
  expect(nativeIsolatedOpaqueRasterPngSafe(out, isolatedPng(out.rect), out.rect, f.args[0])).toBe(
    true
  )
  expect(JSON.stringify(f.args)).toBe(before)
})
it.each([
  'opacity',
  'unknown paint',
  'caption overlap',
  'table',
  'source claim',
  'multiple images'
])('preserves the original image when isolation is not proved: %s', (mode) => {
  const f = isolatedFixture(),
    [, figure, , tables, , c] = f.args
  if (mode === 'opacity') c.opaqueRasterImages[0].kind = 3
  if (mode === 'unknown paint') f.add(OPS.shadingFill, ['unknown'])
  if (mode === 'caption overlap')
    c.glyphBounds[0].glyphs.find((g) => g.fontChar.startsWith('Figure')).bounds[3] = 8
  if (mode === 'table') tables.push([80, 100, 320, 240])
  if (mode === 'source claim') figure.sourceItems = [c.content.items[0].sourceItem]
  if (mode === 'multiple images') {
    f.add(OPS.save, null)
    f.add(OPS.transform, [240, 0, 0, 140, 80, 160])
    f.add(OPS.paintImageXObject, ['other', 100, 100])
    f.add(OPS.restore, null)
  }
  expect(nativeIsolatedOpaqueRasterCrop(...f.args)).toBeUndefined()
})
it.each(['serialized plan', 'source mutation', 'geometry mutation', 'retry dimensions'])(
  'rejects invalidated opaque crop publication: %s',
  (mode) => {
    const f = isolatedFixture(),
      out = nativeIsolatedOpaqueRasterCrop(...f.args),
      rect = [...out.rect],
      png = isolatedPng(rect)
    if (mode === 'source mutation') f.args[5].content.items[0].str = 'Changed'
    if (mode === 'geometry mutation') out.rect[0]--
    if (mode === 'retry dimensions') new DataView(png.buffer, png.byteOffset).setUint32(16, 10)
    expect(
      nativeIsolatedOpaqueRasterPngSafe(
        mode === 'serialized plan' ? structuredClone(out) : out,
        png,
        rect,
        f.args[0]
      )
    ).toBe(false)
  }
)

const fixture = (): ReturnType<typeof JSON.parse> => {
  const page = {
    pageNumber: 1,
    width: 200,
    height: 200,
    invalidGraphicsBounds: 0,
    lines: [
      { text: 'Plain paragraph alpha', x: 20, y: 30, width: 105, height: 10, fontSize: 10 },
      { text: 'Plain paragraph bravo', x: 20, y: 42, width: 105, height: 10, fontSize: 10 },
      { text: 'Tail.', x: 20, y: 54, width: 25, height: 10, fontSize: 10 },
      { text: 'Figure A.', x: 30, y: 132, width: 36, height: 8, fontSize: 8 }
    ],
    graphicsBounds: [] as object[]
  }
  const items = page.lines.map((l, index) => ({
    str: l.text,
    dir: 'ltr',
    width: l.width,
    height: l.fontSize,
    transform: [l.fontSize, 0, 0, l.fontSize, l.x, 200 - l.y - l.height],
    fontName: 'font',
    sourceItem: { pageNumber: 1, index, text: l.text }
  }))
  const operators: { fnArray: number[]; argsArray: unknown[] } = { fnArray: [], argsArray: [] }
  for (const i of items) {
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      ['font', i.height],
      [new Float32Array([1, 0, 0, 1, i.transform[4], i.transform[5]])],
      [
        [...i.str].map((unicode) => ({
          unicode,
          fontChar: unicode,
          originalCharCode: unicode.charCodeAt(0),
          width: 500,
          isSpace: unicode === ' ',
          isInFont: unicode !== ' '
        }))
      ],
      null
    )
  }
  operators.fnArray.push(
    OPS.save,
    OPS.eoClip,
    OPS.constructPath,
    OPS.transform,
    OPS.dependency,
    OPS.paintImageXObject,
    OPS.restore
  )
  operators.argsArray.push(
    null,
    null,
    [
      OPS.endPath,
      [new Float32Array([0, 20, 70, 1, 180, 70, 1, 180, 130, 1, 20, 130, 4])],
      new Float32Array([20, 70, 180, 130])
    ],
    [160, 0, 0, 60, 20, 70],
    ['image'],
    ['image', 160, 60],
    null
  )
  const operationIndex = operators.fnArray.length - 2
  page.graphicsBounds = [{ kind: 'image', operationIndex, normalizedRect: [0.1, 0.35, 0.9, 0.65] }]
  const caption = { page: 1, lines: ['Figure A.'], rect: [30, 132, 66, 140] },
    figure = {
      caption,
      rect: [19, 60, 181, 129],
      graphicsCount: 1,
      excludedProseLines: page.lines.slice(0, 2)
    }
  const glyphBounds = [
    {
      fontName: 'font',
      glyphs: [...new Set(items.flatMap((i) => [...i.str]))].map((fontChar) => ({
        fontChar,
        bounds: fontChar === ' ' ? [0, 0, 0, 0] : [0, -0.2, 0.5, 0.7]
      }))
    }
  ]
  const context = {
    operators,
    glyphBounds,
    viewport: {
      width: 200,
      height: 200,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 200],
      convertToViewportPoint: (x: number, y: number): number[] => [x, 200 - y]
    },
    content: { items, styles: { font: { vertical: false } } },
    graphicsBounds: page.graphicsBounds,
    opaqueRasterImages: [{ operationIndex, imageId: 'image', width: 160, height: 60, kind: 2 }]
  }
  return { page, figure, captions: [caption], tables: [], context, operationIndex }
}
it('crops an opaque last image independently of a proved preceding paragraph tail', () => {
  const f = fixture(),
    before = structuredClone(f.figure),
    result = nativeOpaqueRasterCrop(f.page, f.figure, f.captions, f.tables, f.context)
  expect(result).toEqual([20, 70, 180, 130])
  expect(f.figure).toEqual(before)
})
it.each([
  'missing opacity',
  'rgba',
  'wrong identity',
  'duplicate identity',
  'alpha',
  'blend',
  'soft mask',
  'later text',
  'unknown paint',
  'nonrect clip',
  'rotation',
  'source alias',
  'wrong literal',
  'unproved prose',
  'different cadence',
  'foreign table',
  'owned labels',
  'parts',
  'cropRects',
  'unknown graphic',
  'global clip',
  'caption ink enters image',
  'caption glyph missing'
])('keeps the old crop when opaque-raster evidence is incomplete: %s', (mode) => {
  const f = fixture(),
    o = f.context.operators,
    n = f.operationIndex
  if (mode === 'missing opacity') delete f.context.opaqueRasterImages
  if (mode === 'rgba') f.context.opaqueRasterImages[0].kind = 3
  if (mode === 'wrong identity') f.context.opaqueRasterImages[0].imageId = 'other'
  if (mode === 'duplicate identity')
    f.context.opaqueRasterImages.push({ ...f.context.opaqueRasterImages[0] })
  if (['alpha', 'blend', 'soft mask'].includes(mode)) {
    o.fnArray.unshift(OPS.setGState)
    o.argsArray.unshift([
      [mode === 'alpha' ? ['ca', 0.5] : mode === 'blend' ? ['BM', 'multiply'] : ['SMask', true]]
    ])
    f.context.opaqueRasterImages[0].operationIndex++
    f.page.graphicsBounds[0].operationIndex++
  }
  if (mode === 'later text') {
    o.fnArray.push(OPS.showText)
    o.argsArray.push([[{ unicode: 'X', width: 500 }]])
  }
  if (mode === 'unknown paint') {
    o.fnArray.push(OPS.shadingFill)
    o.argsArray.push(['unknown'])
  }
  if (mode === 'nonrect clip') o.argsArray[n - 3][1][0][3] = 2
  if (mode === 'rotation') o.argsArray[n - 2][1] = 1
  if (mode === 'source alias') f.context.content.items[0].sourceItem.index = 1
  if (mode === 'wrong literal') f.context.content.items[0].str = 'Changed'
  if (mode === 'unproved prose') delete f.figure.excludedProseLines
  if (mode === 'different cadence') f.page.lines[0].y--
  if (mode === 'foreign table') f.tables.push([20, 70, 180, 130])
  if (mode === 'owned labels') f.figure.sourceItems = [{ pageNumber: 1, index: 2, text: 'Tail.' }]
  if (mode === 'parts') f.figure.parts = []
  if (mode === 'cropRects') f.figure.cropRects = []
  if (mode === 'unknown graphic') f.page.graphicsBounds[0].operationIndex = 99
  if (mode === 'global clip') {
    o.fnArray.unshift(OPS.clip)
    o.argsArray.unshift(null)
    f.context.opaqueRasterImages[0].operationIndex++
    f.page.graphicsBounds[0].operationIndex++
  }
  if (mode === 'caption ink enters image')
    f.context.glyphBounds[0].glyphs.find((g) => g.fontChar === 'F').bounds[3] = 2
  if (mode === 'caption glyph missing')
    f.context.glyphBounds[0].glyphs = f.context.glyphBounds[0].glyphs.filter(
      (g) => g.fontChar !== 'F'
    )
  expect(nativeOpaqueRasterCrop(f.page, f.figure, f.captions, f.tables, f.context)).toBeUndefined()
})
