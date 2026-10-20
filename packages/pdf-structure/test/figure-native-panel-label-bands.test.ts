import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const fixture = (name: string): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(resolve(`test/fixtures/${name}.jsonl`))

it('keeps the upper raster plate when a lower raster row owns its fused panel key band', () => {
  const f = fixture('adjacent-raster-plates-with-fused-panel-keys')
  const result = associateFigures(f.page, f.captions, f.tableRects)
  expect(result[0].rect).toEqual([
    109.87704009965597, 83.35547999999996, 502.7048560000001, 246.42999999999995
  ])
  expect(result[1].rect).toEqual([107.578125, 290.8125, 506.8125, 372.373])
  expect(result[1].graphicsCount).toBe(4)
})

it('includes the outside native title above both uniform vector grids', () => {
  const f = fixture('paired-vector-grids-with-outside-native-titles')
  const title = f.page.lines.find((line: { text: string }) =>
    line.text.startsWith('First arrangement')
  )
  const result = associateFigures(f.page, f.captions, f.tableRects)
  expect(result[0].rect[1]).toBeLessThanOrEqual(title.y)
})

it.each(['foreign title', 'missing marker', 'missing grid cells', 'distant title'])(
  'does not extend the vector crop with %s',
  (variant) => {
    const f = fixture('paired-vector-grids-with-outside-native-titles')
    const title = f.page.lines.find((line: { text: string }) =>
      line.text.startsWith('First arrangement')
    )
    if (variant === 'foreign title')
      f.page.lines.push({
        ...title,
        text: 'An independent note',
        x: 180,
        width: 30,
        y: 236,
        height: 6,
        fontSize: 6
      })
    if (variant === 'missing marker')
      f.page.lines = f.page.lines.filter((line: { text: string }) => line.text !== '(b)')
    if (variant === 'missing grid cells')
      f.page.graphicsBounds = f.page.graphicsBounds.filter(
        (g: { normalizedRect: number[] }) => g.normalizedRect[0] > 0.5 || g.normalizedRect[1] > 0.39
      )
    if (variant === 'distant title') title.y -= 30
    const result = associateFigures(f.page, f.captions, f.tableRects)
    expect(result[0].rect?.[1] ?? Infinity).toBeGreaterThan(title.y)
  }
)

const { ownedRasterKeyBand } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-panel-labels.mjs')).href
)
it.each(['prose', 'repeated key', 'distant label', 'missing key', 'competing caption'])(
  'rejects raster key ownership with %s',
  (variant) => {
    const f = fixture('adjacent-raster-plates-with-fused-panel-keys')
    const line = f.page.lines.find((l: { text: string }) => l.text.includes('(d)'))
    if (variant === 'prose')
      line.text = 'A long independent paragraph about several unrelated groups'
    if (variant === 'repeated key') line.text = line.text.replace('(b)', '(a)')
    if (variant === 'distant label') line.y += 25
    if (variant === 'missing key') line.text = line.text.slice(0, line.text.indexOf('(d)'))
    if (variant === 'competing caption') f.captions.push(structuredClone(f.captions[1]))
    expect(ownedRasterKeyBand(line, f.page, f.captions)).toBe(false)
  }
)

