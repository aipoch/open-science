import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { collectTableRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const anonymousOpenAxisBottom = (): ReturnType<typeof JSON.parse> => {
  const width = 400,
    height = 300,
    fnArray = [],
    argsArray = [],
    items = [],
    tokens = [],
    lines = [],
    graphicsBounds = [],
    glyphs = []
  const add = (op: number, args: ReturnType<typeof JSON.parse>): void => {
    fnArray.push(op)
    argsArray.push(args)
  }
  const viewport = {
    width,
    height,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, height],
    convertToViewportPoint: (x, y) => [x, height - y]
  }
  const programs = ['0', '1', '2', 'X'].map((unicode) => ({
    operatorListId: unicode,
    unicode,
    width: 500,
    kind: 'filled-path',
    bounds: [0, -100, 500, 700],
    clip: [0, -100, 500, 700],
    paint: OPS.fill,
    occurrences: []
  }))
  const path = (r: number[], kind: number = OPS.fill): void => {
    const [x0, y0, x1, y1] = r,
      index = fnArray.length
    const p =
      kind === OPS.stroke
        ? [0, x0, height - y0, 1, x1, height - y1]
        : [0, x0, height - y0, 1, x1, height - y0, 1, x1, height - y1, 1, x0, height - y1, 4]
    add(OPS.constructPath, [kind, [p], [x0, height - y1, x1, height - y0]])
    graphicsBounds.push({
      operationIndex: index,
      kind: 'path',
      normalizedRect: [x0 - 0.25, y0 - 0.25, x1 + 0.25, y1 + 0.25].map(
        (n, i) => n / (i % 2 ? height : width)
      )
    })
  }
  const show = (text: string, x: number, y: number, size: number, font: string): void => {
    add(OPS.beginText, null)
    add(OPS.setFont, [font, size])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - y]])
    const g: ReturnType<typeof JSON.parse> = {
      unicode: text,
      fontChar: font === 'T' ? '' : text,
      width: 500 * text.length,
      isInFont: true,
      isSpace: false,
      accent: null
    }
    if (font === 'T') {
      const program = programs.find((p) => p.unicode === text)
      g.operatorListId = program.operatorListId
      program.occurrences.push({ operationIndex: fnArray.length, glyphIndex: 0 })
    } else if (!glyphs.some((g) => g.fontChar === text))
      glyphs.push({ fontChar: text, bounds: [0, -0.1, 0.5 * text.length, 0.7] })
    add(OPS.showText, [[g]])
    add(OPS.endText, null)
    const raw = {
      str: text,
      dir: 'ltr',
      width: size * 0.5 * text.length,
      height: size,
      transform: [size, 0, 0, size, x, height - y],
      fontName: font,
      hasEOL: false,
      sourceItem: { pageNumber: 1, index: items.length, text }
    }
    items.push(raw)
    tokens.push(tableTextToken(raw, viewport, 0))
    lines.push({ text, x, y: y - size, width: raw.width, height: size, fontSize: size })
  }
  const starts = [30, 140, 250]
  for (const [panel, x] of starts.entries()) {
    add(OPS.paintFormXObjectBegin, [null, [x, 90, x + 100, 240]])
    add(OPS.setFillRGBColor, ['#ffffff'])
    path([x, 60, x + 100, 210])
    add(OPS.setFillRGBColor, ['#000000'])
    add(OPS.setStrokeRGBColor, ['#000000'])
    add(OPS.setLineWidth, [0.5])
    add(OPS.setMiterLimit, [1])
    path([x + 15, 80, x + 15, 180], OPS.stroke)
    path([x + 15, 180, x + 95, 180], OPS.stroke)
    path([x + 14.8, 79.8, x + 24.8, 130])
    path([x + 86, 110, x + 95.2, 150])
    for (let n = 0; n < 3; n++) show(String(n), x + 20 + n * 30, 185, 5, 'T')
    show('X', x + 50, 205, 6, 'T')
    add(OPS.paintFormXObjectEnd, null)
    show(`(${String.fromCharCode(97 + panel)})`, x + 48, 220, 8, 'F')
  }
  show('C', 40, 253, 8, 'F')
  const caption = { page: 1, lines: ['Figure 1. Panels.'], rect: [30, 240, 370, 258] }
  const context = {
    operators: { fnArray, argsArray },
    viewport,
    content: {
      items,
      styles: {
        F: { ascent: 0.7, descent: -0.1, vertical: false },
        T: { ascent: 0.7, descent: -0.1, vertical: false }
      }
    },
    partialFontGlyphBounds: [{ fontName: 'F', glyphs }],
    type3GlyphPrograms: [
      {
        fontName: 'T',
        fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        sourceIndices: items.flatMap((r, i) => (r.fontName === 'T' ? [i] : [])),
        glyphs: programs
      }
    ],
    graphicsBounds
  }
  return {
    page: { pageNumber: 1, width, height, invalidGraphicsBounds: 0, lines, graphicsBounds },
    figure: { rect: [40, 75, 360, 194], caption },
    captions: [caption],
    tables: [],
    tokens,
    context
  }
}

