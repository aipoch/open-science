import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const { findNativeAlgorithmCandidates, acceptsNativeScopedAlgorithmPng } = await import(
  pathToFileURL(resolve('resources/literature-pdf-algorithm-native-body.mjs')).href
)
const { findAlgorithmCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-numbered-native-procedure.mjs')).href
)
const { collectTableRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const { nativePageTextPacketInventory } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)

// Three actual native strokes close nested scopes; the two caption fragments
// have disjoint used ink although their font-wide boxes overlap Output.
function verticalScopeProgram(mode = ''): ReturnType<typeof JSON.parse> {
  const f = sample(),
    rows: [string, number, number, number][] = [
      ['Input: values', 88.936, 85, 10],
      ['for each sweep do', 88.936, 110, 10],
      ['for each value do', 105.699, 123.55, 10],
      ['Compute the next value', 122.461, 137.1, 10],
      ['for adjacent pairs do', 105.699, 153.55, 10],
      ['Swap the values', 122.461, 167.1, 10],
      ['Record the state', 105.699, 180.65, 10],
      ['Output: collected values', 88.936, 194.2, 10],
      ['Algorithm S1: Collect values for a sample', 80.468, 204, 10],
      ['state.', 80.468, 217.55, 10],
      ['Independent explanation.', 80.468, 250, 10],
      ['π ', 350, 300, 10]
    ]
  if (mode === 'unclosed-control') rows[2][0] = 'for each value'
  if (mode === 'small-control') rows[2][3] = 7
  if (mode === 'foreign-control') rows.splice(3, 0, ['if value then', 122.461, 132, 10])
  if (mode === 'missing-output') rows[7][0] = 'Result: collected values'
  if (mode === 'caption-ink-overlap') rows[8][2] = 195
  if (mode === 'foreign-ink') rows[11] = ['π ', 140, 150, 10]
  if (mode === 'selected-trailing-space') rows[7][0] += ' '
  const items = rows.map(([str, x, baseline, h], index) => ({
      str,
      dir: 'ltr',
      width: str.length * h * 0.4,
      height: h,
      transform: [h, 0, 0, h, x, 800 - baseline],
      fontName: 'native',
      sourceItem: { pageNumber: 1, index, text: str }
    })),
    operators: { fnArray: number[]; argsArray: unknown[] } = { fnArray: [], argsArray: [] },
    rules = [
      [94.59, 114.065, 94.59, 184.715],
      [111.352, 127.615, 111.352, 141.165],
      [111.352, 157.615, 111.352, 171.165]
    ]
  // Native trailing whitespace can represent a positioning gap, not a glyph.
  items.at(-1)!.width -= 2
  for (const item of items) {
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      ['native', item.height],
      [[1, 0, 0, 1, item.transform[4], item.transform[5]]],
      [
        Array.from(item.str.trimEnd(), (c) => ({
          originalCharCode: c.codePointAt(0),
          unicode: c,
          fontChar: c,
          width: 400,
          isInFont: true,
          isSpace: c === ' '
        }))
      ],
      null
    )
  }
  operators.fnArray.push(OPS.setLineWidth)
  operators.argsArray.push([0.4])
  f.page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    rotation: 0,
    invalidGraphicsBounds: 0,
    lines: rows.map(([text, x, baseline, h], i) => ({
      text,
      x,
      y: baseline - h,
      width: items[i].width,
      height: h,
      fontSize: h
    })),
    graphicsBounds: rules.map((r) => {
      const operationIndex = operators.fnArray.length
      operators.fnArray.push(OPS.constructPath)
      operators.argsArray.push([
        OPS.stroke,
        [[0, r[0], 800 - r[1], 1, r[2], 800 - r[3]]],
        [r[0], 800 - r[3], r[2], 800 - r[1]]
      ])
      return {
        kind: 'path',
        operationIndex,
        normalizedRect: [r[0] - 0.2, r[1], r[2] + 0.2, r[3]].map((v, n) => v / (n % 2 ? 800 : 600))
      }
    })
  }
  const viewport = {
      width: 600,
      height: 800,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 800],
      convertToViewportPoint: (x: number, y: number) => [x, 800 - y]
    },
    content = { items, styles: { native: { ascent: 0.8, descent: -0.2, vertical: false } } }
  f.context = {
    content,
    viewport,
    operators,
    rules: collectTableRules(operators, viewport),
    nativeGlyphContext: {
      content: JSON.parse(JSON.stringify(content)),
      viewport,
      operators,
      graphicsBounds: f.page.graphicsBounds,
      glyphBounds: [
        {
          fontName: 'native',
          glyphs: [...new Set(rows.flatMap(([s]) => [...s]))].map((c) => ({
            fontChar: c,
            bounds: c === ' ' ? [0, 0, 0, 0] : [0, -0.01, 0.4, c === 'A' ? 0.85 : 0.7]
          }))
        }
      ]
    }
  }
  if (mode === 'missing-scope') f.context.rules.pop()
  if (mode === 'foreign-scope')
    operators.fnArray[f.page.graphicsBounds[1].operationIndex] = OPS.dependency
  if (mode === 'duplicate-owner') f.page.graphicsBounds.push({ ...f.page.graphicsBounds[0] })
  if (mode === 'missing-glyph') f.context.nativeGlyphContext.glyphBounds[0].glyphs.pop()
  if (mode === 'empty-selected-glyph')
    f.context.nativeGlyphContext.glyphBounds[0].glyphs.find(
      (g: { fontChar: string }) => g.fontChar === 'O'
    ).bounds = [0, 0, 0, 0]
  if (mode === 'alias-source') f.context.nativeGlyphContext.content.items[1].sourceItem.index = 0
  if (mode === 'hidden-state' || mode === 'white-fill') {
    operators.fnArray.unshift(
      mode === 'hidden-state' ? OPS.setTextRenderingMode : OPS.setFillRGBColor
    )
    operators.argsArray.unshift(mode === 'hidden-state' ? [3] : ['#ffffff'])
    for (const g of f.page.graphicsBounds) g.operationIndex++
  }
  if (mode === 'native-origin') {
    content.items[7].transform[4] += 0.1
    f.context.nativeGlyphContext.content.items[7].transform[4] += 0.1
  }
  if (mode === 'missing-end-text') {
    const at = operators.fnArray.lastIndexOf(OPS.endText)
    operators.fnArray.splice(at, 1)
    operators.argsArray.splice(at, 1)
    for (const g of f.page.graphicsBounds) g.operationIndex--
  }
  if (mode === 'extra-owned-path') {
    const id = f.page.graphicsBounds[1].operationIndex
    ;(operators.argsArray[id] as number[][][])[1][0].push(0, 160, 670, 1, 170, 660)
  }
  if (mode === 'foreign-paint' || mode === 'spoofed-foreign-bounds') {
    const operationIndex = operators.fnArray.length
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push([
      OPS.fill,
      [[0, 160, 670, 1, 170, 670, 1, 170, 660, 1, 160, 660, 4]],
      [160, 660, 170, 670]
    ])
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex,
      normalizedRect:
        mode === 'foreign-paint'
          ? [160 / 600, 130 / 800, 170 / 600, 140 / 800]
          : [0.8, 0.8, 0.9, 0.9]
    })
  }
  return f
}