// Complete anonymous image/text program. Each panel paints its image(s), then
// its whole native label; two components use rectangular Form clipping.
const nativePhotoRows = (dx = 0, dy = 0, accessoryWidth = 115): ReturnType<typeof JSON.parse> => {
  const width = 600,
    height = 800
  const operations: ReturnType<typeof JSON.parse> = { fnArray: [], argsArray: [] }
  const graphics: ReturnType<typeof JSON.parse>[] = [],
    items: ReturnType<typeof JSON.parse>[] = [],
    tokens: ReturnType<typeof JSON.parse>[] = [],
    labels: ReturnType<typeof JSON.parse>[] = []
  const emit = (op: number, args: unknown = null): number => {
    operations.fnArray.push(op)
    operations.argsArray.push(args)
    return operations.fnArray.length - 1
  }
  const image = (x: number, y: number, w: number, h: number, form = false): void => {
    x += dx
    y += dy
    emit(OPS.save)
    emit(OPS.transform, [1, 0, 0, 1, x, height - y - h])
    if (form)
      emit(OPS.paintFormXObjectBegin, [
        [1, 0, 0, 1, 0, 0],
        [0, 0, w, h]
      ])
    emit(OPS.save)
    emit(OPS.transform, form ? [w + 20, 0, 0, h + 20, -10, -10] : [w, 0, 0, h, 0, 0])
    const operationIndex = emit(OPS.paintImageXObject, ['sample-image', 100, 100])
    graphics.push({
      kind: 'image',
      operationIndex,
      normalizedRect: [
        Math.floor((x / width) * 256) / 256,
        Math.floor((y / height) * 256) / 256,
        Math.ceil(((x + w) / width) * 256) / 256,
        Math.ceil(((y + h) / height) * 256) / 256
      ],
      exactRect: [x, y, x + w, y + h]
    })
    emit(OPS.restore)
    if (form) emit(OPS.paintFormXObjectEnd, [])
    emit(OPS.restore)
  }
  const text = (
    value: string,
    x: number,
    y: number,
    w: number,
    font = 9
  ): ReturnType<typeof JSON.parse> => {
    x += dx
    y += dy
    const sourceItem = { pageNumber: 1, index: items.length, text: value }
    const transform = [font, 0, 0, font, x, height - y - font]
    items.push({
      str: value,
      sourceItem,
      transform,
      width: w,
      height: font,
      dir: 'ltr',
      fontName: 'Body',
      hasEOL: true
    })
    tokens.push({
      text: value,
      sourceItem: { ...sourceItem },
      rect: [x, y, x + w, y + font],
      horizontal: true,
      fontSize: font,
      height: font,
      width: w
    })
    emit(OPS.beginText)
    emit(OPS.setFont, ['Body', font])
    emit(OPS.moveText, [x, height - y - font])
    emit(OPS.showText, [
      Array.from(value, (unicode) => ({
        unicode,
        fontChar: unicode,
        width: (w / value.length / font) * 1000,
        isSpace: unicode === ' '
      }))
    ])
    emit(OPS.endText)
    return { text: value, x, y, width: w, height: font, fontSize: font }
  }
  const rightCenter = (320 + 385 + accessoryWidth) / 2
  image(100, 80, 180, 80, true)
  labels.push(text('(a) First sample panel with the initial conditions', 120, 162, 140))
  image(320, 80, 60, 80)
  image(385, 100, accessoryWidth, 40, true)
  labels.push(text('(b) Second sample panel with alternative parts', rightCenter - 70, 162, 140))
  image(120, 190, 140, 100)
  labels.push(text('(c) Third sample panel with adjusted components', 120, 292, 140))
  image(rightCenter - 70, 190, 140, 100)
  labels.push(text('(d) Fourth sample panel with a different setting', rightCenter - 70, 292, 140))
  const line = text('Figure 3: The complete physical configurations.', 90, 315, 420, 10)
  const lines = [0, 2].map((i) => ({
    ...labels[i],
    text: labels[i].text + ' ' + labels[i + 1].text,
    width: labels[i + 1].x + labels[i + 1].width - labels[i].x
  }))
  lines.push(line)
  return {
    page: {
      pageNumber: 1,
      width,
      height,
      invalidGraphicsBounds: 0,
      graphicsBounds: graphics,
      lines
    },
    captions: [
      {
        page: 1,
        rect: [line.x, line.y, line.x + line.width, line.y + line.height],
        lines: [line.text]
      }
    ],
    tables: [],
    tokens,
    context: {
      operators: operations,
      content: { items },
      viewport: {
        width,
        height,
        scale: 1,
        rotation: 0,
        transform: [1, 0, 0, -1, 0, height],
        convertToViewportPoint: (x: number, y: number): number[] => [x, height - y]
      }
    }
  }
}
const photoAssociation = (
  f: ReturnType<typeof nativePhotoRows>,
  native = true
): ReturnType<typeof JSON.parse> =>
  associateFigures(f.page, f.captions, f.tables, [], [], f.tokens, native ? f.context : undefined)

it.each([
  [0, 0, 115],
  [25, 40, 95]
])('retains every native photo component and label in a multirow plate (%s,%s,%s)', (dx, dy, w) => {
  const f = nativePhotoRows(dx, dy, w),
    result = photoAssociation(f)
  expect(result).toHaveLength(1)
  const crop = result[0].rect
  for (const rect of [
    ...f.page.graphicsBounds.map((g: { exactRect: number[] }) => g.exactRect),
    ...f.tokens.slice(0, 4).map((t: { rect: number[] }) => t.rect)
  ]) {
    expect(crop[0]).toBeLessThanOrEqual(rect[0])
    expect(crop[1]).toBeLessThanOrEqual(rect[1])
    expect(crop[2]).toBeGreaterThanOrEqual(rect[2])
    expect(crop[3]).toBeGreaterThanOrEqual(rect[3])
  }
  expect(crop[3]).toBeLessThan(f.captions[0].rect[1])
})