const associate = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  associateFigures(
    f.page,
    f.captions,
    f.tables,
    collectTableRules(f.context.operators, f.context.viewport),
    [],
    f.tokens,
    f.context
  )
it('includes complete source font envelopes and continued Type3 axis rows below three open panels', () => {
  const f = anonymousOpenAxisBottom(),
    before = JSON.stringify(f),
    figures = associate(f)
  expect(figures).toHaveLength(1)
  expect(figures[0].rect).toEqual([44.55, 79.55, 345.45, 222.4])
  expect(figures[0].sourceItems).toEqual(
    [3, 8, 13].map((index) => ({ pageNumber: 1, index, text: 'X' }))
  )
  expect(JSON.stringify(f)).toBe(before)
})
const { nativeOpenAxisBottomBounds } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-open-axis-bottom.mjs')).href
)
const prove = (f: ReturnType<typeof JSON.parse>): number[] | undefined =>
  nativeOpenAxisBottomBounds(f.page, f.figure, f.captions, f.tables, f.tokens, f.context)
it.each([
  'missing typed program',
  'missing ordinary outline',
  'detached L',
  'nested Form',
  'foreign native glyph',
  'foreign path',
  'nonrectangular background',
  'caption intrusion',
  'table intrusion',
  'missing source'
])('preserves the crop when %s prevents complete ownership', (mode) => {
  const f = anonymousOpenAxisBottom(),
    c = f.context,
    o = c.operators
  if (mode === 'missing typed program') c.type3GlyphPrograms[0].glyphs.pop()
  if (mode === 'missing ordinary outline') c.partialFontGlyphBounds[0].glyphs.pop()
  if (mode === 'detached L') o.argsArray[8][1][0][1] += 0.1
  if (mode === 'nested Form') {
    o.fnArray.unshift(OPS.paintFormXObjectBegin)
    o.argsArray.unshift([null, [0, 0, 400, 300]])
    o.fnArray.push(OPS.paintFormXObjectEnd)
    o.argsArray.push(null)
    for (const p of c.type3GlyphPrograms[0].glyphs)
      for (const occurrence of p.occurrences) occurrence.operationIndex++
    for (const g of f.page.graphicsBounds) g.operationIndex++
  }
  if (mode === 'foreign native glyph') {
    const i = c.content.items.length - 1,
      r = c.content.items[i],
      line = f.page.lines[i]
    r.transform[4] = 100
    r.transform[5] = 85
    Object.assign(line, { x: 100, y: 207 })
    f.tokens[i] = tableTextToken(r, c.viewport, 0)
    const matrix = o.fnArray.lastIndexOf(OPS.setTextMatrix)
    o.argsArray[matrix][0] = [1, 0, 0, 1, 100, 85]
  }
  if (mode === 'foreign path') {
    const i = o.fnArray.length
    o.fnArray.push(OPS.constructPath)
    o.argsArray.push([
      OPS.fill,
      [[0, 100, 88, 1, 110, 88, 1, 110, 82, 1, 100, 82, 4]],
      [100, 82, 110, 88]
    ])
    f.page.graphicsBounds.push({
      operationIndex: i,
      kind: 'path',
      normalizedRect: [100 / 400, 212 / 300, 110 / 400, 218 / 300]
    })
  }
  if (mode === 'nonrectangular background') o.argsArray[2][1][0][4]--
  if (mode === 'caption intrusion') f.figure.caption.rect[1] = 222
  if (mode === 'table intrusion') f.tables.push([100, 214, 130, 220])
  if (mode === 'missing source') c.content.items.pop()
  const before = JSON.stringify(f)
  expect(prove(f)).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})