it('owns a complete vertical nested scope through actual source glyphs without losing caption or outside whitespace', () => {
  const f = verticalScopeProgram(),
    before = JSON.stringify(f)
  const result = findNativeAlgorithmCandidates(f.page, f.context)
  expect(result).toHaveLength(1)
  expect(result[0].nativeBody.sourceItems).toEqual(
    f.context.content.items.slice(0, 8).map((i: { sourceItem: unknown }) => i.sourceItem)
  )
  expect(result[0].caption.lines).toEqual(
    f.page.lines.slice(8, 10).map((l: { text: string }) => l.text)
  )
  expect(result[0].caption.rect[1]).toBeCloseTo(195.5)
  const p = f.context.nativeGlyphContext,
    tokens = p.content.items.map((r: unknown) => tableTextToken(r, p.viewport, 0))
  expect(nativePageTextPacketInventory(f.page, tokens, p)).toBeUndefined()
  expect(p.content.items.at(-1).str).toBe('π ')
  expect(JSON.stringify(f)).toBe(before)
})
it.each([
  'missing-scope',
  'foreign-scope',
  'duplicate-owner',
  'unclosed-control',
  'small-control',
  'foreign-control',
  'missing-output',
  'caption-ink-overlap',
  'foreign-ink',
  'selected-trailing-space',
  'missing-glyph',
  'empty-selected-glyph',
  'alias-source',
  'hidden-state',
  'white-fill',
  'native-origin',
  'missing-end-text',
  'extra-owned-path',
  'foreign-paint',
  'spoofed-foreign-bounds'
])('rejects an incomplete native vertical scope: %s', (mode) => {
  const f = verticalScopeProgram(mode)
  expect(findNativeAlgorithmCandidates(f.page, f.context)).toHaveLength(0)
})

it('rechecks the actual PNG footprint before publishing a native scoped algorithm', () => {
  const f = verticalScopeProgram(),
    candidate = findNativeAlgorithmCandidates(f.page, f.context)[0]
  const png = (scale: number): Buffer => {
    const b = Buffer.alloc(33)
    b.set([137, 80, 78, 71, 13, 10, 26, 10])
    b.writeUInt32BE(13, 8)
    b.write('IHDR', 12)
    b.writeUInt32BE(Math.ceil((candidate.rect[2] - candidate.rect[0]) * scale), 16)
    b.writeUInt32BE(Math.ceil((candidate.rect[3] - candidate.rect[1]) * scale), 20)
    return b
  }
  for (const scale of [4, 0.5])
    expect(acceptsNativeScopedAlgorithmPng(f.page, candidate, png(scale))).toBe(true)
  const incomplete = png(4)
  incomplete[0] = 0
  expect(acceptsNativeScopedAlgorithmPng(f.page, candidate, incomplete)).toBe(false)
  expect(acceptsNativeScopedAlgorithmPng(f.page, candidate, png(0.001))).toBe(false)
  for (const field of ['foreignGlyphs', 'foreignPaint']) {
    const changed = structuredClone(candidate)
    changed.scopedGlyphProof[field].push([
      candidate.rect[2] + 0.01,
      candidate.rect[1] + 2,
      candidate.rect[2] + 0.1,
      candidate.rect[1] + 3
    ])
    expect(acceptsNativeScopedAlgorithmPng(f.page, changed, png(4))).toBe(false)
  }
})

