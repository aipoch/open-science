import { expect, it } from 'vitest'
import { OPS, version } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { createCanvas } from '@napi-rs/canvas'
const { anonymousScriptedArray } = await import(
  pathToFileURL(resolve('test/fixtures/open-axis-scripted-array.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { nativeCaptionedFormPixelCrop, nativeCaptionedFormPixelPngSafe, nativeCaptionedFormScope } =
  await import(
    pathToFileURL(resolve('resources/literature-pdf-figure-native-captioned-form.mjs')).href
  )

// Reuse the native raster array, adding an independent rotated mark and one
// explicitly captured PDF.js API spelling pair outside its picture.
function pixelFormWithIndependentSources(): ReturnType<typeof JSON.parse> {
  const { args: a, figure } = anonymousScriptedArray({ rasterTitles: true }),
    [page, captions, , , , tokens, context] = a,
    o = context.operators,
    glyphs = context.glyphBounds[0].glyphs,
    add = (op: number, args: unknown = null): number => {
      o.fnArray.push(op)
      return o.argsArray.push(args) - 1
    },
    text = (str: string, glyph: object, transform: number[], width: number): number => {
      const size = Math.hypot(transform[0], transform[1]),
        index = context.content.items.length,
        sourceItem = { pageNumber: 1, index, text: str },
        item = { str, dir: 'ltr', fontName: 'F', width, height: size, transform, sourceItem }
      add(OPS.beginText)
      add(OPS.setFont, ['F', size])
      add(OPS.setTextMatrix, [
        [...transform.slice(0, 4).map((n) => n / size), ...transform.slice(4)]
      ])
      const op = add(OPS.showText, [[glyph]])
      add(OPS.endText)
      context.content.items.push(item)
      tokens.push(tableTextToken(item, context.viewport, 0))
      return op
    }
  figure.caption.lines = ['C']
  context.pageNumber = 1
  context.sourceSha256 = 'a'.repeat(64)
  add(OPS.paintFormXObjectBegin, [null, [375, 240, 395, 260]])
  const zeroOp = text(
    '^',
    { unicode: '^', fontChar: '^', width: 0, isInFont: true },
    [0, 10, -10, 0, 385, 250],
    0
  )
  add(OPS.paintFormXObjectEnd)
  const pairIndex = context.content.items.length
  text(
    'μ',
    { unicode: 'µ', fontChar: 'µ', width: 500, isInFont: true, originalCharCode: 181 },
    [8, 0, 0, 8, 380, 70],
    4
  )
  glyphs.push(
    { fontChar: '^', bounds: [0, -0.1, 0.5, 0.7] },
    { fontChar: 'µ', bounds: [0, -0.1, 0.5, 0.7] }
  )
  const refresh = (): void => {
    const content = {
        ...context.content,
        items: context.content.items.map((r: ReturnType<typeof JSON.parse>) => {
          const item = { ...r }
          delete item.sourceItem
          return item
        })
      },
      viewport = { ...context.viewport }
    delete viewport.convertToViewportPoint
    const raw = structuredClone(content)
    raw.items[pairIndex].str = 'µ'
    context.dualApiEvidence = structuredClone({
      schema: 'same-pdfjs-page-dual-api-capture-v1',
      pdfjsVersion: version,
      apiDefaultOptions: {},
      apiRawOptions: { disableNormalization: true },
      pageNumber: 1,
      sourceSha256: context.sourceSha256,
      defaultContent: content,
      rawContent: raw,
      renderContext: {
        pageNumber: context.pageNumber,
        sourceSha256: context.sourceSha256,
        viewport,
        content,
        operators: context.operators,
        glyphBounds: context.glyphBounds,
        graphicsBounds: context.graphicsBounds
      }
    })
  }
  refresh()
  return { page, figure, captions, tokens, context, pairIndex, zeroOp, refresh }
}

it('keeps a complete pixel Form separate from certified API spelling and a rotated zero advance', () => {
  const f = pixelFormWithIndependentSources(),
    before = JSON.stringify(f.context.content),
    plan = nativeCaptionedFormPixelCrop(f.page, f.figure, f.captions, [], f.tokens, f.context)
  expect(plan?.rect).toEqual([29.5, 59.5, 370.5, 185.5])
  expect(plan.sourceItems).toBeUndefined()
  const canvas = createCanvas(1364, 504),
    png = canvas.toBuffer('image/png')
  expect(nativeCaptionedFormPixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  expect(
    nativeCaptionedFormScope(f.page, f.figure, f.captions, [], f.tokens, f.context)
  ).toBeUndefined()
  expect(JSON.stringify(f.context.content)).toBe(before)
  f.context.dualApiEvidence = structuredClone(f.context.dualApiEvidence)
  expect(nativeCaptionedFormPixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
})

it.each([
  'missing-api',
  'wrong-pair',
  'wrong-font',
  'non-quarter-turn',
  'nonzero-glyph',
  'missing-outline'
])('declines a pixel Form when independent native evidence is incomplete: %s', (fault) => {
  const f = pixelFormWithIndependentSources()
  if (fault === 'missing-api') delete f.context.dualApiEvidence
  if (fault === 'wrong-pair') f.context.dualApiEvidence.rawContent.items[f.pairIndex].str = 'v'
  if (fault === 'wrong-font')
    f.context.dualApiEvidence.rawContent.items[f.pairIndex].fontName = 'other'
  if (fault === 'non-quarter-turn') {
    const item = f.context.content.items[f.pairIndex - 1]
    item.transform[0] = 0.01
    f.tokens.find(
      (t: ReturnType<typeof JSON.parse>) => t.sourceItem.index === f.pairIndex - 1
    ).rect = tableTextToken(item, f.context.viewport, 0).rect
    f.context.operators.argsArray[f.zeroOp - 1][0][0] = 0.001
    f.refresh()
  }
  if (fault === 'nonzero-glyph') {
    f.context.operators.argsArray[f.zeroOp][0][0].width = 1
    f.refresh()
  }
  if (fault === 'missing-outline') {
    f.context.glyphBounds[0].glyphs = f.context.glyphBounds[0].glyphs.filter(
      (g: { fontChar: string }) => g.fontChar !== '^'
    )
    f.refresh()
  }
  expect(
    nativeCaptionedFormPixelCrop(f.page, f.figure, f.captions, [], f.tokens, f.context)
  ).toBeUndefined()
})
// Keep the existing anonymous native operator fixture. Only its three zero ticks
// become complete panel keys; each face retains two numeric ticks.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function keyedArray({ top = false } = {}) {
  const f = anonymousScriptedArray(),
    a = f.args,
    context = a[6]
  let n = 0
  for (const raw of context.content.items) {
    if (raw.str !== '0') continue
    const label = top ? String.fromCharCode(97 + n) : `(${String.fromCharCode(97 + n)})`,
      x = (top ? 42 : 82.5) + n * 110,
      y = top ? 77 : 200,
      size = 5
    const show = context.operators.argsArray.find(
      (z: unknown[], i: number) =>
        context.operators.fnArray[i] === OPS.showText &&
        z[0][0].unicode === '0' &&
        context.operators.argsArray[i - 1][0][4] === raw.transform[4]
    )
    show[0][0] = { ...show[0][0], unicode: label, fontChar: label, width: 500 * label.length }
    const showIndex = context.operators.argsArray.indexOf(show)
    context.operators.argsArray[showIndex - 1] = [[1, 0, 0, 1, x, a[0].height - y]]
    Object.assign(raw, {
      str: label,
      width: size * 0.5 * label.length,
      transform: [size, 0, 0, size, x, a[0].height - y],
      sourceItem: { ...raw.sourceItem, text: label }
    })
    context.glyphBounds[0].glyphs.push({
      fontChar: label,
      bounds: [0, -0.1, 0.5 * label.length, 0.7]
    })
    const index = a[5].findIndex(
      (t: { sourceItem: { index: number } }) => t.sourceItem.index === raw.sourceItem.index
    )
    a[5][index] = tableTextToken(raw, context.viewport, 0)
    n++
  }
  return f
}
it('completes the original bounded plot Form without adding graph text owners', () => {
  const { args: a } = keyedArray(),
    before = JSON.stringify(a)
  const figures = associateFigures(...a)
  expect(figures).toHaveLength(1)
  expect(figures[0].rect).toEqual([30, 60, 370, 215])
  expect(figures[0].sourceItems).toEqual(figures[0].fallbackFigure.sourceItems)
  expect(figures[0].fallbackFigure.rect).toEqual([50, 80, 350, 185])
  expect(JSON.stringify(a)).toBe(before)
})
const { nativeCompleteFormCrop, nativeCompleteFormCropPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-complete-form.mjs')).href
)
it('completes one native Form containing a titled raster row without changing its input', () => {
  const { args: a, figure } = anonymousScriptedArray({ rasterTitles: true }),
    before = JSON.stringify({ args: a, figure }),
    result = nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6])
  expect(result?.rect).toEqual([30, 60, 370, 185])
  expect(result?.sourceItems).toEqual(
    a[6].content.items.slice(0, 5).map((r: { sourceItem: unknown }) => r.sourceItem)
  )
  expect(result?.formCropRaster.ownedRects).toEqual([[30, 60, 370, 185]])
  expect(JSON.stringify({ args: a, figure })).toBe(before)
})
it.each(['off-center-title', 'white-title', 'clipped-title', 'partial-seed'])(
  'refuses an incomplete native raster-title witness: %s',
  (kind) => {
    const { args: a, figure } = anonymousScriptedArray({ rasterTitles: true }),
      context = a[6],
      raw = context.content.items[0],
      show = context.operators.fnArray.findIndex((op: number) => op === OPS.showText)
    if (kind === 'off-center-title') {
      raw.transform[4] += 1
      context.operators.argsArray[show - 1][0][4] += 1
      a[5][0] = tableTextToken(raw, context.viewport, 0)
    }
    if (kind === 'white-title') context.operators.argsArray[2] = ['#ffffff']
    if (kind === 'clipped-title') context.operators.argsArray[0][1][3] = 227
    if (kind === 'partial-seed') figure.rect[0] += 1
    expect(nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
  }
)
it.each(['api-item-reference', 'api-value', 'font-reference', 'source-reference'])(
  'refuses a pixel Form after its final render changes %s',
  (fault) => {
    const f = pixelFormWithIndependentSources(),
      plan = nativeCaptionedFormPixelCrop(f.page, f.figure, f.captions, [], f.tokens, f.context),
      canvas = createCanvas(1364, 504),
      png = canvas.toBuffer('image/png')
    expect(plan).toBeDefined()
    if (fault === 'api-item-reference') {
      const items = f.context.dualApiEvidence.rawContent.items
      items[f.pairIndex] = structuredClone(items[f.pairIndex])
    }
    if (fault === 'api-value') f.context.dualApiEvidence.rawContent.items[f.pairIndex].str = 'v'
    if (fault === 'font-reference')
      f.context.glyphBounds[0] = structuredClone(f.context.glyphBounds[0])
    if (fault === 'source-reference') {
      const items = f.context.content.items
      items[f.pairIndex] = structuredClone(items[f.pairIndex])
    }
    expect(nativeCaptionedFormPixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  }
)
it('completes a bounded plot Form with native top-left panel keys and an exterior seed margin', () => {
  const { args: a, figure } = keyedArray({ top: true }),
    before = JSON.stringify(a),
    result = associateFigures(...a)[0]
  expect(result.rect).toEqual([30, 60, 370, 215])
  expect(result.sourceItems).toEqual(result.fallbackFigure.sourceItems)
  figure.rect = [29, 80, 371, 185]
  expect(nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6])?.rect).toEqual([
    29, 60, 371, 215
  ])
  expect(JSON.stringify(a)).toBe(before)
})
it.each([
  'missing-key',
  'invisible-key',
  'broken-row',
  'wrong-order',
  'partial-seed',
  'missing-font'
])('refuses an incomplete native top-left panel chain: %s', (kind) => {
  const { args: a, figure } = keyedArray({ top: true }),
    context = a[6],
    raw = context.content.items.find((r: { str: string }) => r.str === 'b'),
    index = context.operators.fnArray.findIndex(
      (op: number, i: number) =>
        op === OPS.showText && context.operators.argsArray[i][0][0].unicode === 'b'
    )
  figure.rect = [29, 80, 371, 185]
  if (kind === 'missing-key') context.content.items.splice(context.content.items.indexOf(raw), 1)
  if (kind === 'invisible-key') {
    context.operators.fnArray.splice(index + 1, 0, OPS.setFillRGBColor)
    context.operators.argsArray.splice(index + 1, 0, ['#000000'])
    context.operators.fnArray.splice(index, 0, OPS.setFillRGBColor)
    context.operators.argsArray.splice(index, 0, ['#ffffff'])
    for (const g of a[0].graphicsBounds)
      g.operationIndex += (g.operationIndex >= index ? 1 : 0) + (g.operationIndex > index ? 1 : 0)
  }
  if (kind === 'broken-row') {
    raw.transform[5] += 1
    context.operators.argsArray[index - 1][0][5] += 1
    const at = a[5].findIndex(
      (t: { sourceItem: { index: number } }) => t.sourceItem.index === raw.sourceItem.index
    )
    a[5][at] = tableTextToken(raw, context.viewport, 0)
  }
  if (kind === 'wrong-order') {
    raw.str = 'a'
    raw.sourceItem.text = 'a'
    context.operators.argsArray[index][0][0].unicode = 'a'
    context.operators.argsArray[index][0][0].fontChar = 'a'
    const at = a[5].findIndex(
      (t: { sourceItem: { index: number } }) => t.sourceItem.index === raw.sourceItem.index
    )
    a[5][at] = tableTextToken(raw, context.viewport, 0)
  }
  if (kind === 'partial-seed') figure.rect[0] = 51
  if (kind === 'missing-font') context.glyphBounds = []
  expect(nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
})
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function stackedArrays() {
  const first = anonymousScriptedArray(),
    second = anonymousScriptedArray(),
    height = 500,
    page = { ...first.args[0], height, graphicsBounds: [], lines: [] },
    context = {
      ...first.args[6],
      viewport: {
        ...first.args[6].viewport,
        height,
        transform: [1, 0, 0, -1, 0, height],
        convertToViewportPoint: (x: number, y: number) => [x, height - y]
      },
      operators: { fnArray: [], argsArray: [] },
      content: { items: [], styles: first.args[6].content.styles },
      graphicsBounds: []
    },
    tokens = [],
    rules = []
  for (const [n, source] of [first, second].entries()) {
    const a = source.args,
      delta = n * 190,
      translation = 200 - delta,
      offset = context.operators.fnArray.length + 2,
      label = `(${String.fromCharCode(97 + n)})`
    const captionGlyph = a[6].operators.argsArray.find(
      (z: unknown[], i: number) =>
        a[6].operators.fnArray[i] === OPS.showText && z[0][0].unicode === 'C'
    )[0][0]
    Object.assign(captionGlyph, { unicode: label, fontChar: label, width: 1500 })
    context.operators.fnArray.push(OPS.save, OPS.transform, ...a[6].operators.fnArray, OPS.restore)
    context.operators.argsArray.push(
      [],
      [1, 0, 0, 1, 0, translation],
      ...a[6].operators.argsArray,
      []
    )
    for (const raw of a[6].content.items) {
      raw.transform[5] += translation
      if (raw.str === 'C') Object.assign(raw, { str: label, width: 12 })
      raw.sourceItem = { pageNumber: 1, index: context.content.items.length, text: raw.str }
      context.content.items.push(raw)
      tokens.push(tableTextToken(raw, context.viewport, 0))
    }
    context.glyphBounds[0].glyphs.push({ fontChar: label, bounds: [0, -0.1, 1.5, 0.7] })
    const graphics = a[0].graphicsBounds.map(
      (g: { operationIndex: number; normalizedRect: number[] }) => ({
        ...g,
        operationIndex: g.operationIndex + offset,
        normalizedRect: g.normalizedRect.map((v: number, i: number) =>
          i % 2 ? (v * 300 + delta) / height : v
        )
      })
    )
    page.graphicsBounds.push(...graphics)
    rules.push(...a[3].map((r: number[]) => r.map((v, i) => v + (i % 2 ? delta : 0))))
  }
  context.graphicsBounds = page.graphicsBounds
  const caption = { page: 1, lines: ['Figure 1. Two rows.'], rect: [30, 445, 370, 460] },
    figure = { rect: [25, 227, 375, 426], caption },
    args = [page, [caption], [], rules, [], tokens, context]
  return { args, figure }
}
it('completes both matching native rows with complete external panel keys', () => {
  const { args: a, figure } = stackedArrays(),
    before = JSON.stringify(a)
  expect(nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6])?.rect).toEqual([
    25, 60, 375, 426
  ])
  expect(JSON.stringify(a)).toBe(before)
})
it('refuses a Form without the complete repeated panel-key witnesses', () => {
  const { args: a, figure } = anonymousScriptedArray()
  expect(nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
})
it.each([false, true])(
  'refuses missing native font evidence, raster titles: %s',
  (rasterTitles) => {
    const { args: a, figure } = rasterTitles
      ? anonymousScriptedArray({ rasterTitles })
      : keyedArray()
    a[6].glyphBounds = []
    expect(nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
  }
)

it('completes two rows of independent plot Forms with an independently proved shared legend', () => {
  for (const labels of [
    ['One', 'Two'],
    ['Bee', 'Owl']
  ]) {
    const f = anonymousScriptedArray({ plotGrid: true, labels }),
      a = f.args,
      before = JSON.stringify(f),
      result = nativeCompleteFormCrop(a[0], f.figure, a[1], a[2], a[5], a[6])
    expect(result?.rect).toEqual([20, 15, 350, 230])
    expect(result?.sourceItems).toBeUndefined()
    expect(result?.formCropRaster.markerClips).toHaveLength(6)
    expect(JSON.stringify(f)).toBe(before)
  }
})

const { nativePageTextPacketInventory } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
it.each([
  'missing-glyph',
  'open-form',
  'foreign-paint',
  'row-order',
  'legend-missing',
  'legend-fill',
  'marker-aspect',
  'large-marker-path'
])('refuses an incomplete plot-grid proof: %s', (mode) => {
  const f = anonymousScriptedArray({ plotGrid: true }),
    a = f.args,
    context = a[6],
    o = context.operators,
    legend = o.fnArray.lastIndexOf(OPS.paintFormXObjectBegin),
    marker = o.fnArray.findIndex(
      (op: number, i: number) =>
        i > legend && op === OPS.constructPath && o.argsArray[i][0] === OPS.fillStroke
    )
  if (mode === 'missing-glyph')
    context.glyphBounds[0].glyphs = context.glyphBounds[0].glyphs.filter(
      (g: { fontChar: string }) => g.fontChar !== '(a)'
    )
  if (mode === 'open-form') {
    const at = o.fnArray.indexOf(OPS.paintFormXObjectEnd)
    o.fnArray[at] = OPS.dependency
    o.argsArray[at] = ['missing-close']
  }
  if (mode === 'foreign-paint') {
    const operationIndex = o.fnArray.length
    o.fnArray.push(OPS.constructPath)
    o.argsArray.push([
      OPS.fill,
      [[0, 25, 85, 1, 30, 85, 1, 30, 80, 1, 25, 80, 4]],
      [25, 80, 30, 85]
    ])
    a[0].graphicsBounds.push({
      operationIndex,
      kind: 'path',
      normalizedRect: [25 / 400, 215 / 300, 30 / 400, 220 / 300]
    })
  }
  if (mode === 'row-order') {
    const entries = context.content.items
      .filter((r: { str: string }) => r.str === '(c)' || r.str === '(d)')
      .map((r: { str: string; sourceItem: { text: string } }) => ({
        r,
        at: o.fnArray.findIndex(
          (op: number, i: number) => op === OPS.showText && o.argsArray[i][0][0].unicode === r.str
        )
      }))
    for (const { r, at } of entries) {
      const next = r.str === '(c)' ? '(d)' : '(c)'
      Object.assign(o.argsArray[at][0][0], { unicode: next, fontChar: next })
      r.str = next
      r.sourceItem.text = next
    }
    a[5] = context.content.items.map((r: unknown) => tableTextToken(r, context.viewport, 0))
  }
  if (mode === 'legend-missing') {
    o.fnArray[marker] = OPS.dependency
    o.argsArray[marker] = ['missing-marker']
    const at = a[0].graphicsBounds.findIndex(
      (g: { operationIndex: number }) => g.operationIndex === marker
    )
    a[0].graphicsBounds.splice(at, 1)
  }
  if (mode === 'legend-fill')
    o.argsArray[o.fnArray.lastIndexOf(OPS.setFillRGBColor, marker)] = ['#00ff00']
  if (mode === 'marker-aspect') {
    const args = o.argsArray[marker],
      left = args[2][0]
    args[1][0] = args[1][0].map((v: number, i: number) => (i % 3 === 1 ? left + (v - left) * 2 : v))
    args[2][2] = left + (args[2][2] - left) * 2
  }
  if (mode === 'large-marker-path') {
    const args = o.argsArray[marker],
      [x0, y0, x1, y1] = args[2]
    args[1][0] = [0, x0, y0, ...Array.from({ length: 128 }, () => [1, x1, y1, 1, x0, y0]).flat(), 4]
  }
  if (!['missing-glyph', 'open-form'].includes(mode))
    expect(nativePageTextPacketInventory(a[0], a[5], context, true)).toBeDefined()
  expect(nativeCompleteFormCrop(a[0], f.figure, a[1], a[2], a[5], context)).toBeUndefined()
})

it('requires complete marker clips at the actual PNG minimum stroke width', () => {
  const { args: a, figure } = anonymousScriptedArray({ plotGrid: true }),
    result = nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6]),
    rect = result.rect.map((v: number, i: number) => v + (i < 2 ? -1 : 1)),
    png = createCanvas((rect[2] - rect[0]) * 4, (rect[3] - rect[1]) * 4).toBuffer('image/png'),
    proof = structuredClone(result)
  for (const group of proof.formCropRaster.markerClips)
    for (const marker of group) marker.strokeWidth = 0.001
  expect(nativeCompleteFormCropPngSafe(png, rect, a[0], proof)).toBe(true)
  const marker = proof.formCropRaster.markerClips[0][0]
  // Physical stroke fits this clip, but the real device minimum stroke does not.
  marker.clip = marker.rect.map((v: number, i: number) => v + (i < 2 ? -0.01 : 0.01))
  expect(nativeCompleteFormCropPngSafe(png, rect, a[0], proof)).toBe(false)
})
it('refuses external source ink inside the completed Form', () => {
  const { args: a, figure } = keyedArray(),
    raw = a[6].content.items.at(-1),
    o = a[6].operators
  raw.transform[4] = 35
  raw.transform[5] = a[0].height - 70
  const show = o.fnArray.lastIndexOf(OPS.showText)
  o.argsArray[show - 1] = [[1, 0, 0, 1, 35, a[0].height - 70]]
  a[5][a[5].length - 1] = tableTextToken(raw, a[6].viewport, 0)
  expect(nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
})
it.each(['bottom', 'top', 'raster'])(
  'refuses a competing table at the new boundary: %s',
  (mode) => {
    const { args: a, figure } =
      mode === 'raster'
        ? anonymousScriptedArray({ rasterTitles: true })
        : keyedArray({ top: mode === 'top' })
    expect(
      nativeCompleteFormCrop(a[0], figure, a[1], [[31, 61, 39, 69]], a[5], a[6])
    ).toBeUndefined()
  }
)
it.each(['white', 'transparent'])('refuses an invisible external panel key: %s', (kind) => {
  const { args: a, figure } = stackedArrays(),
    o = a[6].operators,
    show = o.fnArray.findIndex(
      (op: number, i: number) => op === OPS.showText && o.argsArray[i][0][0].unicode === '(a)'
    ),
    start = o.fnArray.lastIndexOf(OPS.beginText, show),
    end = o.fnArray.indexOf(OPS.endText, show),
    op = kind === 'white' ? OPS.setFillRGBColor : OPS.setGState,
    before = kind === 'white' ? ['#ffffff'] : [[['ca', 0]]],
    after = kind === 'white' ? ['#000000'] : [[['ca', 1]]]
  o.fnArray.splice(end + 1, 0, op)
  o.argsArray.splice(end + 1, 0, after)
  o.fnArray.splice(start, 0, op)
  o.argsArray.splice(start, 0, before)
  for (const g of a[0].graphicsBounds)
    g.operationIndex += (g.operationIndex >= start ? 1 : 0) + (g.operationIndex > end ? 1 : 0)
  expect(nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
})
it.each(['bottom', 'top', 'raster'])(
  'refuses independent foreign paint inside the completed Form: %s',
  (mode) => {
    const { args: a, figure } =
        mode === 'raster'
          ? anonymousScriptedArray({ rasterTitles: true })
          : keyedArray({ top: mode === 'top' }),
      o = a[6].operators,
      index = o.fnArray.length
    o.fnArray.push(OPS.constructPath)
    o.argsArray.push([
      OPS.fill,
      [[0, 31, 239, 1, 39, 239, 1, 39, 231, 1, 31, 231, 4]],
      [31, 231, 39, 239]
    ])
    a[0].graphicsBounds.push({
      operationIndex: index,
      kind: 'path',
      normalizedRect: [31 / 400, 61 / 300, 39 / 400, 69 / 300]
    })
    expect(nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
  }
)
it.each([false, true])(
  'checks actual PNG scale and malformed images, raster titles: %s',
  (rasterTitles) => {
    const { args: a, figure } = rasterTitles
        ? anonymousScriptedArray({ rasterTitles })
        : keyedArray(),
      proof = nativeCompleteFormCrop(a[0], figure, a[1], a[2], a[5], a[6]),
      rect = proof.rect.map((v: number, i: number) => v + (i < 2 ? -4 / 3 : 4 / 3)),
      png = (scale: number): Buffer =>
        createCanvas(
          Math.ceil((rect[2] - rect[0]) * scale),
          Math.ceil((rect[3] - rect[1]) * scale)
        ).toBuffer('image/png'),
      candidate = { formCropRaster: proof.formCropRaster }
    expect(nativeCompleteFormCropPngSafe(png(4), rect, a[0], candidate)).toBe(true)
    expect(nativeCompleteFormCropPngSafe(png(0.5), rect, a[0], candidate)).toBe(false)
    expect(nativeCompleteFormCropPngSafe(Buffer.from('invalid'), rect, a[0], candidate)).toBe(false)
  }
)

// One native multi-image Form, including a repeated resource at two distinct
// transforms, is enclosed by an independently clipped isolated group.
function isolatedRasterForm(fault = ''): ReturnType<typeof JSON.parse> {
  const f = pixelFormWithIndependentSources(),
    o = f.context.operators,
    begin = o.fnArray.indexOf(OPS.paintFormXObjectBegin),
    end = o.fnArray.indexOf(OPS.paintFormXObjectEnd),
    group = {
      matrix: null,
      bbox: [30, 115, 370, 240],
      smask: null,
      isolated: true,
      knockout: false
    },
    insert = (at: number, op: number, args: unknown): void => {
      o.fnArray.splice(at, 0, op)
      o.argsArray.splice(at, 0, args)
      for (const g of f.page.graphicsBounds) if (g.operationIndex >= at) g.operationIndex++
    }
  const images = o.fnArray.flatMap((op: number, i: number) =>
    op === OPS.paintImageXObject ? [i] : []
  )
  o.argsArray[images[1]][0] = o.argsArray[images[0]][0]
  if (fault !== 'bounded-form') o.argsArray[begin] = [null, null]
  if (fault === 'soft-mask') group.smask = { subtype: 'Alpha' } as never
  if (fault === 'knockout') group.knockout = true
  if (fault === 'nonisolated') group.isolated = false
  if (fault !== 'no-group') {
    insert(end + 1, OPS.endGroup, [group])
    insert(begin, OPS.beginGroup, [group])
  }
  if (fault === 'unbalanced') o.fnArray[end + 2] = OPS.restore
  if (fault === 'non-direct') {
    insert(end + 2, OPS.restore, null)
    insert(begin + 1, OPS.save, null)
  }
  if (fault === 'foreign') {
    const item = f.context.content.items[f.pairIndex],
      show = o.fnArray.findIndex(
        (op: number, i: number) =>
          op === OPS.showText &&
          o.argsArray[i][0].some((g: { unicode?: string }) => g.unicode === 'µ')
      )
    item.transform = [8, 0, 0, 8, 160, 170]
    o.argsArray[show - 1] = [[1, 0, 0, 1, 160, 170]]
    const token = f.tokens.findIndex(
      (t: { sourceItem: { index: number } }) => t.sourceItem.index === f.pairIndex
    )
    f.tokens[token] = tableTextToken(item, f.context.viewport, 0)
  }
  f.refresh()
  return f
}

it('recovers the complete pixel Form inside an exact isolated group without Source authority', () => {
  const f = isolatedRasterForm(),
    before = JSON.stringify(f.context),
    plan = nativeCaptionedFormPixelCrop(f.page, f.figure, f.captions, [], f.tokens, f.context)
  expect(plan?.rect).toEqual([28, 58, 372, 187])
  expect(plan.sourceItems).toBeUndefined()
  const canvas = createCanvas(1376, 516),
    png = canvas.toBuffer('image/png')
  expect(nativeCaptionedFormPixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  expect(
    nativeCaptionedFormPixelPngSafe(
      plan,
      createCanvas(344, 129).toBuffer('image/png'),
      plan.rect,
      f.page
    )
  ).toBe(false)
  expect(
    nativeCaptionedFormScope(f.page, f.figure, f.captions, [], f.tokens, f.context)
  ).toBeUndefined()
  expect(JSON.stringify(f.context)).toBe(before)
  f.context.operators.argsArray[0] = [...f.context.operators.argsArray[0]]
  expect(nativeCaptionedFormPixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
})

it.each([
  'soft-mask',
  'knockout',
  'unbalanced',
  'bounded-form',
  'no-group',
  'non-direct',
  'foreign'
])('keeps unproved group compositing outside the pixel Form proof: %s', (fault) => {
  const f = isolatedRasterForm(fault)
  expect(
    nativeCaptionedFormPixelCrop(f.page, f.figure, f.captions, [], f.tokens, f.context)
  ).toBeUndefined()
})

const { nativeIsolatedGroupPixelCropCurrent } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-captioned-form.mjs')).href
)

it.each(['clone', 'stale', 'old-form'])(
  'does not grant complete-group identity to a %s pixel plan',
  (mode) => {
    const f = mode === 'old-form' ? pixelFormWithIndependentSources() : isolatedRasterForm(),
      plan = nativeCaptionedFormPixelCrop(f.page, f.figure, f.captions, [], f.tokens, f.context)
    expect(plan).toBeDefined()
    if (mode !== 'old-form') {
      expect(nativeIsolatedGroupPixelCropCurrent(plan, f.page)).toBe(true)
      expect(nativeIsolatedGroupPixelCropCurrent(plan, { ...f.page })).toBe(false)
    }
    const observed = mode === 'clone' ? { ...plan, kind: 'isolated-group-clip' } : plan
    if (mode === 'stale') f.context.operators.argsArray[0] = [...f.context.operators.argsArray[0]]
    expect(nativeIsolatedGroupPixelCropCurrent(observed, f.page)).toBe(false)
  }
)

it('retains a non-isolated group only as complete original pixels', () => {
  const f = isolatedRasterForm('nonisolated'),
    plan = nativeCaptionedFormPixelCrop(f.page, f.figure, f.captions, [], f.tokens, f.context)
  expect(plan?.rect).toEqual([28, 58, 372, 187])
  expect(plan.sourceItems).toBeUndefined()
  expect(
    nativeCaptionedFormScope(f.page, f.figure, f.captions, [], f.tokens, f.context)
  ).toBeUndefined()
})