const withPlainFirstRow = (obstruction?: string): ReturnType<typeof JSON.parse> => {
  const f = anonymousOpenAxisBottom()
  f.figure.rect[3] = 202
  const c = f.context,
    o = c.operators,
    program = c.type3GlyphPrograms[0],
    continuation = c.content.items[13],
    at = program.glyphs.find((p) => p.unicode === 'X').occurrences[2].operationIndex - 3,
    size = continuation.height,
    x = continuation.transform[4],
    y = continuation.transform[5] + size * 1.2,
    glyph = {
      unicode: 'Y',
      fontChar: '',
      operatorListId: 'Y',
      width: 500,
      isInFont: true,
      isSpace: false,
      accent: null
    },
    added = [
      [OPS.beginText, null],
      [OPS.setFont, ['T', size]],
      [OPS.setTextMatrix, [[1, 0, 0, 1, x, y]]],
      [OPS.showText, [[glyph]]],
      [OPS.endText, null]
    ]
  for (const p of program.glyphs)
    for (const occurrence of p.occurrences)
      if (occurrence.operationIndex >= at) occurrence.operationIndex += added.length
  for (const g of f.page.graphicsBounds)
    if (g.operationIndex >= at) g.operationIndex += added.length
  o.fnArray.splice(at, 0, ...added.map((entry) => entry[0]))
  o.argsArray.splice(at, 0, ...added.map((entry) => entry[1]))
  c.content.items.splice(13, 0, {
    ...continuation,
    str: 'Y',
    transform: [size, 0, 0, size, x, y]
  })
  for (const [index, item] of c.content.items.entries())
    item.sourceItem = { pageNumber: 1, index, text: item.str }
  program.sourceIndices = c.content.items.flatMap((item, index) =>
    item.fontName === 'T' ? [index] : []
  )
  program.glyphs.push({
    operatorListId: 'Y',
    unicode: 'Y',
    width: 500,
    kind: 'filled-path',
    bounds: [0, -100, 500, 700],
    clip: [0, -100, 500, 700],
    paint: OPS.fill,
    occurrences: [{ operationIndex: at + 3, glyphIndex: 0 }]
  })
  f.page.lines.push({
    text: 'Y',
    x,
    y: f.page.height - y - size,
    width: size / 2,
    height: size,
    fontSize: size
  })
  if (obstruction === 'foreign glyph in blank band') {
    o.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    o.argsArray.push(
      null,
      ['F', size],
      [[1, 0, 0, 1, x + 10, y]],
      [[{ ...glyph, unicode: 'Z', fontChar: 'Z', operatorListId: undefined }]],
      null
    )
    c.partialFontGlyphBounds[0].glyphs.push({ fontChar: 'Z', bounds: [0, -0.1, 0.5, 0.7] })
    c.content.items.push({
      ...continuation,
      str: 'Z',
      fontName: 'F',
      transform: [size, 0, 0, size, x + 10, y],
      sourceItem: { pageNumber: 1, index: c.content.items.length, text: 'Z' }
    })
    f.page.lines.push({
      text: 'Z',
      x: x + 10,
      y: f.page.height - y - size,
      width: size / 2,
      height: size,
      fontSize: size
    })
  } else if (obstruction) {
    const rect =
        obstruction === 'nontext in source advance'
          ? [x + 0.2, 192.2, x + 0.8, 192.6]
          : [x + 1, 198.6, x + 2, 198.8],
      [left, top, right, bottom] = rect,
      h = f.page.height,
      operationIndex = o.fnArray.length
    o.fnArray.push(OPS.constructPath)
    o.argsArray.push([
      OPS.fill,
      [[0, left, h - top, 1, right, h - top, 1, right, h - bottom, 1, left, h - bottom, 4]],
      [left, h - bottom, right, h - top]
    ])
    f.page.graphicsBounds.push({
      operationIndex,
      kind: 'path',
      normalizedRect: rect.map((n, i) => n / (i % 2 ? h : f.page.width))
    })
  }
  f.tokens = c.content.items.map((item) => tableTextToken(item, c.viewport, 0))
  return f
}

it('publishes a complete plain first row above an independently proved axis continuation', () => {
  const f = withPlainFirstRow(),
    before = JSON.stringify(f),
    evidence = nativeOpenAxisBottomEvidence(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context
    )
  expect(evidence?.rect).toEqual([40, 75, 360, 222.4])
  expect(evidence?.sourceItems).toEqual(
    [3, 8, 13, 14].map((index) => ({ pageNumber: 1, index, text: index === 13 ? 'Y' : 'X' }))
  )
  expect(JSON.stringify(f)).toBe(before)
})

