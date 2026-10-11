import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
const { nativeConnectedKeyedLegend, nativeFiniteTopRowKeyedLegend } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-connected-keyed-legend.mjs')).href
)
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
type Input = ReturnType<typeof JSON.parse>
const input = (): Input => {
  const caption = { page: 1, rect: [370, 90, 550, 190], lines: ['Figure 1. Connected diagram.'] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [{ text: caption.lines[0], x: 370, y: 90, width: 180, height: 10, fontSize: 10 }],
    graphicsBounds: []
  }
  const tokens: Input[] = [],
    paths: number[][] = [
      [40, 75, 330, 210],
      [105, 80, 285, 205],
      [155, 45, 205, 70],
      [160, 215, 195, 240]
    ]
  for (const y of [100, 160])
    for (const x of [120, 175, 230]) {
      paths.push([x, y, x + 28, y + 28])
      tokens.push({
        text: 'x',
        rect: [x + 8, y + 9, x + 16, y + 17],
        height: 8,
        baseline: y + 17,
        horizontal: true
      })
    }
  tokens.push(
    { text: 'a', rect: [175, 53, 183, 61], height: 8, baseline: 61, horizontal: true },
    { text: 'b', rect: [172, 223, 180, 231], height: 8, baseline: 231, horizontal: true }
  )
  for (const x of [40, 125])
    for (const y of [241, 253]) {
      paths.push([x, y, x + 12, y + 12])
      tokens.push({
        text: 'Key entry',
        rect: [x + 15, y + 1, x + 70, y + 9],
        height: 8,
        baseline: y + 9,
        horizontal: true
      })
    }
  page.graphicsBounds = paths.map((rect) => ({
    kind: 'path',
    normalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600))
  })) as never
  return { page, caption, captions: [caption], tables: [], tokens, oldBounds: [40, 55, 330, 232] }
}
const run = (f: Input): Input =>
  nativeConnectedKeyedLegend(f.page, f.caption, f.captions, f.tables, f.tokens, f.oldBounds)