function steppedProcedure(): ReturnType<typeof JSON.parse> {
  const f = sample(),
    rows = [
      ['Algorithm 1 Update values', 50, 100],
      ['Step 1. Initialize', 50, 120],
      ['x = 0', 150, 140],
      ['Step 2. Compute the next value', 50, 160],
      ['y = x + 1', 150, 180],
      ['Step 3. Update the state', 50, 200],
      ['x = y', 150, 220],
      ['Independent explanation.', 50, 270]
    ]
  f.context.content.items = rows.map(([str, x, y], index) => ({
    str,
    dir: 'ltr',
    width: String(str).length * 4,
    height: 10,
    transform: [10, 0, 0, 10, x, 790 - Number(y)],
    fontName: 'native',
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  f.page.lines = rows.map(([text, x, y]) => ({
    text,
    x,
    y,
    width: String(text).length * 4,
    height: 10,
    fontSize: 10
  }))
  f.context.rules[2] = [50, 240, 350, 240]
  f.page.graphicsBounds = f.context.rules.map((r: number[], operationIndex: number) => ({
    kind: 'path',
    operationIndex,
    normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 400))
  }))
  f.context.operators = {
    fnArray: f.context.rules.map(() => OPS.constructPath),
    argsArray: f.context.rules.map((r: number[]) => [
      OPS.stroke,
      [[0, r[0], 800 - r[1], 1, r[2], 800 - r[3]]],
      [r[0], 800 - r[1], r[2], 800 - r[3]]
    ])
  }
  return f
}

it.each([
  'complete',
  'gap',
  'order',
  'payload',
  'prose-payload',
  'foreign-rule',
  'missing-rule',
  'native-text',
  'alias',
  'small-control',
  'foreign-boundary',
  'bad-font'
])('requires three complete framed native computational steps: %s', (mode) => {
  const f = steppedProcedure()
  const replace = (at: number, text: string): void => {
    const item = f.context.content.items[at]
    item.str = item.sourceItem.text = f.page.lines[at].text = text
    item.width = f.page.lines[at].width = text.length * 4
  }
  if (mode === 'gap') replace(3, 'Step 4. Compute the next value')
  if (mode === 'order') replace(1, 'Step 1. Update the state')
  if (mode === 'payload') replace(4, 'y plus x')
  if (mode === 'prose-payload') replace(4, 'x = the ordinary explanatory paragraph')
  if (mode === 'foreign-rule') {
    const stroke = f.context.operators.argsArray[2]
    stroke[1][0][2] -= 10
    stroke[1][0][5] -= 10
    stroke[2][1] -= 10
    stroke[2][3] -= 10
  }
  if (mode === 'missing-rule') f.context.rules.pop()
  if (mode === 'native-text') f.context.content.items[4].sourceItem.text = 'Other'
  if (mode === 'alias') f.context.content.items[4].sourceItem.index = 2
  if (mode === 'small-control') {
    const index = f.context.content.items.length,
      item = {
        str: 'if condition then',
        dir: 'ltr',
        height: 7,
        width: 65,
        transform: [7, 0, 0, 7, 160, 603],
        fontName: 'native',
        sourceItem: { pageNumber: 1, index, text: 'if condition then' }
      }
    f.context.content.items.push(item)
    f.page.lines.push({ text: item.str, x: 160, y: 190, width: 65, height: 7, fontSize: 7 })
  }
  if (mode === 'foreign-boundary') f.context.content.items[4].width = 500
  if (mode === 'bad-font') delete f.context.content.styles.native.ascent
  const before = structuredClone(f),
    result = findNativeAlgorithmCandidates(f.page, f.context)
  expect(result).toHaveLength(mode === 'complete' ? 1 : 0)
  if (mode === 'complete')
    expect(result[0].nativeBody.sourceItems).toEqual(
      f.context.content.items.slice(1, 7).map((i: { sourceItem: unknown }) => i.sourceItem)
    )
  expect(f).toEqual(before)
})

function sample(bottom = false): ReturnType<typeof JSON.parse> {
  const rows = bottom
    ? [
        ['1', 42, 100, 6],
        ['Function Collect(values)', 60, 98, 10],
        ['2', 42, 120, 6],
        ['for value in values do', 70, 118, 10],
        ['3', 42, 140, 6],
        ['Add value', 90, 138, 10],
        ['4', 42, 160, 6],
        ['return total', 70, 158, 10],
        ['Algorithm 1: Collect values', 60, 185, 10]
      ]
    : [
        ['Algorithm 1 Collect values', 50, 100, 10],
        ['Input: values', 65, 120, 10],
        ['for value in values do', 65, 140, 10],
        ['Add value', 85, 160, 10],
        ['end for', 65, 180, 10],
        ['Return: total', 65, 200, 10]
      ]
  rows.push(['Independent paragraph.', 50, 250, 10])
  const items = rows.map(([str, x, y, height], index) => ({
    str,
    dir: 'ltr',
    width: String(str).length * 4,
    height,
    transform: [height, 0, 0, height, x, 800 - Number(y) - Number(height)],
    fontName: 'native',
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  const rules = bottom
    ? [
        [58, 115, 58, 185],
        [78, 135, 78, 153]
      ]
    : [
        [50, 99, 350, 99],
        [50, 115, 350, 115],
        [50, 220, 350, 220]
      ]
  const page = {
    pageNumber: 1,
    width: 400,
    height: 800,
    rotation: 0,
    invalidGraphicsBounds: 0,
    lines: items.map((item) => ({
      text: item.str,
      x: item.transform[4],
      y: 800 - item.transform[5] - Number(item.height),
      width: item.width,
      height: item.height,
      fontSize: item.height
    })),
    graphicsBounds: rules.map((r, i) => ({
      kind: 'path',
      operationIndex: i,
      normalizedRect: r.map((v, n) => v / (n % 2 ? 800 : 400))
    }))
  }
  return {
    page,
    context: {
      rules,
      content: { items, styles: { native: { ascent: 0.8, descent: -0.2 } } },
      viewport: { width: 400, height: 800, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 800] }
    }
  }
}

it.each([
  'complete',
  'dash',
  'clip',
  'foreign-text',
  'crossing-paint',
  'new-paint',
  'same-operation-paint',
  'form',
  'missing-frame',
  'off-page'
])('completes only the proved native closing frame stroke: %s', (mode) => {
  const f = sample()
  f.context.rules[0] = [50, 101, 350, 101]
  f.page.graphicsBounds[0].normalizedRect = [50 / 400, 101 / 800, 350 / 400, 101 / 800]
  for (const g of f.page.graphicsBounds) g.operationIndex++
  f.context.operators = { fnArray: [OPS.setLineWidth], argsArray: [[0.4]] }
  for (const r of f.context.rules) {
    f.context.operators.fnArray.push(OPS.constructPath)
    f.context.operators.argsArray.push([
      OPS.stroke,
      [[0, r[0], 800 - r[1], 1, r[2], 800 - r[3]]],
      [r[0], 800 - r[1], r[2], 800 - r[3]]
    ])
  }
  if (mode === 'dash') {
    f.context.operators.fnArray.unshift(OPS.setDash)
    f.context.operators.argsArray.unshift([[1, 1], 0])
  }
  if (mode === 'clip') {
    f.context.operators.fnArray.unshift(OPS.clip)
    f.context.operators.argsArray.unshift([])
  }
  if (mode === 'form') {
    f.context.operators.fnArray.unshift(OPS.paintFormXObjectBegin)
    f.context.operators.argsArray.unshift([null, null])
    f.context.operators.fnArray.push(OPS.paintFormXObjectEnd)
    f.context.operators.argsArray.push([])
  }
  if (mode === 'missing-frame') {
    f.context.operators.fnArray.pop()
    f.context.operators.argsArray.pop()
  }
  if (mode === 'off-page') f.page.height = f.context.viewport.height = 220
  if (mode === 'foreign-text') {
    const item = f.context.content.items.at(-1)
    item.transform[5] = 800 - 220.1 - item.height
    Object.assign(f.page.lines.at(-1), { y: 220.1 })
  }
  if (mode === 'same-operation-paint') {
    const stroke = f.context.operators.argsArray[3]
    stroke[1][0].push(0, 100, 579.9, 1, 110, 579.85)
    stroke[2][3] = 579.9
  }
  if (mode === 'crossing-paint' || mode === 'new-paint') {
    const r = [100, mode === 'crossing-paint' ? 219.9 : 220.05, 110, 220.15]
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: f.context.operators.fnArray.length,
      normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 400))
    })
    f.context.operators.fnArray.push(OPS.constructPath)
    f.context.operators.argsArray.push([
      OPS.fill,
      [[0, r[0], 800 - r[1], 1, r[2], 800 - r[1], 1, r[2], 800 - r[3], 1, r[0], 800 - r[3], 4]],
      [r[0], 800 - r[3], r[2], 800 - r[1]]
    ])
  }
  const before = structuredClone(f),
    result = findNativeAlgorithmCandidates(f.page, f.context)
  if (mode === 'off-page') expect(result).toHaveLength(0)
  else {
    expect(result).toHaveLength(1)
    expect(result[0].rect[3]).toBeCloseTo(mode === 'complete' ? 220.2 : 220, 8)
    expect(result[0].nativeBody.sourceItems).toEqual(
      f.context.content.items.slice(1, 6).map((i) => i.sourceItem)
    )
  }
  expect(f).toEqual(before)
})
it.each([false, true])(
  'preserves the complete native algorithm body with bottom caption=%s',
  (bottom) => {
    const f = sample(bottom),
      before = structuredClone(f),
      result = findNativeAlgorithmCandidates(f.page, f.context)
    expect(result).toHaveLength(1)
    const sources = result[0].nativeBody.sourceItems
    expect(sources).toEqual(
      f.context.content.items
        .filter((i: { str: string }) => !/^(Algorithm|Independent)/.test(i.str))
        .map((i: { sourceItem: unknown }) => i.sourceItem)
    )
    expect(result[0].nativeBody.kind).toBe('algorithm')
    expect(f).toEqual(before)
  }
)