it.each(['nontext in source advance', 'nontext in interline gap', 'foreign glyph in blank band'])(
  'retains independent continuation claims when a plain first row has %s',
  (obstruction) => {
    const f = withPlainFirstRow(obstruction),
      before = JSON.stringify(f),
      evidence = nativeOpenAxisBottomEvidence(
        f.page,
        f.figure,
        f.captions,
        f.tables,
        f.tokens,
        f.context
      )
    expect(evidence?.rect).toEqual([40, 75, 360, 222.4])
    expect(evidence?.sourceItems).toEqual(
      [3, 8, 14].map((index) => ({ pageNumber: 1, index, text: 'X' }))
    )
    expect(JSON.stringify(f)).toBe(before)
  }
)
it('refuses an axis whose source ticks are erased by a later native Form background', () => {
  const f = anonymousOpenAxisBottom(),
    c = f.context,
    o = c.operators
  const order = o.fnArray.map((_: number, i: number) => i),
    ticks = order.splice(11, 15)
  order.splice(1, 0, ...ticks)
  const remap = new Map(order.map((old: number, index: number) => [old, index]))
  o.fnArray = order.map((i: number) => o.fnArray[i])
  o.argsArray = order.map((i: number) => o.argsArray[i])
  for (const program of c.type3GlyphPrograms[0].glyphs)
    for (const occurrence of program.occurrences)
      occurrence.operationIndex = remap.get(occurrence.operationIndex)
  for (const graphic of f.page.graphicsBounds)
    graphic.operationIndex = remap.get(graphic.operationIndex)
  const before = JSON.stringify(f)
  expect(prove(f)).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
const { nativeOpenAxisBottomEvidence } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-open-axis-bottom.mjs')).href
)
it.each([
  'old-band continuation cover',
  'old-band tick cover',
  'foreign native old-band glyph',
  'earlier foreign old-band fill'
])('retains the old crop but publishes no source claim for %s', (mode) => {
  const f = anonymousOpenAxisBottom(),
    c = f.context,
    o = c.operators
  if (mode !== 'old-band tick cover') f.figure.rect[3] = 201
  if (mode === 'foreign native old-band glyph') {
    const index = c.content.items.length - 1,
      raw = c.content.items[index]
    raw.transform[4] = 80
    raw.transform[5] = 98.5
    Object.assign(f.page.lines[index], { x: 80, y: 193.5 })
    f.tokens[index] = tableTextToken(raw, c.viewport, 0)
    o.argsArray[o.fnArray.lastIndexOf(OPS.setTextMatrix)][0] = [1, 0, 0, 1, 80, 98.5]
  } else {
    const r = mode === 'old-band tick cover' ? [48, 180, 115, 186] : [80, 200.8, 82, 201.8],
      h = f.page.height,
      index = o.fnArray.length + 1
    o.fnArray.push(OPS.setFillRGBColor, OPS.constructPath)
    o.argsArray.push(
      ['#ffffff'],
      [
        OPS.fill,
        [[0, r[0], h - r[1], 1, r[2], h - r[1], 1, r[2], h - r[3], 1, r[0], h - r[3], 4]],
        [r[0], h - r[3], r[2], h - r[1]]
      ]
    )
    f.page.graphicsBounds.push({
      operationIndex: index,
      kind: 'path',
      normalizedRect: r.map((n, i) => n / (i % 2 ? h : f.page.width))
    })
    if (mode === 'earlier foreign old-band fill') {
      const order = o.fnArray.map((_: number, i: number) => i),
        added = order.splice(-2)
      order.splice(11, 0, ...added)
      const remap = new Map(order.map((old: number, index: number) => [old, index]))
      o.fnArray = order.map((i: number) => o.fnArray[i])
      o.argsArray = order.map((i: number) => o.argsArray[i])
      // Restore the ordinary black parent paint before the first Type3 tick.
      o.argsArray[11] = ['#000000']
      for (const p of c.type3GlyphPrograms[0].glyphs)
        for (const occurrence of p.occurrences)
          occurrence.operationIndex = remap.get(occurrence.operationIndex)
      for (const g of f.page.graphicsBounds) g.operationIndex = remap.get(g.operationIndex)
    }
  }
  const before = JSON.stringify(f)
  expect(prove(f)).toEqual([40, 75, 360, 222.4])
  expect(
    nativeOpenAxisBottomEvidence?.(f.page, f.figure, f.captions, f.tables, f.tokens, f.context)
      ?.sourceItems
  ).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
const withTickPrimitive = (mode: string): ReturnType<typeof JSON.parse> => {
  const f = anonymousOpenAxisBottom(),
    c = f.context,
    o = c.operators
  const h = f.page.height,
    top = mode === 'detached tick' ? 179.9 : 180,
    x = 51.25
  const line =
    mode === 'curve'
      ? [0, x, h - top, 2, x, h - 180.3, x, h - 180.6, x, h - 181]
      : mode === 'nonzero fill'
        ? [0, x - 0.2, h - top, 1, x + 0.2, h - top, 1, x + 0.2, h - 181, 1, x - 0.2, h - 181, 4]
        : [0, x, h - top, 1, x, h - 181]
  const bounds =
    mode === 'nonzero fill' ? [x - 0.2, h - 181, x + 0.2, h - top] : [x, h - 181, x, h - top]
  const start = o.fnArray.length
  o.fnArray.push(OPS.save)
  o.argsArray.push(null)
  o.fnArray.push(OPS.setMiterLimit)
  o.argsArray.push([10])
  if (mode === 'wide') {
    o.fnArray.push(OPS.setLineWidth)
    o.argsArray.push([6])
  }
  if (mode === 'wide within old crop') {
    o.fnArray.push(OPS.setMiterLimit, OPS.setLineWidth)
    o.argsArray.push([1], [4])
  }
  if (mode === 'square cap') {
    o.fnArray.push(OPS.setLineCap)
    o.argsArray.push([2])
  }
  if (mode === 'rotated') {
    const cos = Math.cos(0.2),
      sin = Math.sin(0.2),
      y = h - top
    o.fnArray.push(OPS.transform)
    o.argsArray.push([cos, sin, -sin, cos, x - cos * x + sin * y, y - sin * x - cos * y])
  }
  if (mode === 'foreign Form') {
    o.fnArray.push(OPS.paintFormXObjectBegin)
    o.argsArray.push([null, [0, 0, f.page.width, h]])
  }
  const paint = o.fnArray.length
  o.fnArray.push(OPS.constructPath)
  o.argsArray.push([OPS.fillStroke, [line], bounds])
  if (mode === 'extra subpath') o.argsArray[paint][1].push([0, 80, 100, 1, 82, 98])
  f.page.graphicsBounds.push({
    operationIndex: paint,
    kind: 'path',
    normalizedRect: [x - 0.2, top, x + 0.2, 181].map((n, i) => n / (i % 2 ? h : f.page.width))
  })
  if (mode === 'foreign Form') {
    o.fnArray.push(OPS.paintFormXObjectEnd)
    o.argsArray.push(null)
  }
  o.fnArray.push(OPS.restore)
  o.argsArray.push(null)
  const order = o.fnArray.map((_: number, i: number) => i),
    appended = order.splice(start)
  order.splice(mode === 'late' ? 16 : 11, 0, ...appended)
  const remap = new Map(order.map((old: number, index: number) => [old, index]))
  o.fnArray = order.map((i: number) => o.fnArray[i])
  o.argsArray = order.map((i: number) => o.argsArray[i])
  for (const p of c.type3GlyphPrograms[0].glyphs)
    for (const occurrence of p.occurrences)
      occurrence.operationIndex = remap.get(occurrence.operationIndex)
  for (const g of f.page.graphicsBounds) g.operationIndex = remap.get(g.operationIndex)
  return f
}
it('proves a zero-area fillStroke tick without a fictitious miter join over its following glyph', () => {
  const f = withTickPrimitive('butt'),
    before = JSON.stringify(f)
  expect(prove(f)).toEqual([40, 75, 360, 222.4])
  expect(
    nativeOpenAxisBottomEvidence(f.page, f.figure, f.captions, f.tables, f.tokens, f.context)
      ?.sourceItems
  ).toEqual([3, 8, 13].map((index) => ({ pageNumber: 1, index, text: 'X' })))
  expect(JSON.stringify(f)).toBe(before)
})
it.each([
  'wide',
  'wide within old crop',
  'square cap',
  'rotated',
  'curve',
  'nonzero fill',
  'late',
  'foreign Form',
  'detached tick',
  'extra subpath'
])('does not bypass full ownership exclusions for a %s primitive', (mode) => {
  const f = withTickPrimitive(mode),
    before = JSON.stringify(f),
    bounds = prove(f)
  const evidence = nativeOpenAxisBottomEvidence(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    f.context
  )
  expect(evidence?.rect).toEqual(bounds)
  expect(evidence?.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})

import { createCanvas } from '@napi-rs/canvas'
it('does not claim a whole first row whose covered overhang leaves the exclusive axis band', () => {
  const f = withPlainFirstRow(),
    c = f.context,
    o = c.operators
  const program = c.type3GlyphPrograms[0].glyphs.find((p) => p.unicode === 'Y')
  const index = program.occurrences[0].operationIndex,
    raw = c.content.items[13]
  const center = raw.transform[4] + raw.width / 2,
    x = center - 45
  program.width = 15000
  program.bounds = [0, -100, 15000, 700]
  program.clip = [...program.bounds]
  o.argsArray[index][0][0].width = 15000
  raw.width = 90
  raw.transform[4] = x
  o.argsArray[index - 1][0][4] = x
  const line = f.page.lines.find((l) => l.text === 'Y')
  line.x = x
  line.width = 90
  f.tokens = c.content.items.map((r) => tableTextToken(r, c.viewport, 0))
  const rect = [257, 194.2, 258, 194.8],
    h = f.page.height,
    op = o.fnArray.length
  o.fnArray.push(OPS.constructPath)
  o.argsArray.push([
    OPS.fill,
    [
      [
        0,
        rect[0],
        h - rect[1],
        1,
        rect[2],
        h - rect[1],
        1,
        rect[2],
        h - rect[3],
        1,
        rect[0],
        h - rect[3],
        4
      ]
    ],
    [rect[0], h - rect[3], rect[2], h - rect[1]]
  ])
  f.page.graphicsBounds.push({
    operationIndex: op,
    kind: 'path',
    normalizedRect: rect.map((n, i) => n / (i % 2 ? h : f.page.width))
  })
  const before = JSON.stringify(f),
    evidence = nativeOpenAxisBottomEvidence(f.page, f.figure, f.captions, f.tables, f.tokens, c)
  expect(evidence?.sourceItems?.map((s) => s.index)).toEqual([3, 8, 14])
  expect(evidence?.rect).toEqual([40, 75, 360, 222.4])
  expect(JSON.stringify(f)).toBe(before)
})
const { nativeFigureLabelBounds } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-crop-geometry.mjs')).href
)
const { nativeOpenAxisHeaderSourceItems } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-open-axis-bottom.mjs')).href
)
const anonymousHeaderPanels = (
  options: ReturnType<typeof JSON.parse> = {}
): ReturnType<typeof JSON.parse> => {
  const width = 400,
    height = 300,
    fnArray = [],
    argsArray = [],
    items = [],
    tokens = [],
    lines = [],
    graphicsBounds = [],
    ordinary = [],
    programs = [],
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x, y) => [x, height - y]
    }
  const add = (op: number, args: ReturnType<typeof JSON.parse>): void => {
      fnArray.push(op)
      argsArray.push(args)
    },
    path = (r: number[], kind = OPS.fill): void => {
      const [x0, y0, x1, y1] = r,
        index = fnArray.length,
        p =
          kind === OPS.stroke
            ? [0, x0, height - y0, 1, x1, height - y1]
            : [0, x0, height - y0, 1, x1, height - y0, 1, x1, height - y1, 1, x0, height - y1, 4]
      add(OPS.constructPath, [kind, [p], [x0, height - y1, x1, height - y0]])
      graphicsBounds.push({
        operationIndex: index,
        kind: 'path',
        normalizedRect: [x0 - 0.25, y0 - 0.25, x1 + 0.25, y1 + 0.25].map(
          (n, i) => n / (i % 2 ? height : width)
        )
      })
    }
  const show = (text: string, x: number, y: number, size: number, font = 'T'): number => {
    add(OPS.beginText, null)
    add(OPS.setFont, [font, size])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - y]])
    const gs = []
    for (const unicode of Array.from(text)) {
      const space = unicode === ' '
      let program
      if (font === 'T') {
        program = programs.find((p) => p.unicode === unicode)
        if (!program) {
          program = {
            operatorListId: 'u' + unicode.codePointAt(0),
            unicode,
            width: 500,
            kind: space ? 'empty-space' : 'filled-path',
            bounds: space ? [0, 0, 0, 0] : [0, -100, 500, 700],
            clip: space ? null : [0, -100, 500, 700],
            paint: OPS.fill,
            occurrences: []
          }
          programs.push(program)
        }
        program.occurrences.push({ operationIndex: fnArray.length, glyphIndex: gs.length })
      } else if (!ordinary.some((g) => g.fontChar === unicode))
        ordinary.push({ fontChar: unicode, bounds: space ? [0, 0, 0, 0] : [0, -0.1, 0.5, 0.7] })
      gs.push({
        unicode,
        fontChar: font === 'T' ? '' : unicode,
        width: 500,
        isInFont: true,
        isSpace: space,
        accent: null,
        ...(program ? { operatorListId: program.operatorListId } : {})
      })
    }
    add(OPS.showText, [gs])
    add(OPS.endText, null)
    const raw = {
      str: text,
      dir: 'ltr',
      width: size * 0.5 * text.length,
      height: size,
      transform: [size, 0, 0, size, x, height - y],
      fontName: font,
      hasEOL: false,
      sourceItem: { pageNumber: 1, index: items.length, text }
    }
    items.push(raw)
    tokens.push(tableTextToken(raw, viewport, 0))
    lines.push({ text, x, y: y - size, width: raw.width, height: size, fontSize: size })
    return raw.sourceItem.index
  }
  const titleIndices = [],
    titles = options.titles ?? ['Clear result', 'Another result', 'A short sentence'],
    em = options.headerSize ?? 8,
    baseline = options.headerBaseline ?? 72
  for (const [panel, x] of [30, 140, 250].entries()) {
    add(OPS.paintFormXObjectBegin, [null, [x, 90, x + 100, 240]])
    add(OPS.setFillRGBColor, [options.blackBackground ? '#000000' : '#ffffff'])
    path([x, 60, x + 100, 210])
    add(OPS.setFillRGBColor, ['#000000'])
    add(OPS.setStrokeRGBColor, ['#000000'])
    add(OPS.setLineWidth, [0.5])
    add(OPS.setMiterLimit, [1])
    path([x + 15, 80, x + 15, 180], OPS.stroke)
    path([x + 15, 180, x + 95, 180], OPS.stroke)
    path([x + 30, 100, x + 40, 130])
    path([x + 65, 110, x + 75, 150])
    for (let n = 0; n < 3; n++) show(String(n), x + 20 + n * 30, 185, 5)
    if (panel === 2) show('Y', x + 50, 197.8, 6)
    show('X', x + 50, 205, 6)
    if (options.titleOutsideForm) add(OPS.paintFormXObjectEnd, null)
    const tx = x + 55 - em * 0.25 * titles[panel].length + (options.headerShiftX ?? 0)
    if (options.ordinaryWhiteTitle) add(OPS.setFillRGBColor, ['#ffffff'])
    titleIndices.push(show(titles[panel], tx, baseline, em, options.ordinaryWhiteTitle ? 'F' : 'T'))
    if (panel === 0 && options.foreignProseInsideForm) show('External prose', x + 20, 65, 3, 'F')
    if (panel === 0 && options.pathInTitleSpace) {
      const offset = titles[panel].indexOf(' ')
      const px = tx + (offset + 0.3) * em * 0.5
      path([px, baseline - em * 0.55, px + em * 0.15, baseline - em * 0.2])
    }
    if (panel === 0 && options.equalFontBody) show('Body remark', x + 25, 140, em)
    if (!options.titleOutsideForm) add(OPS.paintFormXObjectEnd, null)
    if (panel === 0 && options.foreignProseOutsideForm) show('External prose', x + 20, 65, 3, 'F')
    show(`(${String.fromCharCode(97 + panel)})`, x + 48, 220, 8, 'F')
  }
  if (options.squareCapFringe) {
    add(OPS.save, null)
    add(OPS.setLineCap, [2])
    path([120, 80.3, 121, 81.3], OPS.stroke)
    add(OPS.restore, null)
  }
  const nativeKeys = options.nativeCaptionKeys ?? ['a', 'b', 'c'],
    metadataKeys = options.metadataCaptionKeys ?? nativeKeys,
    nativeCaption = 'Figure 1. Panels ' + nativeKeys.map((k) => `(${k})`).join(', ') + '.',
    captionText = 'Figure 1. Panels ' + metadataKeys.map((k) => `(${k})`).join(', ') + '.'
  if (options.captionKeyWhite) add(OPS.setFillRGBColor, ['#ffffff'])
  if (options.captionKeyTranslucent) add(OPS.setGState, [[['ca', 0.5]]])
  if (options.splitCaptionKey) {
    const cut = nativeCaption.indexOf('(a)') + 1
    show(nativeCaption.slice(0, cut), 40, 253, 8, 'F')
    show(nativeCaption.slice(cut), 40 + cut * 4, 253, 8, 'F')
  } else show(nativeCaption, 40, 253, 8, 'F')
  if (options.captionKeyPaint) {
    const x = 40 + nativeCaption.indexOf('(a)') * 4
    add(OPS.setFillRGBColor, ['#ffffff'])
    path([x, 247, x + 4, 254])
  }
  if (options.captionKeyForeignGlyph) {
    const x = 40 + nativeCaption.indexOf('(a)') * 4
    show('Z', x, 253, 8, 'F')
  }
  const caption = { page: 1, lines: [captionText], rect: [30, 240, 370, 258] },
    context = {
      operators: { fnArray, argsArray },
      viewport,
      content: {
        items,
        styles: {
          F: { ascent: 0.7, descent: -0.1, vertical: false },
          T: { ascent: 0.7, descent: -0.1, vertical: false }
        }
      },
      partialFontGlyphBounds: [{ fontName: 'F', glyphs: ordinary }],
      type3GlyphPrograms: [
        {
          fontName: 'T',
          fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
          sourceIndices: items.flatMap((r, i) => (r.fontName === 'T' ? [i] : [])),
          glyphs: programs
        }
      ],
      graphicsBounds
    }
  tokens.forEach((token) => {
    const raw = items[token.sourceItem.index]
    token.nativeLabelRect = nativeFigureLabelBounds(
      raw,
      context.content.styles[raw.fontName],
      viewport
    )
  })
  return {
    page: { pageNumber: 1, width, height, invalidGraphicsBounds: 0, lines, graphicsBounds },
    figure: { rect: [40, 64, 360, 202], caption },
    captions: [caption],
    tables: [],
    tokens,
    context,
    titleIndices,
    foreignRects: options.foreignRects ?? []
  }
}