// A small anonymous form: three line styles, two marker shapes, eight native
// plot fonts and a complete top legend. No original paper text or raw packet.
const topRowInput = (): Input => {
  const caption = {
    page: 1,
    rect: [60, 268, 520, 278],
    lines: ['Figure 1. (a) First plot. (b) Second plot. (c) Third plot.']
  }
  const f: Input = {
    page: {
      pageNumber: 1,
      width: 600,
      height: 800,
      lines: [],
      graphicsBounds: [],
      invalidGraphicsBounds: 0
    },
    caption,
    captions: [caption],
    tables: [],
    tokens: [],
    oldBounds: [80, 140, 500, 250],
    context: {
      viewport: {
        width: 600,
        height: 800,
        rotation: 0,
        transform: [1, 0, 0, -1, 0, 800],
        convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
      },
      operators: { fnArray: [], argsArray: [] }
    },
    source: { glyphs: [], keys: [], clips: [] }
  }
  const emit = (op: number, args: Input): number => {
    const i = f.context.operators.fnArray.length
    f.context.operators.fnArray.push(op)
    f.context.operators.argsArray.push(args)
    return i
  }
  const path = (kind: number, points: number[], box: number[], width = 0): number => {
    const raw = points.map((n, i) => (i % 3 === 2 ? 800 - n : n))
    const source = [box[0], 800 - box[3], box[2], 800 - box[1]]
    const i = emit(OPS.constructPath, [kind, [new Float32Array(raw)], new Float32Array(source)])
    if (kind !== OPS.endPath) {
      const guard = kind === OPS.stroke ? width / 2 : 0
      const r = [box[0] - guard, box[1] - guard, box[2] + guard, box[3] + guard]
      // Independent PDF.js diagnostic input, pinned to its documented tiles.
      f.page.graphicsBounds.push({
        operationIndex: i,
        kind: 'path',
        normalizedRect: r.map(
          (n, k) =>
            ((k < 2 ? Math.floor : Math.ceil)((n * 256) / (k % 2 ? 800 : 600)) + (k < 2 ? 0 : 1)) /
            256
        )
      })
    }
    return i
  }
  const rectangle = (r: number[]): number[] => [
    0,
    r[0],
    r[1],
    1,
    r[2],
    r[1],
    1,
    r[2],
    r[3],
    1,
    r[0],
    r[3],
    4
  ]
  const style = (color: string, dash: number[], width: number): void => {
    emit(OPS.setFillRGBColor, [color])
    emit(OPS.setStrokeRGBColor, [color])
    emit(OPS.setLineWidth, [width])
    emit(OPS.setDash, [dash, 0])
  }
  const text = (str: string, x: number, baseline: number): void => {
    emit(OPS.save, null)
    emit(OPS.transform, [1, 0, 0, 1, x, 800 - baseline])
    emit(OPS.beginText, null)
    emit(OPS.setFillRGBColor, ['#000000'])
    emit(OPS.setFont, ['anon', 7])
    emit(OPS.moveText, [0, 0])
    const i = emit(OPS.showText, [
      [...str].map((c) => ({
        unicode: c,
        fontChar: c,
        originalCharCode: c.charCodeAt(0),
        width: 500,
        isSpace: c === ' ',
        isInFont: true,
        accent: null
      }))
    ])
    f.source.glyphs.push(i)
    const token = {
      text: str,
      rect: [x, baseline - 7, x + str.length * 3.5, baseline],
      height: 7,
      baseline,
      horizontal: true,
      fontDescent: -0.2,
      sourceItem: { pageNumber: 1, index: f.tokens.length, text: str }
    }
    f.tokens.push(token)
    f.page.lines.push({
      text: str,
      x,
      y: baseline - 7,
      width: str.length * 3.5,
      height: 7,
      fontSize: 7
    })
    emit(OPS.endText, null)
    emit(OPS.restore, null)
  }
  const marker = (x: number, y: number, cross: boolean): number => {
    const points = cross
      ? [0, x, y, 1, x + 4, y + 4, 0, x, y + 4, 1, x + 4, y]
      : rectangle([x, y, x + 4, y + 4])
    return path(OPS.fillStroke, points, [x, y, x + 4, y + 4])
  }
  emit(OPS.dependency, ['anon'])
  emit(OPS.paintFormXObjectBegin, [null, new Float32Array([60, 540, 520, 700])])
  style('#ffffff', [], 0)
  path(OPS.fill, rectangle([60, 100, 520, 260]), [60, 100, 520, 260])
  const colors = ['#444444', '#aa8800', '#0088aa'],
    dashes = [[1, 2], [4, 2], []]
  for (let n = 0; n < 3; n++) {
    style(colors[n], dashes[n], 1)
    for (const y of [160 + n * 4, 190 + n * 4]) {
      const x = 100 + n * 120
      path(OPS.stroke, [0, x, y, 1, x + 50, y + 2, 1, x + 110, y], [x, y, x + 110, y + 2], 1)
    }
    path(
      OPS.stroke,
      [0, 100 + n * 120, 150, 1, 100 + n * 120, 230, 1, 210 + n * 120, 230],
      [100 + n * 120, 150, 210 + n * 120, 230],
      1
    )
  }
  style('#0088aa', [], 1)
  for (let n = 0; n < 3; n++) {
    marker(140 + n * 70, 220, false)
    marker(146 + n * 70, 222, true)
  }
  for (let n = 0; n < 8; n++)
    text(
      n < 3 ? `(${String.fromCharCode(97 + n)})` : 'x',
      120 + n * 40,
      n < 3 ? 149 : 180 + (n % 2) * 25
    )
  for (let n = 0; n < 3; n++) {
    style(colors[n], dashes[n], 1)
    const x = 80 + n * 120
    f.source.keys.push(
      path(OPS.stroke, [0, x, 119, 1, x + 3.5, 119, 1, x + 7, 119], [x, 119, x + 7, 119], 1)
    )
    text(['Alpha', 'Beta', 'Gamma'][n], x + 12, 122)
  }
  style('#444444', [], 1)
  for (let n = 0; n < 2; n++) {
    const x = 438 + n * 40
    f.source.keys.push(marker(x, 117, n === 1))
    text(String(n + 1), x + 9, 122)
  }
  emit(OPS.paintFormXObjectEnd, [])
  f.page.lines.push({ text: caption.lines[0], x: 60, y: 268, width: 460, height: 10, fontSize: 10 })
  return f
}
const topRun = (f: Input): Input =>
  nativeFiniteTopRowKeyedLegend(
    f.page,
    f.caption,
    f.captions,
    f.tables,
    f.tokens,
    f.oldBounds,
    f.context
  )