it.each([
  'complete',
  'initialization',
  'closing',
  'order',
  'nested',
  'small-control',
  'foreign-rule',
  'missing-operators',
  'foreign-boundary',
  'bad-font'
])('requires a complete native Set and single-loop grammar without Input or Return: %s', (mode) => {
  const f = sample()
  const replace = (at: number, text: string, x: number): void => {
    const item = f.context.content.items[at]
    item.str = text
    item.sourceItem.text = text
    item.width = text.length * 4
    item.transform[4] = x
    Object.assign(f.page.lines[at], { text, x, width: item.width })
  }
  replace(1, 'Set state to its initial value', 65)
  replace(4, 'Record the current state', 85)
  replace(5, 'end for', 65)
  f.context.operators = { fnArray: [], argsArray: [] }
  for (const r of f.context.rules) {
    f.context.operators.fnArray.push(OPS.constructPath)
    f.context.operators.argsArray.push([
      OPS.stroke,
      [[0, r[0], 800 - r[1], 1, r[2], 800 - r[3]]],
      [r[0], 800 - r[1], r[2], 800 - r[3]]
    ])
  }
  if (mode === 'initialization') replace(1, 'Ordinary opening statement', 65)
  if (mode === 'closing') replace(5, 'Ordinary final statement', 65)
  if (mode === 'order') {
    replace(2, 'end for', 65)
    replace(5, 'for value in values do', 65)
  }
  if (mode === 'nested') replace(4, 'if condition then', 85)
  if (mode === 'small-control') {
    const index = f.context.content.items.length,
      item = {
        ...f.context.content.items[3],
        str: 'if condition then',
        height: 7,
        width: 65,
        transform: [7, 0, 0, 7, 85, 615],
        sourceItem: { pageNumber: 1, index, text: 'if condition then' }
      }
    f.context.content.items.push(item)
    f.page.lines.push({ text: item.str, x: 85, y: 178, width: 65, height: 7, fontSize: 7 })
  }
  if (mode === 'foreign-rule') {
    const stroke = f.context.operators.argsArray[2]
    stroke[1][0][2] -= 10
    stroke[1][0][5] -= 10
    stroke[2][1] -= 10
    stroke[2][3] -= 10
  }
  if (mode === 'missing-operators') delete f.context.operators
  if (mode === 'foreign-boundary') f.context.content.items[3].width = 500
  if (mode === 'bad-font') delete f.context.content.styles.native.ascent
  const before = structuredClone(f),
    result = findNativeAlgorithmCandidates(f.page, f.context)
  expect(result).toHaveLength(mode === 'complete' ? 1 : 0)
  if (mode === 'complete')
    expect(result[0].nativeBody.sourceItems).toEqual(
      f.context.content.items.slice(1, 6).map((i: { sourceItem: unknown }) => i.sourceItem)
    )
  expect(f).toEqual(before)
})
it.each([
  'opening',
  'closing',
  'control',
  'caption',
  'native-text',
  'crossing',
  'wrong-page',
  'alias',
  'missing-native-item',
  'caption-source',
  'unknown-font',
  'embedded-image'
])('refuses whole body ownership with incomplete %s proof', (mode) => {
  const f = sample()
  if (mode === 'opening') f.context.rules.shift()
  if (mode === 'closing') f.context.rules.pop()
  if (mode === 'control') f.page.lines[4].text = 'Unrelated words'
  if (mode === 'caption') f.page.lines[0].text = 'Ordinary heading'
  if (mode === 'native-text') f.context.content.items[2].sourceItem.text = 'Other'
  if (mode === 'crossing') f.context.content.items[2].width = 500
  if (mode === 'wrong-page') f.context.content.items[2].sourceItem.pageNumber = 2
  if (mode === 'alias')
    f.context.content.items[2].sourceSegment = {
      ...f.context.content.items[2].sourceItem,
      start: 0,
      end: 3
    }
  if (mode === 'missing-native-item') f.context.content.items[3].str = ''
  if (mode === 'caption-source') f.context.content.items[0].sourceItem.index = 50
  if (mode === 'unknown-font') delete f.context.content.styles.native.ascent
  if (mode === 'embedded-image')
    f.page.graphicsBounds.push({ kind: 'image', normalizedRect: [0.2, 0.2, 0.3, 0.21] })
  expect(
    findNativeAlgorithmCandidates(f.page, f.context).every(
      (a: { nativeBody?: unknown }) => !a.nativeBody
    )
  ).toBe(true)
})