const { nativeMultirowRasterPanelEvidence } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-panel-labels.mjs')).href
)
it.each([
  'caption',
  'table',
  'prose',
  'path',
  'missing image',
  'duplicate operation',
  'source segment alias',
  'source token alias',
  'plural carrier alias',
  'same-token dual carrier',
  'literal mismatch',
  'native rectangle mismatch',
  'glyph literal',
  'glyph advance',
  'glyph position',
  'invalid clip',
  'unbalanced state',
  'unknown effect',
  'short viewport',
  'repeated key',
  'missing label',
  'independent side image'
])('retains the legacy photo result when native ownership fails: %s', (fault) => {
  const f = nativePhotoRows(),
    o = f.context.operators
  if (fault === 'caption') f.captions.push({ ...f.captions[0], rect: [300, 174, 500, 181] })
  if (fault === 'table') f.tables.push([200, 174, 240, 181])
  if (fault === 'path')
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: 999,
      normalizedRect: [200 / 600, 174 / 800, 240 / 600, 181 / 800]
    })
  if (fault === 'prose') {
    const sourceItem = {
      pageNumber: 1,
      index: f.context.content.items.length,
      text: 'Independent paragraph.'
    }
    f.context.content.items.push({
      str: sourceItem.text,
      sourceItem,
      transform: [9, 0, 0, 9, 200, 617],
      width: 100,
      height: 9,
      dir: 'ltr',
      fontName: 'Body'
    })
    f.tokens.push({
      text: sourceItem.text,
      sourceItem: { ...sourceItem },
      rect: [200, 174, 300, 183],
      horizontal: true
    })
  }
  if (fault === 'missing image') f.page.graphicsBounds.splice(2, 1)
  if (fault === 'duplicate operation') f.page.graphicsBounds.push({ ...f.page.graphicsBounds[0] })
  if (fault === 'source segment alias') f.tokens[1].sourceSegment = { ...f.tokens[0].sourceItem }
  if (fault === 'source token alias')
    f.tokens[1].sourceToken = { sourceItem: { ...f.tokens[0].sourceItem } }
  if (fault === 'plural carrier alias')
    f.context.content.items[1].sourceItems = [{ ...f.tokens[0].sourceItem }]
  if (fault === 'same-token dual carrier') f.tokens[0].sourceSegment = { ...f.tokens[0].sourceItem }
  if (fault === 'literal mismatch') f.tokens[0].sourceItem.text += ' Changed'
  if (fault === 'native rectangle mismatch') f.tokens[0].rect[0] += 5
  const glyphIndex = o.fnArray.indexOf(OPS.showText)
  if (fault === 'glyph literal') o.argsArray[glyphIndex][0][5].unicode = 'Z'
  if (fault === 'glyph advance') o.argsArray[glyphIndex][0][5].width += 50
  if (fault === 'glyph position') o.argsArray[glyphIndex - 1][0] += 30
  if (fault === 'invalid clip')
    o.argsArray[o.fnArray.indexOf(OPS.paintFormXObjectBegin)][1][2] = NaN
  if (fault === 'unbalanced state') o.fnArray[o.fnArray.indexOf(OPS.restore)] = OPS.save
  if (fault === 'unknown effect') {
    o.fnArray.push(OPS.setGState)
    o.argsArray.push([[['SMask', true]]])
  }
  if (fault === 'short viewport') f.context.viewport.transform = [1, 0]
  if (fault === 'repeated key') {
    const replacement = f.tokens[1].text.replace('(b)', '(a)')
    f.tokens[1].text = replacement
    f.tokens[1].sourceItem.text = replacement
    f.context.content.items[1].str = replacement
    f.context.content.items[1].sourceItem.text = replacement
  }
  if (fault === 'missing label') {
    f.tokens.splice(0, 1)
    f.context.content.items[0].str = ''
  }
  if (fault === 'independent side image') {
    const at = glyphIndex - 3
    o.fnArray.splice(at, 0, OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore)
    o.argsArray.splice(at, 0, null, [40, 0, 0, 40, 520, 660], ['side-image', 100, 100], null)
    for (const g of f.page.graphicsBounds) if (g.operationIndex >= at) g.operationIndex += 4
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex: at + 2,
      normalizedRect: [520 / 600, 100 / 800, 560 / 600, 140 / 800]
    })
  }
  expect(
    nativeMultirowRasterPanelEvidence(f.page, f.captions, f.tables, f.tokens, f.context)
  ).toBeUndefined()
  expect(photoAssociation(f)).toEqual(photoAssociation(f, false))
})