// Keep every original native paint bound to its unchanged raw operator after
// inserting a refusal packet. These controls must fail on the new packet.
const insertTopOps = (f: Input, index: number, ops: number[], args: Input[]): void => {
  f.context.operators.fnArray.splice(index, 0, ...ops)
  f.context.operators.argsArray.splice(index, 0, ...args)
  for (const g of f.page.graphicsBounds)
    if (g.operationIndex >= index) g.operationIndex += ops.length
}
it('owns the finite form, whole top fonts and independently repeated line and marker keys', () => {
  const f = topRowInput()
  expect(topRun(f)?.rect).toEqual([60, 100, 520, 260])
  expect(topRun({ ...f, oldBounds: [60, 100, 520, 260] })).toBeUndefined()
})
it('binds a sideways whole font and keeps an original literal space without trusting isSpace', () => {
  const f = topRowInput(),
    o = f.context.operators,
    t = f.tokens[3]
  o.argsArray[f.source.glyphs[3] - 5] = [0, 1, -1, 0, 240, 595]
  t.rect = [233, 201.5, 240, 205]
  t.horizontal = false
  const first = f.tokens[0],
    glyphs = o.argsArray[f.source.glyphs[0]][0]
  first.text = 'a a'
  first.sourceItem.text = 'a a'
  for (let n = 0; n < 3; n++) {
    glyphs[n].unicode = first.text[n]
    glyphs[n].fontChar = first.text[n]
    glyphs[n].originalCharCode = first.text.charCodeAt(n)
  }
  glyphs[1].isSpace = false
  glyphs[1].isInFont = false
  expect(topRun(f)?.rect).toEqual([60, 100, 520, 260])
  o.argsArray[f.source.glyphs[3] - 5][4] += 1
  expect(topRun(f)).toBeUndefined()
})
it.each([
  'font',
  'nan-font',
  'origin',
  'duplicate-origin',
  'matrix',
  'glyph',
  'font-char',
  'char-code',
  'false-space',
  'paint',
  'paint-index',
  'paint-extra',
  'raw-bounds',
  'dash',
  'line-color',
  'white-line-family',
  'white-marker-keys',
  'carrier-painted-last',
  'font-before-carrier',
  'marker',
  'alpha-state',
  'nested-form',
  'caption',
  'table',
  'foreign-font',
  'missing-context',
  'font-resource',
  'white-glyph',
  'hidden-glyph',
  'clip-away'
])('refuses incomplete finite top-row source ownership: %s', (reason) => {
  const f = topRowInput(),
    o = f.context.operators
  if (reason === 'font') f.tokens.pop()
  if (reason === 'nan-font') f.tokens[0].rect[0] = NaN
  if (reason === 'origin') f.tokens[0].sourceItem.text = 'wrong'
  if (reason === 'duplicate-origin') f.tokens[1].sourceItem.index = f.tokens[0].sourceItem.index
  if (reason === 'matrix') o.argsArray[f.source.glyphs[0] - 5][4] += 1
  if (reason === 'font-resource') o.argsArray[f.source.glyphs[0] - 2][0] = 'undeclared-font'
  if (reason === 'white-glyph') o.argsArray[f.source.glyphs[0] - 3][0] = '#ffffff'
  if (reason === 'hidden-glyph')
    insertTopOps(f, f.source.glyphs[0], [OPS.setGState], [[[['ca', 0]]]])
  if (reason === 'glyph') o.argsArray[f.source.glyphs[0]][0][0].unicode = 'z'
  if (reason === 'font-char') o.argsArray[f.source.glyphs[0]][0][0].fontChar = ''
  if (reason === 'char-code') o.argsArray[f.source.glyphs[0]][0][0].originalCharCode = NaN
  if (reason === 'false-space') {
    const g = o.argsArray[f.source.glyphs[0]][0][0]
    g.isSpace = true
    g.isInFont = false
  }
  if (reason === 'paint') f.page.graphicsBounds[1].normalizedRect[0] += 0.01
  if (reason === 'paint-index') f.page.graphicsBounds[1].operationIndex = 9999
  if (reason === 'paint-extra')
    f.page.graphicsBounds.push({ ...f.page.graphicsBounds[1], operationIndex: 9999 })
  if (reason === 'raw-bounds') o.argsArray[f.source.keys[0]][2][0] += 1
  if (reason === 'dash') o.argsArray[f.source.keys[0] - 1][0] = [2, 2]
  if (reason === 'line-color') o.argsArray[f.source.keys[0] - 3][0] = '#abcdef'
  if (reason === 'white-line-family')
    for (let n = 0; n < o.fnArray.length; n++)
      if (
        [OPS.setFillRGBColor, OPS.setStrokeRGBColor].includes(o.fnArray[n]) &&
        o.argsArray[n][0] === '#aa8800'
      )
        o.argsArray[n][0] = '#ffffff'
  if (reason === 'white-marker-keys') {
    o.argsArray[f.source.keys[3] - 4][0] = '#ffffff'
    o.argsArray[f.source.keys[3] - 3][0] = '#ffffff'
  }
  if (reason === 'carrier-painted-last') {
    const carrier = f.page.graphicsBounds[0],
      oldIndex = carrier.operationIndex,
      raw = o.argsArray[oldIndex]
    o.fnArray.splice(oldIndex, 1)
    o.argsArray.splice(oldIndex, 1)
    for (const g of f.page.graphicsBounds)
      if (g !== carrier && g.operationIndex > oldIndex) g.operationIndex--
    carrier.operationIndex = -1
    const index = o.fnArray.length - 1
    insertTopOps(
      f,
      index,
      [
        OPS.save,
        OPS.setFillRGBColor,
        OPS.setStrokeRGBColor,
        OPS.setLineWidth,
        OPS.setDash,
        OPS.constructPath,
        OPS.restore
      ],
      [null, ['#ffffff'], ['#ffffff'], [0], [[], 0], raw, null]
    )
    carrier.operationIndex = index + 5
  }
  if (reason === 'font-before-carrier') {
    const start = f.source.glyphs[0] - 6,
      ops = o.fnArray.splice(start, 9),
      args = o.argsArray.splice(start, 9)
    for (const g of f.page.graphicsBounds) if (g.operationIndex > start) g.operationIndex -= 9
    insertTopOps(f, 2, ops, args)
  }
  if (reason === 'marker') o.argsArray[f.source.keys[3]][1][0][1] += 1
  if (reason === 'alpha-state') insertTopOps(f, 1, [OPS.setGState], [[[['BM', 'Multiply']]]])
  if (reason === 'nested-form')
    insertTopOps(f, 1, [OPS.paintFormXObjectBegin], [[null, new Float32Array([70, 550, 500, 690])]])
  if (reason === 'clip-away')
    insertTopOps(
      f,
      f.source.glyphs[0] - 5,
      [OPS.clip, OPS.constructPath],
      [
        [],
        [
          OPS.endPath,
          [new Float32Array([0, 60, 540, 1, 70, 540, 1, 70, 550, 1, 60, 550, 4])],
          new Float32Array([60, 540, 70, 550])
        ]
      ]
    )
  if (reason === 'caption')
    f.captions.push({ page: 1, rect: [100, 110, 180, 125], lines: ['Figure 2. Other.'] })
  if (reason === 'table') f.tables.push([100, 150, 400, 200])
  if (reason === 'foreign-font')
    f.tokens.push({
      ...f.tokens[0],
      text: 'other',
      sourceItem: { pageNumber: 1, index: 99, text: 'other' }
    })
  if (reason === 'missing-context') delete f.context
  expect(topRun(f)).toBeUndefined()
})
it('the actual association chain preserves an already complete carrier and ignores unproved context', () => {
  const f = topRowInput()
  const before = associateFigures(f.page, f.captions, [], [], [], f.tokens)
  const final = associateFigures(f.page, f.captions, [], [], [], f.tokens, f.context)
  expect(final).toHaveLength(1)
  expect(final).toEqual(before)
  expect(
    f.tokens.every((t: Input) =>
      t.rect.every((v: number, n: number) =>
        n < 2 ? v >= final[0].rect[n] : v <= final[0].rect[n]
      )
    )
  ).toBe(true)
  const refused = topRowInput()
  refused.tokens.pop()
  const refusedBefore = associateFigures(refused.page, refused.captions, [], [], [], refused.tokens)
  expect(
    associateFigures(refused.page, refused.captions, [], [], [], refused.tokens, refused.context)
  ).toEqual(refusedBefore)
})
it('retains connected outer nodes and the independently repeated keyed legend', () => {
  const r = run(input())
  expect(r.rect[1]).toBeCloseTo(45)
  expect(r.rect[3]).toBeCloseTo(265)
})
it.each([false, true])(
  'requires all three repeated index-definition pairs: missing=%s',
  (missing) => {
    const f = input()
    for (const y of [241, 253, 265]) {
      for (const x of [40, 125]) {
        if (y !== 265) continue
        f.page.graphicsBounds.push({
          kind: 'path',
          normalizedRect: [x / 600, y / 800, (x + 12) / 600, (y + 12) / 800]
        })
        f.tokens.push({
          text: 'Key entry',
          rect: [x + 15, y + 1, x + 70, y + 9],
          height: 8,
          baseline: y + 9,
          horizontal: true
        })
      }
      f.tokens.push({
        text: 'i',
        rect: [230, y + 1, 233, y + 9],
        height: 8,
        baseline: y + 9,
        horizontal: true
      })
      if (!missing || y !== 265)
        f.tokens.push({
          text: 'Definition',
          rect: [241, y + 1, 290, y + 9],
          height: 8,
          baseline: y + 9,
          horizontal: true
        })
    }
    if (missing) expect(run(f)).toBeUndefined()
    else expect(run(f).rect[3]).toBeGreaterThanOrEqual(277)
  }
)
it.each([
  'missing-container',
  'missing-key-column',
  'foreign-font',
  'foreign-baseline',
  'raster',
  'caption',
  'table',
  'invalid-source'
])('rejects incomplete connected diagram ownership: %s', (reason) => {
  const f = input()
  if (reason === 'missing-container') f.page.graphicsBounds.splice(1, 1)
  if (reason === 'missing-key-column')
    f.page.graphicsBounds = f.page.graphicsBounds.filter(
      (g: Input) => !(g.normalizedRect[0] === 125 / 600 && g.normalizedRect[1] >= 241 / 800)
    )
  if (reason === 'foreign-font')
    f.tokens.push({
      text: 'Foreign line',
      rect: [230, 246, 300, 256],
      height: 10,
      baseline: 256,
      horizontal: true
    })
  if (reason === 'foreign-baseline')
    f.tokens.push({
      text: 'Unknown key',
      rect: [230, 238, 285, 246],
      height: 8,
      baseline: 246,
      horizontal: true
    })
  if (reason === 'raster')
    f.page.graphicsBounds.push({
      kind: 'image',
      normalizedRect: [230 / 600, 240 / 800, 270 / 600, 260 / 800]
    })
  if (reason === 'caption')
    f.captions.push({
      page: 1,
      rect: [200, 240, 300, 255],
      lines: ['Figure 2. Independent graphic.']
    })
  if (reason === 'table') f.tables.push([200, 240, 300, 255])
  if (reason === 'invalid-source') f.tokens[0].baseline = NaN
  expect(run(f)).toBeUndefined()
})
it.each(['unkeyed-near-legend', 'unconnected-top-label'])(
  'rejects new small lettering without a concrete native owner: %s',
  (reason) => {
    const f = input(),
      rect = reason === 'unkeyed-near-legend' ? [230, 242, 285, 250] : [70, 46, 130, 54]
    f.tokens.push({ text: 'Unknown key', rect, height: 8, baseline: rect[3], horizontal: true })
    expect(run(f)).toBeUndefined()
  }
)