const headerEvidence = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  nativeOpenAxisBottomEvidence(f.page, f.figure, f.captions, f.tables, f.tokens, f.context)
it('does not publish headings against an unproved dark Form background', () => {
  const f = anonymousHeaderPanels({ blackBackground: true }),
    before = JSON.stringify(f),
    evidence = headerEvidence(f)
  expect(evidence?.headerRaster).toBeUndefined()
  expect(evidence?.sourceItems?.map((s) => s.index)).toEqual([3, 9, 16])
  expect(evidence?.rect).toEqual(prove(f))
  expect(JSON.stringify(f)).toBe(before)
})
it('does not publish a plain first row against an unproved dark Form background', () => {
  const f = withPlainFirstRow(),
    o = f.context.operators
  for (const [i, op] of o.fnArray.entries())
    if (op === OPS.setFillRGBColor && o.argsArray[i]?.[0] === '#ffffff')
      o.argsArray[i] = ['#000000']
  const before = JSON.stringify(f),
    evidence = nativeOpenAxisBottomEvidence(
      f.page,
      f.figure,
      f.captions,
      f.tables,
      f.tokens,
      f.context
    )
  expect(evidence?.sourceItems?.map((s) => s.index)).toEqual([3, 8, 14])
  expect(evidence?.rect).toEqual([40, 75, 360, 222.4])
  expect(JSON.stringify(f)).toBe(before)
})
it('defers three arbitrary native panel headings until their actual PNG is sufficiently resolved', async () => {
  const f = anonymousHeaderPanels(),
    before = JSON.stringify(f),
    evidence = headerEvidence(f)
  expect(evidence?.sourceItems).toHaveLength(4)
  expect(evidence?.headerRaster?.sourceItems).toEqual(
    f.titleIndices.map((index: number) => f.context.content.items[index].sourceItem)
  )
  const figures = associate(f)
  expect(figures).toHaveLength(1)
  // The generic anonymous crop starts below the headings, so association must
  // not carry the optional certificate out of the direct native proof.
  expect(figures[0].headerRaster).toBeUndefined()
  const canvas = createCanvas(1280, Math.ceil((evidence.rect[3] - evidence.rect[1]) * 4)),
    png = await canvas.encode('png')
  expect(
    nativeOpenAxisHeaderSourceItems?.(
      png,
      evidence.rect,
      f.page,
      { ...f.figure, ...evidence },
      f.tokens
    )
  ).toEqual(evidence.headerRaster.sourceItems)
  expect(JSON.stringify(f)).toBe(before)
})
it.each([
  ['outside original native Form', { titleOutsideForm: true }],
  ['foreign prose in the full heading band', { foreignProseInsideForm: true }],
  ['nontext paint in heading whitespace', { pathInTitleSpace: true }],
  ['nonunique font hierarchy', { equalFontBody: true }],
  ['axis-crossing whole heading', { headerBaseline: 79.5 }],
  ['off-center heading', { headerShiftX: -14 }],
  [
    'missing native caption key',
    { nativeCaptionKeys: ['a', 'b'], metadataCaptionKeys: ['a', 'b', 'c'] }
  ],
  [
    'duplicated native caption key',
    { nativeCaptionKeys: ['a', 'b', 'b'], metadataCaptionKeys: ['a', 'b', 'c'] }
  ],
  [
    'reordered native caption keys',
    { nativeCaptionKeys: ['a', 'c', 'b'], metadataCaptionKeys: ['a', 'b', 'c'] }
  ],
  ['caption key assembled across sources', { splitCaptionKey: true }],
  ['caption key erased by a later opaque path', { captionKeyPaint: true }],
  ['caption key overwritten by a foreign glyph', { captionKeyForeignGlyph: true }],
  ['diagonal square cap entering the heading band', { squareCapFringe: true }],
  ['ordinary heading with unproved white paint', { ordinaryWhiteTitle: true }],
  ['white native caption-key paint', { captionKeyWhite: true }],
  ['translucent native caption-key paint', { captionKeyTranslucent: true }]
])('does not publish headings with %s', (_mode, options) => {
  const f = anonymousHeaderPanels(options),
    before = JSON.stringify(f),
    evidence = headerEvidence(f)
  expect(evidence?.sourceItems).toHaveLength(4)
  expect(evidence?.headerRaster).toBeUndefined()
  expect(evidence?.rect).toEqual(prove(f))
  expect(JSON.stringify(f)).toBe(before)
})
it.each([
  'low resolution',
  'malformed PNG',
  'NaN threshold',
  'extra certificate field',
  'missing font boundary',
  'conflicting original source'
])('withdraws only optional headings for %s', async (mode) => {
  const f = anonymousHeaderPanels(),
    evidence = headerEvidence(f),
    candidate = { ...f.figure, ...evidence },
    existing = JSON.stringify(candidate.sourceItems)
  expect(candidate.sourceItems).toHaveLength(4)
  expect(candidate.headerRaster?.sourceItems).toHaveLength(3)
  let png: Uint8Array = await createCanvas(
    1280,
    Math.ceil((evidence.rect[3] - evidence.rect[1]) * 4)
  ).encode('png')
  if (mode === 'low resolution') png = await createCanvas(1, 1).encode('png')
  if (mode === 'malformed PNG') png = new Uint8Array(20)
  if (mode === 'NaN threshold') candidate.headerRaster.minimumScaleExclusive = NaN
  if (mode === 'extra certificate field') candidate.headerRaster.unknown = true
  if (mode === 'missing font boundary')
    delete f.tokens.find((t) => t.sourceItem.index === f.titleIndices[0]).nativeLabelRect
  if (mode === 'conflicting original source')
    f.tokens.find((t) => t.sourceItem.index === f.titleIndices[0]).sourceItem.text =
      'Different source'
  expect(
    nativeOpenAxisHeaderSourceItems?.(png, evidence.rect, f.page, candidate, f.tokens)
  ).toBeUndefined()
  expect(JSON.stringify(candidate.sourceItems)).toBe(existing)
})
it('withdraws headers when the final crop keeps font metrics but clips proved glyph ink', async () => {
  const f = anonymousHeaderPanels(),
    program = f.context.type3GlyphPrograms[0].glyphs.find((p) => p.unicode === 'C')
  program.bounds = [0, -600, 500, 700]
  program.clip = [...program.bounds]
  const evidence = headerEvidence(f),
    candidate = { ...f.figure, ...evidence },
    before = JSON.stringify(candidate)
  expect(candidate.headerRaster?.sourceItems).toHaveLength(3)
  const rect = [40, 64, 360, 75],
    png = await createCanvas(1280, 44).encode('png')
  expect(nativeOpenAxisHeaderSourceItems(png, rect, f.page, candidate, f.tokens)).toBeUndefined()
  expect(JSON.stringify(candidate)).toBe(before)
})