it('checks the entire proposed final envelope rather than only the original photo rows', () => {
  const f = nativePhotoRows(),
    proof = nativeMultirowRasterPanelEvidence(f.page, f.captions, f.tables, f.tokens, f.context)
  expect(proof).toBeDefined()
  expect(proof.accepts([90, 70, 510, 310])).toBe(true)
  expect(proof.accepts([90, 70, 510, 330])).toBe(false) // Independent figure caption.
  expect(proof.accepts([130, 190, 490, 301])).toBe(false) // Partial plate is not complete.
})
it.each([false, true])(
  'checks full original inventory when filtered figure tokens omit a native item (inside=%s)',
  (inside) => {
    const f = nativePhotoRows()
    const sourceItem = {
      pageNumber: 1,
      index: f.context.content.items.length,
      text: 'Independent text'
    }
    f.context.content.items.push({
      str: sourceItem.text,
      sourceItem,
      transform: [9, 0, 0, 9, 200, inside ? 617 : 760],
      width: 100,
      height: 9,
      dir: 'ltr',
      fontName: 'Body'
    })
    const proof = nativeMultirowRasterPanelEvidence(
      f.page,
      f.captions,
      f.tables,
      f.tokens,
      f.context
    )
    if (inside) {
      expect(proof).toBeUndefined()
      expect(photoAssociation(f)).toEqual(photoAssociation(f, false))
    } else {
      expect(proof).toBeDefined()
      expect(photoAssociation(f)[0].rect[1]).toBeLessThanOrEqual(80)
    }
  }
)
it('publishes only the four whole native panel-label owners after full crop validation', () => {
  const f = nativePhotoRows(),
    result = photoAssociation(f)
  expect(result[0].sourceItems).toEqual(
    f.tokens.slice(0, 4).map((t: { sourceItem: unknown }) => t.sourceItem)
  )
})
it('includes complete native font ascent/descent bounds for whole-label consumers', () => {
  const f = nativePhotoRows()
  f.context.content.styles = { Body: { ascent: 0.6, descent: -0.4, vertical: false } }
  expect(photoAssociation(f)[0].rect[3]).toBeGreaterThanOrEqual(304.6)
})
it.each([
  { name: 'inside the new descent band', size: 1, x: 200, y: 497, width: 10 },
  { name: 'outside with descent crossing the plate', size: 10, x: 150, y: 720, width: 80 }
])('rejects independent text $name', ({ size, x, y, width }) => {
  const f = nativePhotoRows()
  f.context.content.styles = { Body: { ascent: 0.6, descent: -0.4, vertical: false } }
  const sourceItem = { pageNumber: 1, index: f.context.content.items.length, text: 'Other' }
  f.context.content.items.push({
    str: sourceItem.text,
    sourceItem,
    transform: [size, 0, 0, size, x, y],
    width,
    height: size,
    dir: 'ltr',
    fontName: 'Body'
  })
  expect(
    nativeMultirowRasterPanelEvidence(f.page, f.captions, f.tables, f.tokens, f.context)
  ).toBeUndefined()
  expect(photoAssociation(f)).toEqual(photoAssociation(f, false))
})
it('rejects a native painted path absent from the recorded graphic inventory', () => {
  const f = nativePhotoRows()
  f.context.operators.fnArray.push(OPS.constructPath)
  f.context.operators.argsArray.push([
    OPS.stroke,
    [new Float32Array([0, 150, 620, 1, 230, 620])],
    new Float32Array([150, 620, 230, 620])
  ])
  expect(
    nativeMultirowRasterPanelEvidence(f.page, f.captions, f.tables, f.tokens, f.context)
  ).toBeUndefined()
})
it('allows a filtered margin stroke only when its complete native paint is outside the plate', () => {
  const f = nativePhotoRows()
  f.context.operators.fnArray.push(OPS.constructPath)
  f.context.operators.argsArray.push([
    OPS.stroke,
    [new Float32Array([0, 100, 760, 1, 500, 760])],
    new Float32Array([100, 760, 500, 760])
  ])
  const proof = nativeMultirowRasterPanelEvidence(f.page, f.captions, f.tables, f.tokens, f.context)
  expect(proof).toBeDefined()
  expect(proof.accepts([90, 70, 510, 310])).toBe(true)
  expect(proof.accepts([90, 30, 510, 310])).toBe(false)
})
it.each(['invalid cap', 'wide stroke', 'unsupported curve'])(
  'rejects an unproved filtered stroke: %s',
  (fault) => {
    const f = nativePhotoRows(),
      o = f.context.operators
    if (fault === 'invalid cap') {
      o.fnArray.push(OPS.setLineCap)
      o.argsArray.push([7])
    }
    if (fault === 'wide stroke') {
      o.fnArray.push(OPS.setLineWidth)
      o.argsArray.push([100])
    }
    o.fnArray.push(OPS.constructPath)
    o.argsArray.push([
      OPS.stroke,
      [
        new Float32Array(
          fault === 'unsupported curve'
            ? [0, 100, 760, 2, 200, 760, 300, 760, 500, 760]
            : [0, 100, 760, 1, 500, 760]
        )
      ],
      new Float32Array([100, 760, 500, 760])
    ])
    expect(
      nativeMultirowRasterPanelEvidence(f.page, f.captions, f.tables, f.tokens, f.context)
    ).toBeUndefined()
  }
)