function numberedInputColumn(): ReturnType<typeof JSON.parse> {
  const f = sample(),
    rows: [string, number, number, number][] = [
      ['Algorithm 1 Update values', 49.6, 100, 10],
      ['1:', 56, 122, 8],
      ['Input:', 70, 120, 10],
      ['values', 110, 120, 10],
      [',', 308, 120, 10],
      ['2:', 56, 142, 8],
      ['Initialize state ← 0', 70, 140, 10],
      ['3:', 56, 162, 8],
      ['for value in values do', 70, 160, 10],
      ['4:', 56, 182, 8],
      ['if value > 0 then', 85, 180, 10],
      ['5:', 56, 202, 8],
      ['Record value', 100, 200, 10],
      ['and its state', 70, 212, 10],
      ['6:', 56, 232, 8],
      ['else', 85, 230, 10],
      ['7:', 56, 252, 8],
      ['Record zero', 100, 250, 10],
      ['8:', 56, 272, 8],
      ['end if', 85, 270, 10],
      ['9:', 56, 292, 8],
      ['end for', 70, 290, 10],
      ['Independent neighboring paragraph.', 360, 180, 10],
      ['Independent explanation.', 50, 340, 10]
    ]
  f.page.width = f.context.viewport.width = 600
  f.context.content.items = rows.map(([str, x, y, height], index) => ({
    str,
    dir: 'ltr',
    width: str.length * 4,
    height,
    transform: [height, 0, 0, height, x, 800 - y - height],
    fontName: 'native',
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  f.page.lines = rows.map(([text, x, y, height]) => ({
    text,
    x,
    y,
    width: text.length * 4,
    height,
    fontSize: height
  }))
  f.context.rules = [
    [50, 99, 310, 99],
    [50, 115, 310, 115],
    [50, 315, 310, 315]
  ]
  f.page.graphicsBounds = f.context.rules.map((r: number[], operationIndex: number) => ({
    kind: 'path',
    operationIndex,
    normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 600))
  }))
  f.context.operators = {
    fnArray: f.context.rules.map(() => OPS.constructPath),
    argsArray: f.context.rules.map((r: number[]) => [
      OPS.stroke,
      [[0, r[0], 800 - r[1], 1, r[2], 800 - r[3]]],
      [r[0], 800 - r[1], r[2], 800 - r[3]]
    ])
  }
  return f
}

function numberedDeclarationSample(
  functionBody: boolean,
  wrapped = false,
  separateControls = false
): ReturnType<typeof JSON.parse> {
  const f = sample(),
    statements = separateControls
      ? [
          'Input: values',
          'Initial Values: total ← 0',
          'function Update(values)',
          'while value > 0 do',
          'for value in values do',
          'total ← total + value',
          'end for',
          'end while',
          'return total',
          'end function'
        ]
      : functionBody
        ? [
            'Input: values',
            'Initial Values: total ← 0',
            'function Update(values)',
            'while value > 0 do',
            'total ← total + value',
            'end while',
            'return total',
            'end function'
          ]
        : [
            'Input: values',
            'Initial Values: total ← 0',
            'while value > 0 do',
            'total ← total + value',
            'end while',
            'Output: total',
            'Output: state'
          ],
    bottom = 130 + statements.length * 20,
    rows = [
      'Algorithm 1 Update values',
      ...statements.map((s, i) => `${i + 1}: ${s}`),
      'Independent explanation.'
    ]
  f.context.content.items = rows.map((str, index) => ({
    ...f.context.content.items[0],
    str,
    width: str.length * 4,
    transform: [
      10,
      0,
      0,
      10,
      index ? 65 : 50,
      800 - (index ? (index === rows.length - 1 ? bottom + 25 : 120 + (index - 1) * 20) : 100) - 10
    ],
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  f.page.lines = f.context.content.items.map(
    (i: { str: string; transform: number[]; width: number }) => ({
      text: i.str,
      x: i.transform[4],
      y: 800 - i.transform[5] - 10,
      width: i.width,
      height: 10,
      fontSize: 10
    })
  )
  f.context.rules[2] = [50, bottom, 350, bottom]
  f.page.graphicsBounds[2].normalizedRect = [50 / 400, bottom / 800, 350 / 400, bottom / 800]
  if (wrapped) {
    for (const part of f.context.content.items.slice(2)) part.transform[5] -= 20
    const base = f.context.content.items[1],
      extra = (str: string, x: number, y: number): typeof base => ({
        ...base,
        str,
        width: str.length * 4,
        transform: [10, 0, 0, 10, x, 800 - y - 10]
      })
    f.context.content.items.splice(
      1,
      1,
      extra('1:', 65, 120),
      extra('Input: values (additional observations for', 80, 120),
      extra('this procedure)', 80, 133)
    )
    f.context.content.items.forEach((part: { str: string; sourceItem: unknown }, index: number) => {
      part.sourceItem = { pageNumber: 1, index, text: part.str }
    })
    f.page.lines = f.context.content.items.map(
      (i: { str: string; transform: number[]; width: number }) => ({
        text: i.str,
        x: i.transform[4],
        y: 800 - i.transform[5] - 10,
        width: i.width,
        height: 10,
        fontSize: 10
      })
    )
    f.context.rules[2][1] += 20
    f.context.rules[2][3] += 20
    f.page.graphicsBounds[2].normalizedRect = f.context.rules[2].map(
      (v: number, i: number) => v / (i % 2 ? 800 : 400)
    )
  }
  if (separateControls) {
    f.context.content.items = f.context.content.items.flatMap(
      (part: { str: string; width: number; transform: number[] }) => {
        const match = /^(5:|7:) (.+)$/u.exec(part.str)
        return match
          ? [
              { ...part, str: match[1], width: 8 },
              {
                ...part,
                str: match[2],
                width: match[2].length * 4,
                transform: [...part.transform.slice(0, 4), 130, part.transform[5]]
              }
            ]
          : [part]
      }
    )
    f.context.content.items.forEach((part: { str: string; sourceItem: unknown }, index: number) => {
      part.sourceItem = { pageNumber: 1, index, text: part.str }
    })
    f.page.lines = f.context.content.items.map(
      (i: { str: string; transform: number[]; width: number }) => ({
        text: i.str,
        x: i.transform[4],
        y: 800 - i.transform[5] - 10,
        width: i.width,
        height: 10,
        fontSize: 10
      })
    )
  }
  return f
}

it.each([
  ['function', 'complete'],
  ['wrapped function', 'complete'],
  ['separate inner controls', 'complete'],
  ['separate inner controls', 'wrong inner close'],
  ['separate inner controls', 'small inner control'],
  ['outputs', 'complete'],
  ...['missing input', 'number gap', 'missing loop close', 'unknown font', 'foreign source'].map(
    (fault) => ['outputs', fault]
  ),
  ...['missing return', 'wrong function close', 'incomplete function'].map((fault) => [
    'function',
    fault
  ]),
  ['outputs', 'missing outputs'],
  ...['missing note close', 'note font', 'hidden note control'].map((fault) => [
    'wrapped function',
    fault
  ])
])('owns only a closed native program with numbered declarations: %s / %s', (shape, fault) => {
  const f = numberedDeclarationSample(
      shape !== 'outputs',
      shape === 'wrapped function',
      shape === 'separate inner controls'
    ),
    replace = (index: number, text: string): void => {
      f.context.content.items[index].str =
        f.context.content.items[index].sourceItem.text =
        f.page.lines[index].text =
          text
      f.context.content.items[index].width = f.page.lines[index].width = text.length * 4
    }
  if (fault === 'missing input') replace(1, '1: Observe values')
  if (fault === 'number gap') replace(3, '9: while value > 0 do')
  if (fault === 'missing loop close') replace(5, '5: Keep the value')
  if (fault === 'unknown font') delete f.context.content.styles.native.ascent
  if (fault === 'foreign source') f.context.content.items[4].sourceItem.pageNumber = 2
  if (fault === 'missing return') replace(7, '7: Keep the total')
  if (fault === 'wrong function close') replace(8, '8: end while')
  if (fault === 'incomplete function') replace(3, '3: function Update(values')
  if (fault === 'missing outputs') {
    replace(6, '6: Observe total')
    replace(7, '7: Observe state')
  }
  if (fault === 'missing note close') replace(3, 'this procedure')
  if (fault === 'note font') f.context.content.items[3].fontName = 'Other'
  if (fault === 'hidden note control') replace(3, 'return result)')
  if (fault === 'wrong inner close') replace(9, 'end while')
  if (fault === 'small inner control') {
    const part = f.context.content.items[6],
      line = f.page.lines[6]
    part.height = part.transform[0] = part.transform[3] = line.height = line.fontSize = 7
    line.y += 3
  }
  const before = structuredClone(f),
    owned = findNativeAlgorithmCandidates(f.page, f.context).filter(
      (c: { nativeBody?: unknown }) => c.nativeBody
    )
  expect(owned).toHaveLength(fault === 'complete' ? 1 : 0)
  if (fault === 'complete')
    expect(owned[0].nativeBody.sourceItems).toEqual(
      f.context.content.items.slice(1, -1).map((i: { sourceItem: unknown }) => i.sourceItem)
    )
  expect(f).toEqual(before)
})

it('owns a complete numbered column program and preserves its independent caption and right column', () => {
  const f = numberedInputColumn(),
    before = structuredClone(f)
  const owned = findNativeAlgorithmCandidates(f.page, f.context).filter(
    (a: { nativeBody?: unknown }) => a.nativeBody
  )
  expect(owned).toHaveLength(1)
  expect(owned[0].nativeBody.sourceItems).toEqual(
    f.context.content.items.slice(1, -2).map((t: { sourceItem: unknown }) => t.sourceItem)
  )
  expect(owned[0].rect).toEqual([49.6, 98.5, 312, 315.5])
  expect(f).toEqual(before)
})

it.each([
  'ordinal-gap',
  'ordinal-duplicate',
  'missing-close',
  'wrong-close',
  'else-order',
  'outdent',
  'small-control',
  'hidden-control',
  'detached-control',
  'native-literal',
  'native-font',
  'foreign-source',
  'native-rule',
  'compound-rule',
  'far-title',
  'word-overhang',
  'right-column-source',
  'right-column-crossing',
  'foreign-ink'
])('rejects incomplete numbered column evidence: %s', (mode) => {
  const f = numberedInputColumn()
  const replace = (index: number, text: string): void => {
    f.context.content.items[index].str =
      f.context.content.items[index].sourceItem.text =
      f.page.lines[index].text =
        text
    f.context.content.items[index].width = f.page.lines[index].width = text.length * 4
  }
  const move = (index: number, dx: number, dy = 0): void => {
    f.context.content.items[index].transform[4] += dx
    f.context.content.items[index].transform[5] -= dy
    f.page.lines[index].x += dx
    f.page.lines[index].y += dy
  }
  if (mode === 'ordinal-gap') replace(18, '10:')
  if (mode === 'ordinal-duplicate') replace(18, '7:')
  if (mode === 'missing-close') replace(21, 'Keep the result')
  if (mode === 'wrong-close') replace(19, 'end for')
  if (mode === 'else-order') replace(12, 'else')
  if (mode === 'outdent') move(12, -20)
  if (mode === 'small-control' || mode === 'hidden-control') {
    const index = mode === 'small-control' ? 10 : 13
    if (mode === 'hidden-control') replace(index, 'if unfinished then')
    f.context.content.items[index].height =
      f.page.lines[index].height =
      f.page.lines[index].fontSize =
        7
    f.context.content.items[index].transform[0] = f.context.content.items[index].transform[3] = 7
  }
  if (mode === 'detached-control') move(10, 0, 3)
  if (mode === 'native-literal') f.context.content.items[12].sourceItem.text = 'Other'
  if (mode === 'native-font') delete f.context.content.styles.native.ascent
  if (mode === 'foreign-source') f.context.content.items[12].sourceItem.pageNumber = 2
  if (mode === 'native-rule') f.context.operators.fnArray[2] = OPS.dependency
  if (mode === 'compound-rule')
    f.context.operators.argsArray[2][1][0].push(0, 100, 484.9, 1, 110, 484.85)
  if (mode === 'far-title') move(0, -10)
  if (mode === 'word-overhang') replace(4, 'word')
  if (mode === 'right-column-source') {
    f.context.content.items.splice(12, 0, f.context.content.items.splice(22, 1)[0])
    f.context.content.items.forEach((t: { sourceItem: { index: number } }, i: number) => {
      t.sourceItem.index = i
    })
  }
  if (mode === 'right-column-crossing') move(22, -51)
  if (mode === 'foreign-ink')
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: 99,
      normalizedRect: [100 / 600, 315.1 / 800, 110 / 600, 315.2 / 800]
    })
  expect(
    findNativeAlgorithmCandidates(f.page, f.context).every(
      (a: { nativeBody?: unknown }) => !a.nativeBody
    )
  ).toBe(true)
})
it.each(['gap', 'root-rule', 'nested-rule', 'last-return'])(
  'refuses a bottom-caption numbered body with %s',
  (mode) => {
    const f = sample(true)
    if (mode === 'gap') f.page.lines[4].text = '9'
    if (mode === 'root-rule') f.context.rules.shift()
    if (mode === 'nested-rule') f.context.rules.pop()
    if (mode === 'last-return') f.page.lines[7].text = 'Ordinary paragraph'
    expect(
      findNativeAlgorithmCandidates(f.page, f.context).every(
        (a: { nativeBody?: unknown }) => !a.nativeBody
      )
    ).toBe(true)
  }
)

it('keeps an existing algorithm crop without upgrading an unproved body', () => {
  const f = sample()
  f.page.lines = f.page.lines.slice(0, 4)
  f.page.lines[1].text = 'Require: values'
  f.page.lines[2].text = '1: Initialize'
  f.page.lines[3].text = '2: return result'
  const previous = findAlgorithmCandidates(f.page, f.context.rules)
  expect(previous).toHaveLength(1)
  expect(findNativeAlgorithmCandidates(f.page, f.context)).toEqual(previous)
  expect(previous[0].nativeBody).toBeUndefined()
})

function outlinedEnding(): ReturnType<typeof JSON.parse> {
  const f = sample(),
    index = f.context.content.items.length
  const item = {
    str: '..Q',
    dir: 'ltr',
    width: 14,
    height: 10,
    transform: [10, 0, 0, 10, 336, 590],
    fontName: 'outline',
    sourceItem: { pageNumber: 1, index, text: '..Q' }
  }
  f.context.content.items.push(item)
  f.context.content.styles.outline = { ascent: 0.8, descent: -0.2 }
  f.page.lines.push({ text: '..Q', x: 336, y: 200, width: 14, height: 10, fontSize: 10 })
  const glyph = (unicode: string, fontChar: string, width: number): Record<string, unknown> => ({
    unicode,
    fontChar,
    width,
    isInFont: true,
    isSpace: false,
    accent: null
  })
  f.context.nativeGlyphContext = {
    content: structuredClone(f.context.content),
    viewport: structuredClone(f.context.viewport),
    operators: {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [
        ['outline', 10],
        [[glyph('.', 'dot', 250), glyph('.', 'dot', 250), glyph('Q', 'tail', 900)]]
      ]
    },
    partialFontGlyphBounds: [
      {
        fontName: 'outline',
        glyphs: [
          { fontChar: 'dot', bounds: [0, 0, 0.2, 0.2] },
          { fontChar: 'tail', bounds: [0, 0, 1, 0.7] }
        ]
      }
    ]
  }
  return f
}

it('includes exact whole-run outline overhang without changing original claims', () => {
  const f = outlinedEnding(),
    before = structuredClone(f),
    without = structuredClone(f)
  delete without.context.nativeGlyphContext
  const old = findNativeAlgorithmCandidates(without.page, without.context)[0]
  const result = findNativeAlgorithmCandidates(f.page, f.context)[0]
  expect(old.rect[2]).toBe(350)
  expect(result.rect[2]).toBe(351)
  expect(result.nativeBody).toEqual(old.nativeBody)
  expect(result.caption).toEqual(old.caption)
  expect(f).toEqual(before)
})

it.each([
  'missing-font',
  'missing-glyph',
  'changed-source',
  'changed-width',
  'spacing',
  'kerning',
  'accent',
  'stroke',
  'ambiguous-glyph',
  'foreign-paint',
  'foreign-text'
])('does not expand an algorithm from incomplete outline proof: %s', (mode) => {
  const f = outlinedEnding(),
    p = f.context.nativeGlyphContext
  if (mode === 'missing-font') p.partialFontGlyphBounds = []
  if (mode === 'missing-glyph') p.partialFontGlyphBounds[0].glyphs.pop()
  if (mode === 'changed-source') p.content.items.at(-1).str = 'Other'
  if (mode === 'changed-width') p.operators.argsArray[1][0][2].width = 899
  if (mode === 'spacing') {
    p.operators.fnArray.unshift(OPS.setCharSpacing)
    p.operators.argsArray.unshift([1])
  }
  if (mode === 'kerning') p.operators.argsArray[1][0].splice(1, 0, 1)
  if (mode === 'accent') p.operators.argsArray[1][0][2].accent = { fontChar: 'mark' }
  if (mode === 'stroke') {
    p.operators.fnArray.unshift(OPS.setTextRenderingMode)
    p.operators.argsArray.unshift([1])
  }
  if (mode === 'ambiguous-glyph') {
    p.operators.fnArray.push(OPS.showText)
    const run = structuredClone(p.operators.argsArray[1])
    run[0][2].fontChar = 'other'
    p.operators.argsArray.push(run)
    p.partialFontGlyphBounds[0].glyphs.push({ fontChar: 'other', bounds: [0, 0, 2, 0.7] })
  }
  if (mode === 'foreign-paint')
    f.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [350.5 / 400, 200 / 800, 360 / 400, 210 / 800]
    })
  if (mode === 'foreign-text') {
    const index = f.context.content.items.length,
      item = {
        str: 'Side note',
        dir: 'ltr',
        width: 20,
        height: 10,
        transform: [10, 0, 0, 10, 350.5, 590],
        fontName: 'native',
        sourceItem: { pageNumber: 1, index, text: 'Side note' }
      }
    f.context.content.items.push(item)
    p.content.items.push(structuredClone(item))
    f.page.lines.push({ text: 'Side note', x: 350.5, y: 200, width: 20, height: 10, fontSize: 10 })
  }
  expect(findNativeAlgorithmCandidates(f.page, f.context)[0].rect[2]).toBe(350)
})

function wrappedSample(): ReturnType<typeof JSON.parse> {
  const rows: [string, number, number, number, string][] = [
    ['1', 42, 108, 6, 'number'],
    ['Procedure Collect(values)', 60, 108, 10, 'native'],
    ['2', 42, 128, 6, 'number'],
    ['Initialize values;', 70, 128, 10, 'native'],
    ['// explain', 250, 128, 10, 'comment'],
    ['continued explanation', 75, 142, 10, 'comment'],
    ['3', 42, 162, 6, 'number'],
    ['for value in values do', 70, 162, 10, 'native'],
    ['4', 42, 192, 6, 'number'],
    ['sum ←', 90, 192, 10, 'native'],
    ['(', 110, 181, 10, 'delimiter'],
    ['value', 115, 192, 10, 'native'],
    ['k', 135, 196, 6, 'native'],
    ['5', 42, 222, 6, 'number'],
    ['return total', 70, 222, 10, 'native'],
    ['Algorithm 1: Collect values', 60, 257, 10, 'native'],
    ['Independent paragraph.', 50, 290, 10, 'native']
  ]
  const items = rows.map(([str, x, b, height, fontName], index) => ({
    str,
    width: str.length * 4,
    height,
    dir: 'ltr',
    fontName,
    transform: [height, 0, 0, height, x, 800 - b],
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  const rules = [
    [58, 115, 58, 247],
    [78, 169, 78, 210]
  ]
  const page = {
    pageNumber: 1,
    width: 400,
    height: 800,
    rotation: 0,
    invalidGraphicsBounds: 0,
    lines: items.map((t) => ({
      text: t.str,
      x: t.transform[4],
      y: 800 - t.transform[5] - t.height,
      width: t.width,
      height: t.height,
      fontSize: t.height
    })),
    graphicsBounds: rules.map((r, i) => ({
      kind: 'path',
      operationIndex: i,
      normalizedRect: r.map((v, n) => v / (n % 2 ? 800 : 400))
    }))
  }
  const context = {
    rules,
    content: {
      items,
      styles: {
        native: { ascent: 0.8, descent: -0.2 },
        number: { ascent: 0.8, descent: -0.2 },
        comment: { ascent: 0.8, descent: -0.2, fontFamily: 'monospace' },
        delimiter: { ascent: 0.1, descent: 0 }
      }
    },
    viewport: { width: 400, height: 800, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 800] }
  }
  return { page, context }
}
function replaceWrapped(f: ReturnType<typeof wrappedSample>, index: number, str: string): void {
  const t = f.context.content.items[index]
  t.str = str
  t.width = str.length * 4
  t.sourceItem.text = str
  f.page.lines[index].text = str
  f.page.lines[index].width = t.width
}
function moveWrapped(
  f: ReturnType<typeof wrappedSample>,
  index: number,
  dx: number,
  dy: number
): void {
  const t = f.context.content.items[index]
  t.transform[4] += dx
  t.transform[5] -= dy
  f.page.lines[index].x += dx
  f.page.lines[index].y += dy
}
const wrappedNegatives: Record<string, (f: ReturnType<typeof wrappedSample>) => void> = {
  'no-comment-start': (f) => replaceWrapped(f, 4, 'Explanation'),
  'foreign-comment-font': (f) => {
    f.context.content.items[5].fontName = 'native'
  },
  'comment-crosses-next-number': (f) => moveWrapped(f, 5, 0, 19),
  'comment-outside-indent': (f) => moveWrapped(f, 5, -20, 0),
  'unknown-delimiter-font': (f) => {
    delete f.context.content.styles.delimiter.ascent
  },
  'ordinary-raised-word-envelope': (f) => {
    f.context.content.styles.delimiter.ascent = 0.8
  },
  'delimiter-not-adjacent': (f) => moveWrapped(f, 10, 100, 0),
  'delimiter-between-rows': (f) => moveWrapped(f, 10, 0, -12),
  'ordinal-gap': (f) => replaceWrapped(f, 8, '7'),
  'missing-scope': (f) => {
    f.context.rules.pop()
  },
  'unrelated-prose': (f) => replaceWrapped(f, 5, 'Algorithm 8: An unrelated block'),
  'literal-mismatch': (f) => {
    f.context.content.items[5].sourceItem.text = 'Other'
  }
}

it('owns wrapped comments and raised delimiters only within their numbered native packet', () => {
  const f = wrappedSample(),
    before = structuredClone(f),
    result = findNativeAlgorithmCandidates(f.page, f.context)
  expect(result).toHaveLength(1)
  expect(result[0].nativeBody.sourceItems).toEqual(
    f.context.content.items.slice(0, -2).map((t: { sourceItem: unknown }) => t.sourceItem)
  )
  expect(f).toEqual(before)
})
it.each(Object.keys(wrappedNegatives))('rejects incomplete wrapped packet proof: %s', (name) => {
  const f = wrappedSample()
  wrappedNegatives[name](f)
  expect(findNativeAlgorithmCandidates(f.page, f.context)).toHaveLength(0)
})

// A complete unnumbered supplementary routine may close by its loop rather
// than Return. The native baseline packets keep inline math and then together.
function nestedDataLoop(): ReturnType<typeof JSON.parse> {
  const f = sample()
  const rows: [string, number, number, number][] = [
    ['Algorithm S2 Update values', 50, 100, 10],
    ['Input: bound', 65, 120, 10],
    ['Data: values', 65, 135, 10],
    ['for value in values do', 65, 150, 10],
    ['if value > limit', 80, 165, 10],
    ['then', 170, 165, 10],
    ['Set total ← value', 95, 180, 10],
    ['else', 80, 195, 10],
    ['Compute', 95, 210, 10],
    ['total = value / bound', 160, 225, 10],
    ['Set total ← total + 1', 95, 240, 10],
    ['end if', 80, 255, 10],
    ['end for', 65, 270, 10],
    ['Independent paragraph.', 50, 315, 10]
  ]
  f.context.content.items = rows.map(([str, x, y, height], index) => ({
    str,
    dir: 'ltr',
    width: str.length * 4,
    height,
    transform: [height, 0, 0, height, x, 800 - y - height],
    fontName: 'native',
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  f.page.lines = rows.map(([text, x, y, height]) => ({
    text,
    x,
    y,
    width: text.length * 4,
    height,
    fontSize: height
  }))
  f.context.rules[2] = [50, 284, 350, 284]
  f.page.graphicsBounds = f.context.rules.map((r: number[], operationIndex: number) => ({
    kind: 'path',
    operationIndex,
    normalizedRect: r.map((v, n) => v / (n % 2 ? 800 : 400))
  }))
  return f
}
it('proves a supplementary nested native loop closed without a return', () => {
  const f = nestedDataLoop(),
    before = structuredClone(f)
  const result = findNativeAlgorithmCandidates(f.page, f.context)
  expect(result).toHaveLength(1)
  expect(result[0].nativeBody.sourceItems).toEqual(
    f.context.content.items.slice(1, -1).map((i: { sourceItem: unknown }) => i.sourceItem)
  )
  expect(f).toEqual(before)
})
it.each([
  'input',
  'data',
  'title',
  'divider',
  'bottom',
  'unclosed',
  'wrong-close',
  'else-twice',
  'empty-branch',
  'outdented',
  'native-literal',
  'native-font',
  'unrelated-after-close',
  'detached-then',
  'foreign-source',
  'control-source-order',
  'small-tail'
])('rejects an unnumbered nested routine with %s', (mode) => {
  const f = nestedDataLoop()
  const replace = (index: number, str: string): void => {
    Object.assign(f.context.content.items[index], { str, width: str.length * 4 })
    f.context.content.items[index].sourceItem.text = str
    Object.assign(f.page.lines[index], { text: str, width: str.length * 4 })
  }
  if (mode === 'input') replace(1, 'A list of bounds')
  if (mode === 'data') replace(2, 'Some values')
  if (mode === 'title') replace(0, 'Prompt S2 Update values')
  if (mode === 'divider') f.context.rules.splice(1, 1)
  if (mode === 'bottom') f.context.rules.pop()
  if (mode === 'unclosed') replace(12, 'Keep the result')
  if (mode === 'wrong-close') replace(12, 'end if')
  if (mode === 'else-twice') replace(10, 'else')
  if (mode === 'empty-branch') replace(6, 'else')
  if (mode === 'outdented') {
    f.page.lines[6].x = 65
    f.context.content.items[6].transform[4] = 65
  }
  if (mode === 'native-literal') f.context.content.items[6].sourceItem.text = 'Other'
  if (mode === 'native-font') delete f.context.content.styles.native.ascent
  if (mode === 'unrelated-after-close') {
    f.page.lines[13].y = 281
    f.context.content.items[13].transform[5] = 509
  }
  if (mode === 'detached-then') {
    f.page.lines[5].y += 4
    f.context.content.items[5].transform[5] -= 4
  }
  if (mode === 'foreign-source') f.context.content.items[6].sourceItem.pageNumber = 2
  if (mode === 'control-source-order') {
    const items = f.context.content.items
    ;[items[3], items[4]] = [items[4], items[3]]
    items.forEach((item: { sourceItem: { index: number } }, index: number) => {
      item.sourceItem.index = index
    })
  }
  if (mode === 'small-tail') {
    Object.assign(f.context.content.items[13], { height: 2, transform: [2, 0, 0, 2, 65, 517] })
    Object.assign(f.page.lines[13], { x: 65, y: 281, height: 2, fontSize: 2 })
  }
  expect(
    findNativeAlgorithmCandidates(f.page, f.context).every(
      (r: { nativeBody?: unknown }) => !r.nativeBody
    )
  ).toBe(true)
})

function implicitNumberedLoop(mode = ''): ReturnType<typeof JSON.parse> {
  const f = sample(),
    rows: [string, number, number][] = [
      ['Algorithm 1 Collect sample values', 50, 110],
      ['Require:', 50, 130],
      ['1:', 55, 150],
      ['Assign an empty collection', 70, 150],
      ['2:', 55, 165],
      ['while values remain do', 70, 165],
      ['3:', 55, 180],
      ['Add the next value', 85, 180],
      ['4:', 55, 195],
      ['Update the remaining values', 85, 195],
      ['5:', 55, 210],
      ['Keep the complete collection', 70, 210],
      ['Independent explanation.', 50, 260]
    ]
  if (mode === 'ordinal-gap') rows[6][0] = '4:'
  if (mode === 'missing-input') rows[1][0] = 'Values for the example'
  if (mode === 'broken-indent') rows[9][1] = 70
  if (mode === 'missing-outdent') rows[11][1] = 85
  if (mode === 'nested-control') rows[9][0] = 'if another value remains'
  if (mode === 'wrapped-statement') rows[9][2] += 4
  rows.splice(2, 0, ['ordered values', 90, 130])
  const items = rows.map(([str, x, baseline], index) => ({
    str,
    dir: 'ltr',
    width: str.length * 4,
    height: 10,
    transform: [10, 0, 0, 10, x, 800 - baseline],
    fontName: 'native',
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  if (mode === 'foreign-source') items[7].sourceItem.text = 'Unrelated text'
  if (mode === 'mixed-ordinal-font') items[7].fontName = 'other'
  f.context.content.items = items
  f.context.content.styles.other = { ascent: 0.8, descent: -0.2 }
  f.page.lines = rows.map(([text, x, baseline], i) => ({
    text,
    x,
    y: baseline - 10,
    width: items[i].width,
    height: 10,
    fontSize: 10
  }))
  f.context.rules[2] = [50, 225, 350, 225]
  if (mode === 'missing-frame') f.context.rules.pop()
  f.page.graphicsBounds = f.context.rules.map((r: number[], operationIndex: number) => ({
    kind: 'path',
    operationIndex,
    normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 400))
  }))
  f.context.operators = {
    fnArray: f.context.rules.map(() => OPS.constructPath),
    argsArray: f.context.rules.map((r: number[]) => [
      OPS.stroke,
      [[0, r[0], 800 - r[1], 1, r[2], 800 - r[3]]],
      [r[0], 800 - r[1], r[2], 800 - r[3]]
    ])
  }
  return f
}

it('retains complete numbered loop sources when native indentation closes its scope', () => {
  const f = implicitNumberedLoop(),
    before = structuredClone(f),
    result = findNativeAlgorithmCandidates(f.page, f.context)
  expect(result).toHaveLength(1)
  expect(result[0].nativeBody?.sourceItems).toEqual(
    f.context.content.items.slice(1, 13).map((item: { sourceItem: unknown }) => item.sourceItem)
  )
  expect(f).toEqual(before)
})

it.each([
  'ordinal-gap',
  'missing-input',
  'broken-indent',
  'missing-outdent',
  'nested-control',
  'wrapped-statement',
  'foreign-source',
  'mixed-ordinal-font',
  'missing-frame'
])('keeps an unproved implicitly scoped numbered body unchanged: %s', (mode) => {
  const f = implicitNumberedLoop(mode)
  expect(
    findNativeAlgorithmCandidates(f.page, f.context).every(
      (candidate: { nativeBody?: unknown }) => !candidate.nativeBody
    )
  ).toBe(true)
})
