import { createCanvas } from '@napi-rs/canvas'
const { collectTableRules: bottomStripRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const {
  proveNativeTableBottomStrip: proveBottomStrip,
  renderNativeTableBottomStrip: renderBottomStrip,
  commitNativeTableBottomStrip: commitBottomStrip
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-table-bottom-strip.mjs')).href
)
import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const {
  refineNativeTableBoundaryInk: refine,
  refineNativeRuledBoundaryMarkerCrop: refineMarker,
  refineNativeRuledUnassignedFooterCrop: refineFooter,
  getNativeOwnedGlyphOverhangCropProof: ownedGlyphProof,
  getNativeOwnedGlyphOverhangCropFallback: ownedGlyphFallback,
  validateNativeOwnedGlyphOverhangCropPng: ownedGlyphPng,
  proveNativeRuleFreeBodyCrop: proveBodyCrop,
  validateNativeRuleFreeBodyCropPng: validateBodyPng
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-table-boundary-ink.mjs')).href
)
const { refineNativeTableVisualCrop: refineVisual } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function example() {
  const texts: [string, number, number, number, number][] = [
    ['Caption', 10, 20, 20, 10],
    ['Head', 10, 40, 20, 10],
    ['Body', 10, 80, 20, 10],
    ['Following paragraph', 10, 105, 80, 20]
  ]
  const content = {
    styles: { F: { ascent: 0.9, descent: -0.3, vertical: false } },
    items: texts.map(([str, x, y, width, height], index) => ({
      str,
      dir: 'ltr',
      width,
      height,
      fontName: 'F',
      transform: [height, 0, 0, height, x, 120 - y],
      sourceItem: { pageNumber: 1, index, text: str }
    }))
  }
  const tokens = content.items.map((i) => ({
    text: i.str,
    height: i.height,
    baseline: 120 - i.transform[5],
    horizontal: true,
    rect: [
      i.transform[4],
      120 - i.transform[5] - i.height,
      i.transform[4] + i.width,
      120 - i.transform[5]
    ],
    sourceItem: i.sourceItem
  }))
  const cells = [1, 2].map((index, row) => ({
    row,
    column: 0,
    rowSpan: 1,
    colSpan: 1,
    text: tokens[index].text,
    sourceItems: [tokens[index].sourceItem],
    sourceRects: [tokens[index].rect]
  }))
  const rules = [
      [0, 30, 100, 30],
      [0, 90, 50, 90],
      [50, 90, 100, 90]
    ],
    rulePaintBounds = new Map(rules.map((r) => [r.join(','), [r[0], r[1] - 0.2, r[2], r[3] + 0.2]]))
  const viewport = {
    width: 100,
    height: 120,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 120]
  }
  const context = {
    content,
    sourceContent: content,
    viewport,
    rulePaintBounds,
    nativeEvidenceGraphics: [...rulePaintBounds.values()].map((rect) => ({ kind: 'path', rect })),
    nativeGlyphContext: {
      content: structuredClone(content),
      viewport,
      operators: { fnArray: [] as number[], argsArray: [] as unknown[][] },
      glyphBounds: [{ fontName: 'F', glyphs: [{ fontChar: 'x', bounds: [0, -0.25, 0.8, 0.6] }] }]
    }
  }
  const table = {
    page: 1,
    cropRect: [0, 22, 100, 95],
    cells,
    clipped: [{ text: tokens[3].text, rect: tokens[3].rect }],
    issues: ['text-crosses-crop-boundary'],
    excludedCaptionItems: ['Caption'],
    caption: { page: 1, text: 'Caption', lines: ['Caption'], rect: [10, 10, 30, 20] }
  }
  const proof = { proved: cells.map((cell, i) => ({ cell, fonts: [tokens[i + 1]] })) }
  return { table, proof, rules, context, tokens }
}
it('keeps a clipped note below closing paint because a whole cell proof does not own it', () => {
  const f = example()
  f.table.cropRect[1] = 28
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
})
it('recovers an entirely omitted ruled header and warns without inventing grid cells', () => {
  const f = example()
  const items = [
    f.context.content.items[0],
    ...[42, 65, 85].flatMap((y, row) =>
      [10, 40, 70].map((x, column) => ({
        str: row === 0 ? ['Kind', 'Score', 'Count'][column] : String(row + column),
        dir: 'ltr',
        width: 10,
        height: 10,
        fontName: 'F',
        transform: [10, 0, 0, 10, x, 120 - y],
        sourceItem: {
          pageNumber: 1,
          index: 1 + row * 3 + column,
          text: row === 0 ? ['Kind', 'Score', 'Count'][column] : String(row + column)
        }
      }))
    )
  ]
  f.context.content.items = items
  f.context.nativeGlyphContext.content = structuredClone(f.context.content)
  f.rules = [
    [0, 30, 100, 30],
    [0, 50, 100, 50]
  ]
  f.context.rulePaintBounds = new Map(
    f.rules.map((r) => [r.join(','), [0, r[1] - 0.2, 100, r[1] + 0.2]])
  )
  f.context.nativeEvidenceGraphics = [...f.context.rulePaintBounds.values()].map((rect) => ({
    kind: 'path',
    rect
  }))
  f.table.cells = items.slice(4).map((i, index) => ({
    row: Math.floor(index / 3),
    column: index % 3,
    rowSpan: 1,
    colSpan: 1,
    text: i.str,
    sourceItems: [i.sourceItem],
    sourceRects: [
      [i.transform[4], 110 - i.transform[5], i.transform[4] + i.width, 120 - i.transform[5]]
    ]
  }))
  f.table.cropRect = [0, 45, 100, 88]
  f.table.clipped = []
  const before = structuredClone(f.table)
  const recovered = refine(f.table, f.rules, f.context)
  expect(recovered?.cropRect).toEqual([0, 29.8, 100, 88])
  expect(recovered?.issues).toContain('native-table-structure-ambiguous')
  expect(recovered?.reviewCandidate).toBe(false)
  expect(recovered?.cells).toBe(f.table.cells)
  expect(f.table).toEqual(before)
  for (const entries of [[['ca', 0]], [['BM', 'multiply']], [['SMask', true]]]) {
    const hidden = structuredClone(f.context)
    hidden.nativeGlyphContext.operators.fnArray.push(OPS.setGState)
    hidden.nativeGlyphContext.operators.argsArray.push([entries])
    expect(refine(f.table, f.rules, hidden)).toBeUndefined()
  }
  const bad = structuredClone(f.context)
  bad.content = bad.sourceContent
  bad.nativeGlyphContext.glyphBounds = []
  expect(refine(f.table, f.rules, bad)).toBeUndefined()
  expect(refine(f.table, f.rules.slice(1), f.context)).toBeUndefined()
  f.table.cells[1].sourceItems[0] = f.table.cells[0].sourceItems[0]
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
})
it('removes excluded caption descent using the existing native glyph snapshot', () => {
  const f = example()
  f.table.cropRect[3] = 88
  expect(refine(f.table, f.rules, f.context)?.cropRect).toEqual([0, 30 - 0.2, 100, 88])
})
it('retains independently measured rule paint after running-margin graphics filtering', () => {
  const f = example()
  f.table.cropRect[3] = 88
  f.context.nativeEvidenceGraphics = []
  const before = structuredClone(f)
  expect(refine(f.table, f.rules, f.context)?.cropRect).toEqual([0, 29.8, 100, 88])
  expect(f).toEqual(before)
})
it.each(['missing', 'malformed'])(
  'does not trim across a rule with %s paint evidence',
  (failure) => {
    const f = example()
    f.table.cropRect[3] = 88
    f.context.nativeEvidenceGraphics = []
    if (failure === 'missing') f.context.rulePaintBounds.delete(f.rules[0].join(','))
    else f.context.rulePaintBounds.set(f.rules[0].join(','), [0, 29.8, 100])
    expect(refine(f.table, f.rules, f.context)).toBeUndefined()
  }
)
it('uses the vertical em for caption ink when native horizontal text scaling differs', () => {
  const f = example()
  f.table.cropRect[3] = 88
  for (const content of [f.context.content, f.context.nativeGlyphContext.content])
    content.items[0].transform[0] = 8
  expect(refine(f.table, f.rules, f.context)?.cropRect).toEqual([0, 29.8, 100, 88])
})
it('keeps foreign ink entering from a stretched horizontal glyph overhang', () => {
  const f = example()
  f.table.cropRect[3] = 88
  const item = {
    str: 'Side',
    dir: 'ltr',
    width: 5,
    height: 10,
    fontName: 'F',
    transform: [30, 0, 0, 10, -20, 96],
    sourceItem: { pageNumber: 1, index: 4, text: 'Side' }
  }
  f.context.content.items.push(item)
  f.context.nativeGlyphContext.content.items.push(structuredClone(item))
  f.context.nativeGlyphContext.glyphBounds[0].glyphs[0].bounds[2] = 1
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
})
it('does not infer glyph bounds from mismatched native content or missing outlines', () => {
  const f = example()
  f.context.nativeGlyphContext.content.items[0].str = 'Other'
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
  const g = example()
  g.context.nativeGlyphContext.glyphBounds = []
  expect(refine(g.table, g.rules, g.context)).toBeUndefined()
})
it('keeps non-caption and extra graphical ink in a proposed removal strip', () => {
  const f = example()
  f.table.cropRect[3] = 88
  f.table.excludedCaptionItems = []
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
  const g = example()
  g.table.cropRect[1] = 28
  g.context.nativeEvidenceGraphics.push({ kind: 'path', rect: [10, 91, 20, 92] })
  expect(refine(g.table, g.rules, g.context)).toBeUndefined()
})

it('completes a clipped panel title inside its own two-rule header band', () => {
  const f = example(),
    title = 'Panel B: Results'
  for (const content of [f.context.content, f.context.nativeGlyphContext.content]) {
    content.items[0].str = title
    content.items[0].sourceItem.text = title
  }
  f.table.cropRect = [0, 19, 100, 88]
  f.table.caption.page = 2
  f.table.clipped = [{ text: title, rect: f.tokens[0].rect }]
  f.rules.splice(0, 1, [0, 8, 100, 8], [0, 26, 100, 26])
  f.context.rulePaintBounds = new Map(
    f.rules.map((r) => [r.join(','), [r[0], r[1] - 0.2, r[2], r[3] + 0.2]])
  )
  f.context.nativeEvidenceGraphics = [...f.context.rulePaintBounds.values()].map((rect) => ({
    kind: 'path',
    rect
  }))
  expect(refine(f.table, f.rules, f.context)?.cropRect).toEqual([0, 7.8, 100, 88])
  f.context.nativeEvidenceGraphics.push({ kind: 'path', rect: [5, 10, 9, 12] })
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
  f.context.nativeEvidenceGraphics.pop()
  // The previous paragraph's advance ends above the header band, but its
  // descenders still paint into the newly added strip.
  for (const content of [f.context.content, f.context.nativeGlyphContext.content]) {
    const previous = structuredClone(content.items[1])
    previous.str = 'g'
    previous.width = 10
    previous.transform[5] = 114
    previous.sourceItem = { pageNumber: 1, index: content.items.length, text: 'g' }
    content.items.push(previous)
  }
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
})
it('uses existing graphics state to resolve a quantized closed even-odd fill, but not an unknown path', () => {
  const f = example()
  f.table.cropRect[3] = 88
  f.context.nativeGlyphContext.operators.fnArray = [OPS.constructPath]
  f.context.nativeGlyphContext.operators.argsArray = [
    [OPS.eoFill, [[0, 0, 89.8, 1, 100, 89.8, 1, 100, 90.2, 1, 0, 90.2, 4]], [0, 89.8, 100, 90.2]]
  ]
  f.context.nativeEvidenceGraphics = [{ kind: 'path', rect: [0, 21, 100, 32] }]
  Object.assign(f.context, {
    nativePaintIdentityGraphics: [{ kind: 'path', rect: [0, 21, 100, 32], operationIndex: 0 }]
  })
  expect(refine(f.table, f.rules, f.context)?.cropRect[1]).toBeCloseTo(29.8, 8)
  f.context.nativeGlyphContext.operators.argsArray[0][0] = OPS.fillStroke
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function citedFooter() {
  const f = example()
  const texts: [string, number, number, number, number, string][] = [
    ['Caption', 10, 20, 20, 10, 'F'],
    ['12', 50, 60, 10, 10, 'F'],
    ['∗', 61, 56, 3, 7, 'M'],
    ['∗', 10, 94, 3, 7, 'M'],
    ['Compared with the reference.', 17, 98, 60, 10, 'F'],
    ['Following paragraph', 10, 114, 60, 10, 'F']
  ]
  for (const content of [f.context.content, f.context.nativeGlyphContext.content]) {
    Object.assign(content.styles, { M: { ascent: 0.9, descent: -0.3, vertical: false } })
    content.items = texts.map(([str, x, y, width, height, fontName], index) => ({
      str,
      dir: 'ltr',
      width,
      height,
      fontName,
      transform: [height, 0, 0, height, x, 120 - y],
      sourceItem: { pageNumber: 1, index, text: str }
    }))
  }
  f.context.nativeGlyphContext.glyphBounds.push({
    fontName: 'M',
    glyphs: [{ fontChar: 'x', bounds: [0, 0, 0.5, 0.5] }]
  })
  const box = (index: number): number[] => {
    const [, x, y, width, height] = texts[index]
    return [x, y - height, x + width, y]
  }
  f.table.cropRect = [0, 28, 100, 95]
  f.table.cells = [
    {
      row: 0,
      column: 0,
      rowSpan: 1,
      colSpan: 1,
      text: '12 ∗',
      sourceItems: [1, 2].map((i) => f.context.content.items[i].sourceItem),
      sourceRects: [box(1), box(2)]
    }
  ]
  f.table.clipped = [3, 4].map((i) => ({ text: texts[i][0], rect: box(i) }))
  f.rules = [[0, 90, 100, 90]]
  f.context.rulePaintBounds = new Map([['0,90,100,90', [0, 89.8, 100, 90.2]]])
  f.context.nativeEvidenceGraphics = [{ kind: 'path', rect: [0, 89.8, 100, 90.2] }]
  return f
}

it('completes only a cited raised footer whose full native ink lies beyond closing paint', () => {
  const f = citedFooter(),
    before = structuredClone(f.table)
  const result = refine(f.table, f.rules, f.context)
  expect(result?.cropRect).toEqual([0, 28, 100, 101])
  expect(f.table).toEqual(before)
  expect({ ...result, cropRect: before.cropRect }).toEqual(before)
})
it('includes a complete two-line cited note without swallowing the following paragraph', () => {
  const f = citedFooter()
  f.context.viewport.width = 140
  f.context.nativeGlyphContext.viewport.width = 140
  for (const content of [f.context.content, f.context.nativeGlyphContext.content]) {
    content.items[4].str = 'Compared with the'
    content.items[4].sourceItem.text = 'Compared with the'
    content.items[4].width = 90
    content.items[5].str = 'reference.'
    content.items[5].sourceItem.text = 'reference.'
    content.items[5].width = 35
    content.items[5].transform[5] = 11
  }
  f.table.clipped[1] = { text: 'Compared with the', rect: [17, 88, 107, 98] }
  const before = structuredClone(f.table)
  expect(refine(f.table, f.rules, f.context)?.cropRect).toEqual([0, 28, 115, 112])
  expect(f.table).toEqual(before)
  for (const content of [f.context.content, f.context.nativeGlyphContext.content]) {
    content.items[5].str = 'Unfinished sentence'
    content.items[5].sourceItem.text = 'Unfinished sentence'
  }
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
})

it('requires a unique native citation, closing stroke and exclusive footer expansion strip', () => {
  for (const variant of [
    'uncited',
    'no-rule',
    'extra-ink',
    'foreign-text',
    'wrong-source',
    'annotation'
  ]) {
    const f = citedFooter()
    if (variant === 'uncited') f.table.cells = []
    if (variant === 'no-rule') f.rules = []
    if (variant === 'extra-ink')
      f.context.nativeEvidenceGraphics.push({ kind: 'path', rect: [20, 96, 40, 99] })
    if (variant === 'foreign-text')
      for (const content of [f.context.content, f.context.nativeGlyphContext.content])
        content.items[5].transform[5] = 22
    if (variant === 'wrong-source')
      f.table.cells[0].sourceItems[1] = { pageNumber: 1, index: 5, text: '∗' }
    if (variant === 'annotation') {
      f.context.nativeGlyphContext.operators.fnArray.push(OPS.beginAnnotation)
      f.context.nativeGlyphContext.operators.argsArray.push([])
    }
    expect(refine(f.table, f.rules, f.context), variant).toBeUndefined()
  }
})
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function pairedPanels() {
  const f = example(),
    entries: [string, number, number, number, number][] = [
      ['Table 4. Paired measurements.', 10, 20, 150, 10],
      ['Panel A (estimates)', 140, 40, 120, 10]
    ]
  for (const [i, x] of [20, 100, 180, 260].entries())
    entries.push([['Name', 'First', 'Second', 'Third'][i], x, 60, 30, 10])
  for (const [r, y] of [83, 113].entries()) {
    entries.push([['Alpha', 'Beta'][r], 20, y, 35, 10])
    for (const x of [100, 180, 260]) {
      entries.push(['1', x, y - 7, 10, 10], ['[0, 2]', x - 10, y + 7, 30, 7.5])
    }
  }
  entries.push(['Panel B (scores)', 140, 140, 120, 10])
  const bodyStart = entries.length
  for (const [row, y] of [160, 180, 210].entries())
    for (const [col, x] of [20, 150, 280].entries())
      entries.push([row ? String(row + col) : ['Name', 'First', 'Second'][col], x, y, 35, 10])
  f.context.viewport.width = 400
  f.context.nativeGlyphContext.viewport.width = 400
  const items = entries.map(([str, x, y, width, height], index) => ({
    str,
    dir: 'ltr',
    width,
    height,
    fontName: 'F',
    transform: [height, 0, 0, height, x, 300 - y],
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  f.context.content.items = items
  f.context.nativeGlyphContext.content = structuredClone(f.context.content)
  f.context.viewport.height = 300
  f.context.viewport.transform[5] = 300
  Object.assign(f.context, {
    captions: [{ page: 1, lines: [entries[0][0]], rect: [10, 10, 160, 20] }]
  })
  const box = (i: number): number[] => [
    entries[i][1],
    entries[i][2] - entries[i][4],
    entries[i][1] + entries[i][3],
    entries[i][2]
  ]
  f.table.cells = items.slice(bodyStart).map((i, n) => ({
    row: Math.floor(n / 3),
    column: n % 3,
    rowSpan: 1,
    colSpan: 1,
    text: i.str,
    sourceItems: [i.sourceItem],
    sourceRects: [box(bodyStart + n)]
  }))
  f.table.cropRect = [10, 135, 390, 235]
  Object.assign(f.table, { caption: undefined })
  f.table.clipped = [{ text: 'Panel B (scores)', rect: box(bodyStart - 1) }]
  f.rules = [45, 65, 125, 145, 165, 225].map((y) => [20, y, 380, y])
  f.context.rulePaintBounds = new Map(
    f.rules.map((r) => [r.join(','), [20, r[1] - 0.2, 380, r[1] + 0.2]])
  )
  f.context.nativeEvidenceGraphics = [...f.context.rulePaintBounds.values()].map((rect) => ({
    kind: 'path',
    rect
  }))
  return f
}
it('recovers both complete native panels while retaining only the proven grid and warning', () => {
  const f = pairedPanels(),
    before = structuredClone(f.table)
  const recovered = refine(f.table, f.rules, f.context)
  expect(recovered?.cropRect).toEqual([10, 30, 390, 235])
  expect(recovered?.issues).toContain('native-table-structure-ambiguous')
  expect(recovered?.reviewCandidate).toBe(false)
  expect(recovered?.cells).toBe(f.table.cells)
  expect(recovered?.caption).toEqual({
    page: 1,
    lines: ['Table 4. Paired measurements.'],
    text: 'Table 4. Paired measurements.',
    rect: [10, 10, 160, 20]
  })
  expect(f.table).toEqual(before)
})
it('does not replace an existing panel caption with a different nearby caption', () => {
  const f = pairedPanels(),
    caption = { page: 1, text: 'Previously associated.', rect: [10, 0, 150, 8] }
  Object.assign(f.table, { caption })
  expect(refine(f.table, f.rules, f.context)?.caption).toBe(caption)
})
it.each([
  ['footer', citedFooter],
  ['panels', pairedPanels]
] as const)('does not restore %s from non-opaque native text', (_name, fixture) => {
  for (const entries of [[['ca', 0]], [['BM', 'multiply']], [['SMask', true]]]) {
    const f = fixture()
    expect(refine(f.table, f.rules, f.context)).toBeDefined()
    f.context.nativeGlyphContext.operators.fnArray.unshift(OPS.setGState)
    f.context.nativeGlyphContext.operators.argsArray.unshift([entries])
    expect(refine(f.table, f.rules, f.context)).toBeUndefined()
  }
})
it.each(['caption', 'rule', 'body prose', 'source', 'glyphs'])(
  'does not union panels without complete %s evidence',
  (guard) => {
    const f = pairedPanels()
    if (guard === 'caption') Object.assign(f.context, { captions: [] })
    if (guard === 'rule') f.rules.splice(1, 1)
    if (guard === 'body prose')
      for (const c of [f.context.content, f.context.nativeGlyphContext.content]) {
        c.items[7].str = 'An ordinary sentence'
        c.items[7].sourceItem.text = c.items[7].str
      }
    if (guard === 'source') f.table.cells[0].sourceRects[0] = []
    if (guard === 'glyphs') f.context.nativeGlyphContext.glyphBounds = []
    expect(refine(f.table, f.rules, f.context)).toBeUndefined()
  }
)

// Full text packets distinguish actual neighboring ink from conservative font envelopes.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function packetBoundary(
  grouped: boolean,
  rowStub: boolean | 'multiline' | 'multiline-other-font' = false,
  bottom = false
) {
  const entries: [string, number, number, boolean][] = grouped
    ? [
        ['Table 2. Results.', 100, 20, false],
        ['First', 180, 53, false],
        ['Next', 240, 53, false],
        ['Size', 145, 64, false],
        ['Name', 110, 73, true],
        ['Type', 145, 73, true],
        ['A', 185, 73, true],
        ['B', 245, 73, true],
        ['One', 110, 100, true],
        ['2', 185, 100, true],
        ['3', 245, 100, true],
        ['Section', 110, 120, false],
        ['Two', 110, 145, true],
        ['4', 185, 145, true],
        ['5', 245, 145, true]
      ]
    : [
        ['Table 2. Results.', 150, 20, false],
        ['Kind', 155, 60, true],
        ['Value', 245, 60, true],
        ['One', 155, 100, true],
        ['2', 245, 100, true],
        ['Two', 155, 145, true],
        ['3', 245, 145, true],
        ...Array.from({ length: 13 }, (_, i): [string, number, number, boolean] => [
          i === 12
            ? 'The paragraph finally ends.'
            : i === 6
              ? 'See Table 2 for the results'
              : 'Neighbor paragraph has text',
          10,
          25 + i * 14,
          false
        ])
      ]
  if (bottom) {
    entries[3][2] = entries[4][2] = 80
    entries[5][2] = entries[6][2] = 100
    for (let i = 14; i < entries.length - 1; i++)
      entries[i][0] = 'The whole paragraph continues across the table'
  }
  if (rowStub === true)
    entries.splice(
      7,
      entries.length - 7,
      ['Participant group', 60, 60, false],
      ['Control condition', 60, 100, false],
      ['Treatment cohort', 60, 145, false]
    )
  if (typeof rowStub === 'string') {
    for (const index of [3, 4]) entries[index][2] = 88
    for (const index of [5, 6]) entries[index][2] = 116
    entries.splice(
      7,
      entries.length - 7,
      ['Participant group', 60, 53, false],
      ['Matching controls', 60, 67, false],
      ['Control condition', 60, 81, false],
      ['Baseline subjects', 60, 95, false],
      ['Treatment cohort', 60, 109, false],
      ['Patient records.', 60, 123, false]
    )
  }
  const items = entries.map(([str, x, y], index) => ({
    str,
    width: str.length * 5,
    height: 10,
    dir: 'ltr',
    fontName: rowStub === 'multiline-other-font' && index >= 7 ? 'G' : 'F',
    transform: [10, 0, 0, 10, x, 200 - y],
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  const box = (n: number): number[] => [
    entries[n][1],
    entries[n][2] - 10,
    entries[n][1] + items[n].width,
    entries[n][2]
  ]
  const content = { items, styles: { F: { vertical: false }, G: { vertical: false } } },
    viewport = { width: 300, height: 200, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 200] },
    operators = { fnArray: [] as number[], argsArray: [] as unknown[] }
  for (const item of items) {
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      [item.fontName, 10],
      [new Float32Array([1, 0, 0, 1, item.transform[4], item.transform[5]])],
      [Array.from(item.str, (c) => ({ unicode: c, fontChar: c, width: 500, isInFont: true }))],
      null
    )
  }
  const rules = grouped
    ? [
        [100, 40, 290, 40],
        [170, 57, 215, 57],
        [230, 57, 285, 57],
        [100, 75, 290, 75],
        [100, 170, 290, 170]
      ]
    : (bottom ? [40, 75, 114] : [40, 75, 120, 170]).map((y) => [150, y, 290, y])
  const rulePaintBounds = new Map(
    rules.map((r) => [r.join(','), [r[0], r[1] - 0.2, r[2], r[3] + 0.2]])
  )
  const context = {
    content,
    sourceContent: content,
    viewport,
    rulePaintBounds,
    nativeEvidenceGraphics: [...rulePaintBounds.values()].map((rect) => ({ kind: 'path', rect })),
    nativeGlyphContext: {
      content: structuredClone(content),
      viewport,
      operators,
      graphicsBounds: [],
      glyphBounds: ['F', 'G'].map((fontName) => ({
        fontName,
        glyphs: [...new Set(items.flatMap((i) => Array.from(i.str)))].map((c) => ({
          fontChar: c,
          bounds: c === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7]
        }))
      }))
    }
  }
  const table = {
    page: 1,
    cropRect: grouped ? [95, 58, 295, 175] : bottom ? [145, 35, 295, 121] : [135, 35, 295, 175],
    cells: entries.flatMap((entry, n) =>
      entry[3]
        ? [
            {
              row: n,
              column: n % 3,
              rowSpan: 1,
              colSpan: 1,
              text: items[n].str,
              sourceItems: [items[n].sourceItem],
              sourceRects: [box(n)]
            }
          ]
        : []
    ),
    caption: { page: 1, text: items[0].str, rect: box(0) },
    unassigned: grouped ? ['Section'] : [],
    issues: grouped ? ['native-table-structure-ambiguous'] : [],
    reviewCandidate: !grouped
  }
  return { table, context, rules }
}
it('restores a partially owned grouped header without inventing cells or removing fallback', () => {
  const f = packetBoundary(true),
    before = structuredClone(f.table),
    result = refine(f.table, f.rules, f.context)
  expect(result?.cropRect).toEqual([95, 39.8, 295, 175])
  expect({ ...result, cropRect: before.cropRect }).toEqual(before)
  expect(result?.cells).toBe(f.table.cells)
  expect(f.table).toEqual(before)
})
it('removes only neighboring paragraph ink while retaining every table paint and cell', () => {
  const f = packetBoundary(false),
    before = structuredClone(f.table),
    result = refine(f.table, f.rules, f.context)
  expect(result?.cropRect).toEqual([150, 35, 295, 175])
  expect({ ...result, cropRect: before.cropRect }).toEqual(before)
  expect(result?.cells).toBe(f.table.cells)
  expect(f.table).toEqual(before)
})
it('bounds a table above the complete paragraph that wraps beside and below its rules', () => {
  const f = packetBoundary(false, false, true),
    before = structuredClone(f)
  f.table.issues = ['native-table-structure-ambiguous']
  const result = refine(f.table, f.rules, f.context)
  expect(result?.cropRect).toEqual([145, 35, 295, 114.2])
  expect({ ...result, cropRect: f.table.cropRect }).toEqual(f.table)
  expect(result?.cells).toBe(f.table.cells)
  expect(f.context).toEqual(before.context)
})
it.each([
  'missing closing paint',
  'foreign paint',
  'invisible text',
  'missing glyph',
  'source conflict',
  'unfinished paragraph',
  'wrong reference',
  'note within table lane'
])('keeps a bottom boundary without complete wrapping-paragraph proof: %s', (guard) => {
  const f = packetBoundary(false, false, true)
  if (guard === 'missing closing paint') f.context.rulePaintBounds.delete(f.rules.at(-1)!.join(','))
  if (guard === 'foreign paint')
    f.context.nativeEvidenceGraphics.push({ kind: 'path', rect: [180, 118, 190, 120] })
  if (guard === 'invisible text') {
    f.context.nativeGlyphContext.operators.fnArray.unshift(OPS.setGState)
    f.context.nativeGlyphContext.operators.argsArray.unshift([['ca', 0]])
  }
  if (guard === 'missing glyph') f.context.nativeGlyphContext.glyphBounds[0].glyphs.pop()
  if (guard === 'source conflict') f.table.cells[0].sourceItems[0].text = 'Different'
  if (
    guard === 'unfinished paragraph' ||
    guard === 'wrong reference' ||
    guard === 'note within table lane'
  ) {
    for (const c of [f.context.content, f.context.nativeGlyphContext.content]) {
      const item =
        guard === 'unfinished paragraph'
          ? c.items.at(-1)!
          : guard === 'wrong reference'
            ? c.items[13]
            : c.items[14]
      if (guard === 'note within table lane') item.transform[4] = 155
      else
        item.str = item.str.replace(
          guard === 'unfinished paragraph' ? '.' : 'Table 2',
          guard === 'unfinished paragraph' ? ',' : 'Table 3'
        )
      item.sourceItem.text = item.str
    }
    // Keep the operator and native inventory consistent: these are real
    // alternative paragraphs/footnote positions, not stale packet failures.
    for (let i = 0; i < f.context.content.items.length; i++) {
      const item = f.context.content.items[i]
      const glyphs = f.context.nativeGlyphContext.glyphBounds.find(
        (g) => g.fontName === item.fontName
      )!.glyphs
      for (const char of item.str)
        if (!glyphs.some((g) => g.fontChar === char))
          glyphs.push({ fontChar: char, bounds: [0, 0, 0.5, 0.7] })
      f.context.nativeGlyphContext.operators.argsArray[i * 5 + 2] = [
        new Float32Array([1, 0, 0, 1, item.transform[4], item.transform[5]])
      ]
      f.context.nativeGlyphContext.operators.argsArray[i * 5 + 3] = [
        Array.from(item.str, (c) => ({ unicode: c, fontChar: c, width: 500, isInFont: true }))
      ]
    }
  }
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
})
it.each([
  'missing packet',
  'source conflict',
  'wrong caption',
  'invisible text',
  'foreign paint',
  'narrow final frame'
])('does not recover packet boundaries with %s', (guard) => {
  for (const grouped of [true, false]) {
    const f = packetBoundary(grouped)
    if (guard === 'missing packet') f.context.nativeGlyphContext.operators.fnArray.pop()
    if (guard === 'source conflict') f.table.cells[0].sourceRects[0] = []
    if (guard === 'wrong caption') f.table.caption.text = 'Unrelated title'
    if (guard === 'invisible text') {
      f.context.nativeGlyphContext.operators.fnArray.unshift(OPS.setGState)
      f.context.nativeGlyphContext.operators.argsArray.unshift([[['ca', 0]]])
    }
    if (guard === 'foreign paint')
      f.context.nativeEvidenceGraphics.push({
        kind: 'image',
        rect: grouped ? [96, 43, 110, 48] : [130, 80, 155, 82]
      })
    if (guard === 'narrow final frame') f.table.cropRect[grouped ? 2 : 0] = grouped ? 280 : 160
    expect(refine(f.table, f.rules, f.context), `${guard} ${grouped}`).toBeUndefined()
  }
})
it('keeps the complete native fill edge when it extends past the horizontal rules', () => {
  const f = packetBoundary(false)
  f.context.nativeEvidenceGraphics.push({ kind: 'path', rect: [149.5, 90, 290, 95] })
  expect(refine(f.table, f.rules, f.context)?.cropRect).toEqual([149.5, 35, 295, 175])
})
it('refuses a header recovery that would still crop its left labels or add unknown paint', () => {
  const left = packetBoundary(true)
  left.table.cropRect[0] = 120
  expect(refine(left.table, left.rules, left.context)).toBeUndefined()
  const paint = packetBoundary(true)
  paint.context.nativeEvidenceGraphics.push({ kind: 'path', rect: [120, 43, 125, 48] })
  expect(refine(paint.table, paint.rules, paint.context)).toBeUndefined()
})

it('does not discard a row-aligned missing stub column as neighboring prose', () => {
  const f = packetBoundary(false, true)
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
})
it.each(['unfinished paragraph', 'shared table baselines'])(
  'keeps outside ink when paragraph evidence has %s',
  (guard) => {
    const f = packetBoundary(false)
    if (guard === 'unfinished paragraph') {
      const index = f.context.content.items.length - 1
      for (const c of [f.context.content, f.context.nativeGlyphContext.content]) {
        c.items[index].str = c.items[index].str.replace(/\.$/, 's')
        c.items[index].sourceItem.text = c.items[index].str
      }
      f.context.nativeGlyphContext.operators.argsArray[index * 5 + 3] = [
        Array.from(f.context.content.items[index].str, (c) => ({
          unicode: c,
          fontChar: c,
          width: 500,
          isInFont: true
        }))
      ]
    } else {
      for (let index = 1; index <= 6; index++) {
        const y = [53, 81, 109][Math.floor((index - 1) / 2)]
        for (const c of [f.context.content, f.context.nativeGlyphContext.content])
          c.items[index].transform[5] = 200 - y
        const item = f.context.content.items[index]
        f.context.nativeGlyphContext.operators.argsArray[index * 5 + 2] = [
          new Float32Array([1, 0, 0, 1, item.transform[4], 200 - y])
        ]
        f.table.cells[index - 1].sourceRects[0] = [
          item.transform[4],
          y - 10,
          item.transform[4] + item.width,
          y
        ]
      }
    }
    expect(refine(f.table, f.rules, f.context)).toBeUndefined()
  }
)

it.each(['multiline', 'multiline-other-font'] as const)(
  'retains a %s stub with numeric rows centered between its lines',
  (kind) => {
    const f = packetBoundary(false, kind)
    expect(refine(f.table, f.rules, f.context)).toBeUndefined()
  }
)

it.each(['different reference', 'below caption', 'within table'])(
  'retains a complete neighboring text packet with %s ambiguity',
  (guard) => {
    const f = packetBoundary(false)
    if (guard === 'within table') {
      for (const c of [f.context.content, f.context.nativeGlyphContext.content]) {
        c.items.splice(-2)
        c.items.at(-1)!.str = 'The paragraph finally ends.'
        c.items.at(-1)!.sourceItem.text = c.items.at(-1)!.str
      }
      f.context.nativeGlyphContext.operators.fnArray.splice(-10)
      f.context.nativeGlyphContext.operators.argsArray.splice(-10)
    }
    for (let index = 7; index < f.context.content.items.length; index++) {
      const shift = guard === 'below caption' ? 14 : 0
      for (const c of [f.context.content, f.context.nativeGlyphContext.content]) {
        c.items[index].transform[5] -= shift
        if (guard === 'different reference')
          c.items[index].str = c.items[index].str.replace('Table 2', 'Table 3')
        c.items[index].sourceItem.text = c.items[index].str
      }
      const item = f.context.content.items[index]
      f.context.nativeGlyphContext.operators.argsArray[index * 5 + 2] = [
        new Float32Array([1, 0, 0, 1, item.transform[4], item.transform[5]])
      ]
      f.context.nativeGlyphContext.operators.argsArray[index * 5 + 3] = [
        Array.from(item.str, (c) => ({ unicode: c, fontChar: c, width: 500, isInFont: true }))
      ]
    }
    expect(refine(f.table, f.rules, f.context)).toBeUndefined()
  }
)

// Full native text packets, with a cropped right lane and independent text on
// both vertical sides. No detector grid repair or invented rule is involved.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function terminalPacketExample(rows = 3) {
  const entries: [string, number, number][] = [
    ['Table 1: Measurements', 50, 37],
    ['Group', 50, 50],
    ['A', 100, 50],
    ['B', 150, 50]
  ]
  for (let row = 1; row < rows; row++)
    entries.push(
      [row === 1 ? 'X' : 'Y', 50, 50 + row * 25],
      ['1.10', 100, 50 + row * 25],
      ['2.20', 150, 50 + row * 25]
    )
  const last = 50 + (rows - 1) * 25
  entries.push(['A separate note.', 50, last + 10])
  const items = entries.map(([str, x, y], index) => ({
      str,
      width: str.length * 5,
      height: 10,
      dir: 'ltr',
      fontName: 'F',
      transform: [10, 0, 0, 10, x, 200 - y],
      sourceItem: { pageNumber: 1, index, text: str }
    })),
    content = { items, styles: { F: { ascent: 0.9, descent: -0.2, vertical: false } } },
    viewport = {
      width: 300,
      height: 200,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 200],
      convertToViewportPoint: (x: number, y: number) => [x, 200 - y]
    },
    operators = { fnArray: [] as number[], argsArray: [] as unknown[] }
  for (const item of items) {
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      ['F', 10],
      [new Float32Array([1, 0, 0, 1, item.transform[4], item.transform[5]])],
      [Array.from(item.str, (c) => ({ unicode: c, fontChar: c, width: 500, isInFont: true }))],
      null
    )
  }
  const tokens = items.map((item) => ({
      text: item.str,
      sourceItem: item.sourceItem,
      rect: [
        item.transform[4],
        200 - item.transform[5] - 10,
        item.transform[4] + item.width,
        200 - item.transform[5]
      ],
      height: 10,
      baseline: 200 - item.transform[5],
      horizontal: true
    })),
    cells = tokens.slice(1, -1).map((t, n) => ({
      row: Math.floor(n / 3),
      column: n % 3,
      rowSpan: 1,
      colSpan: 1,
      text: t.text,
      sourceItems: [t.sourceItem],
      sourceRects: [t.rect],
      sourceSegments: [] as unknown[]
    })),
    table = {
      page: 1,
      cropRect: [45, 35, 155, last + 5],
      grid: Array.from({ length: rows }, (_, row) =>
        cells.slice(row * 3, row * 3 + 3).map((c) => c.text)
      ),
      cells,
      clipped: [tokens[6], tokens.at(-2)!, tokens.at(-1)!].map((t) => ({
        text: t.text,
        rect: t.rect
      })),
      unassigned: ['A separate note.'],
      issues: ['native-table-structure-ambiguous', 'text-crosses-crop-boundary'],
      reviewCandidate: false,
      sourceViewport: { width: 300, height: 200, scale: 1 }
    },
    context = {
      sourceContent: content,
      content,
      viewport,
      operators,
      rulePaintBounds: new Map(),
      nativeEvidenceGraphics: [] as { kind: string; rect: number[] }[],
      nativePaintIdentityGraphics: [],
      nativeGlyphContext: {
        content: structuredClone(content),
        viewport,
        operators,
        graphicsBounds: [],
        glyphBounds: [
          {
            fontName: 'F',
            glyphs: [...new Set(items.flatMap((i) => Array.from(i.str)))].map((c) => ({
              fontChar: c,
              bounds: c === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7]
            }))
          }
        ]
      }
    }
  return { table, tokens, context, rules: [] as number[][] }
}
it('completes a terminal lane using whole native glyph packets while preserving all table metadata', () => {
  const f = terminalPacketExample(),
    before = structuredClone(f.table)
  const result = refineVisual(f.table, f.tokens, f.rules, f.context)
  expect(result).toEqual({
    ...before,
    cropRect: [45, 43, 170, 100],
    cropRects: [[45, 43, 170, 100]]
  })
  expect(f.table).toEqual(before)
})
it('uses renderer outlines rather than inventing ink from zero ascent metrics', () => {
  const f = terminalPacketExample()
  for (const styles of [
    f.context.sourceContent.styles,
    f.context.nativeGlyphContext.content.styles
  ])
    styles.F.ascent = styles.F.descent = 0
  expect(refineVisual(f.table, f.tokens, f.rules, f.context)?.cropRect).toEqual([45, 43, 170, 100])
})
const terminalPacketNegatives: [string, (f: ReturnType<typeof terminalPacketExample>) => void][] = [
  [
    'unbound source viewport',
    (f) => {
      f.table.sourceViewport.scale = 2
    }
  ],
  [
    'missing outline',
    (f) => {
      f.context.nativeGlyphContext.glyphBounds[0].glyphs = []
    }
  ],
  [
    'incomplete native packet',
    (f) => {
      f.context.nativeGlyphContext.operators.fnArray.pop()
    }
  ],
  [
    'unclaimed source ordinal between complete body packets',
    (f) => {
      const item = {
        str: 'Z',
        width: 5,
        height: 10,
        dir: 'ltr',
        fontName: 'F',
        transform: [10, 0, 0, 10, 250, 50],
        sourceItem: { pageNumber: 1, index: 5, text: 'Z' }
      }
      for (const content of [f.context.sourceContent, f.context.nativeGlyphContext.content]) {
        content.items.splice(5, 0, structuredClone(item))
        content.items.forEach((i, index) => {
          i.sourceItem.index = index
        })
      }
      f.context.nativeGlyphContext.operators.fnArray.splice(
        25,
        0,
        OPS.beginText,
        OPS.setFont,
        OPS.setTextMatrix,
        OPS.showText,
        OPS.endText
      )
      f.context.nativeGlyphContext.operators.argsArray.splice(
        25,
        0,
        null,
        ['F', 10],
        [new Float32Array([1, 0, 0, 1, 250, 50])],
        [[{ unicode: 'Z', fontChar: 'Z', width: 500, isInFont: true }]],
        null
      )
      f.context.nativeGlyphContext.glyphBounds[0].glyphs.push({
        fontChar: 'Z',
        bounds: [0, 0, 0.5, 0.7]
      })
    }
  ],
  [
    'duplicate source owner',
    (f) => {
      f.table.cells[1].sourceItems.push(f.table.cells[0].sourceItems[0])
      f.table.cells[1].sourceRects.push(f.table.cells[0].sourceRects[0])
    }
  ],
  [
    'segmented owner',
    (f) => {
      f.table.cells[0].sourceSegments.push({ index: 1 })
    }
  ],
  [
    'malformed source segment carrier',
    (f) => {
      Object.assign(f.table.cells[0], { sourceSegments: { unknown: true } })
    }
  ],
  [
    'unknown paint',
    (f) => {
      f.context.nativeGlyphContext.operators.fnArray.push(OPS.fill)
      f.context.nativeGlyphContext.operators.argsArray.push(null)
    }
  ],
  [
    'mixed graphics',
    (f) => {
      f.context.nativeEvidenceGraphics.push({ kind: 'path', rect: [50, 40, 60, 45] })
    }
  ],
  [
    'foreign visible glyph inside the proposed crop',
    (f) => {
      const index = f.context.sourceContent.items.length - 1
      for (const content of [f.context.sourceContent, f.context.nativeGlyphContext.content])
        content.items[index].transform[5] = 101
      f.context.nativeGlyphContext.operators.argsArray[index * 5 + 2] = [
        new Float32Array([1, 0, 0, 1, 50, 101])
      ]
    }
  ],
  [
    'owned glyph crossing the retained left edge',
    (f) => {
      f.context.nativeGlyphContext.glyphBounds[0].glyphs.find(
        (g) => g.fontChar === 'X'
      )!.bounds[0] = -0.6
    }
  ],
  [
    'zero metrics without outlines',
    (f) => {
      for (const styles of [
        f.context.sourceContent.styles,
        f.context.nativeGlyphContext.content.styles
      ])
        styles.F.ascent = styles.F.descent = 0
      f.context.nativeGlyphContext.glyphBounds[0].glyphs = []
    }
  ],
  [
    'zero native font size',
    (f) => {
      for (const content of [f.context.sourceContent, f.context.nativeGlyphContext.content]) {
        content.items[1].height = 0
        content.items[1].transform[0] = 0
        content.items[1].transform[3] = 0
      }
    }
  ],
  [
    'foreign glyph entering only the rounded pixel strip',
    (f) => {
      for (const glyph of f.context.nativeGlyphContext.glyphBounds[0].glyphs)
        if (glyph.fontChar !== ' ') glyph.bounds[3] = 0.625
      for (const content of [f.context.sourceContent, f.context.nativeGlyphContext.content])
        content.items[0].transform[5] = 156.5
      f.context.nativeGlyphContext.operators.argsArray[2] = [
        new Float32Array([1, 0, 0, 1, 50, 156.5])
      ]
    }
  ],
  [
    'invalid corroborating token metrics',
    (f) => {
      const cell = f.table.cells[0]
      Object.assign(cell, {
        sourceTokens: [{ text: cell.text, rect: cell.sourceRects[0], baseline: NaN, height: 10 }]
      })
    }
  ],
  [
    'unknown corroborating source carrier',
    (f) => {
      const cell = f.table.cells[0]
      Object.assign(cell, {
        sourceTokens: [
          {
            text: cell.text,
            rect: cell.sourceRects[0],
            baseline: 50,
            height: 10,
            sourceItem: { pageNumber: 1, index: 999, text: cell.text }
          }
        ]
      })
    }
  ]
]
it.each(terminalPacketNegatives)('rejects terminal glyph crop with %s', (_name, mutate) => {
  const f = terminalPacketExample()
  mutate(f)
  const before = structuredClone(f.table)
  expect(refineVisual(f.table, f.tokens, f.rules, f.context)).toBeUndefined()
  expect(f.table).toEqual(before)
})
it('rejects a terminal glyph crop without at least three independently repeated native rows', () => {
  const f = terminalPacketExample(2)
  expect(refineVisual(f.table, f.tokens, f.rules, f.context)).toBeUndefined()
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function graphicalTableExample() {
  const entries: [string, number, number][] = [
      ['Kind', 20, 50],
      ['Value', 80, 50],
      ['Plot', 140, 50],
      ['A', 20, 75],
      ['1', 80, 75],
      ['B', 20, 100],
      ['2', 80, 100]
    ],
    items = entries.map(([str, x, y], index) => ({
      str,
      width: str.length * 5,
      height: 10,
      dir: 'ltr',
      fontName: 'F',
      transform: [10, 0, 0, 10, x, 150 - y],
      sourceItem: { pageNumber: 1, index, text: str }
    })),
    content = { items, styles: { F: { ascent: 0.9, descent: -0.2, vertical: false } } },
    viewport = {
      width: 220,
      height: 150,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 150],
      convertToViewportPoint: (x, y) => [x, 150 - y]
    },
    operators = { fnArray: [] as number[], argsArray: [] as unknown[][] },
    graphics = [] as { kind: string; operationIndex: number; rect: number[] }[],
    rules = [] as number[][],
    rulePaintBounds = new Map()
  for (const i of items) {
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      ['F', 10],
      [new Float32Array([1, 0, 0, 1, i.transform[4], i.transform[5]])],
      [Array.from(i.str, (c) => ({ unicode: c, fontChar: c, width: 500, isInFont: true }))],
      null
    )
  }
  operators.fnArray.push(OPS.setLineWidth, OPS.setLineCap)
  operators.argsArray.push([0.5], [0])
  const add = (points: number[][]): number[] => {
    const sequence = points.flatMap(([x, y], i) => [i ? 1 : 0, x, 150 - y]),
      bounds = [
        Math.min(...points.map((p) => p[0])) - 0.25,
        Math.min(...points.map((p) => p[1])) - 0.25,
        Math.max(...points.map((p) => p[0])) + 0.25,
        Math.max(...points.map((p) => p[1])) + 0.25
      ],
      operationIndex = operators.fnArray.length
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push([
      OPS.stroke,
      [new Float32Array(sequence)],
      new Float32Array([
        bounds[0] + 0.25,
        150 - bounds[3] + 0.25,
        bounds[2] - 0.25,
        150 - bounds[1] - 0.25
      ])
    ])
    graphics.push({ kind: 'path', operationIndex, rect: bounds })
    return bounds
  }
  for (const y of [35, 55, 80, 105]) {
    const r = [10, y, 195, y]
    rules.push(r)
    rulePaintBounds.set(
      r.join(','),
      add([
        [10, y],
        [195, y]
      ])
    )
  }
  for (const x of [65, 125]) {
    const r = [x, 35, x, 105]
    rules.push(r)
    rulePaintBounds.set(
      r.join(','),
      add([
        [x, 35],
        [x, 105]
      ])
    )
  }
  const polygons = [
    [
      [135, 60],
      [185, 75],
      [135, 75],
      [135, 60]
    ],
    [
      [135, 85],
      [185, 100],
      [135, 100],
      [135, 85]
    ]
  ]
  for (const p of polygons) add(p)
  const rect = (i: (typeof items)[number]): number[] => [
      i.transform[4],
      150 - i.transform[5] - 10,
      i.transform[4] + i.width,
      150 - i.transform[5]
    ],
    tokens = items.map((i) => ({
      text: i.str,
      rect: rect(i),
      sourceItem: i.sourceItem,
      height: 10,
      baseline: 150 - i.transform[5],
      horizontal: true,
      fontAscent: 0.9,
      fontDescent: -0.2
    })),
    grid = [
      ['Kind', 'Value', 'Plot'],
      ['A', '1', ''],
      ['B', '2', '']
    ],
    cells = grid.flatMap((r, row) =>
      r.map((text, column) => {
        const token = tokens.find((t) => t.text === text)
        return {
          row,
          column,
          rowSpan: 1,
          colSpan: 1,
          text,
          sourceItems: token ? [token.sourceItem] : [],
          sourceRects: token ? [token.rect] : []
        }
      })
    ),
    table = {
      id: 'native-table',
      page: 1,
      cropRect: [5, 30, 160, 110],
      grid,
      cells,
      clipped: [],
      unassigned: [],
      issues: ['native-table-structure-ambiguous'],
      reviewCandidate: false,
      sourceViewport: { width: 220, height: 150, scale: 1 }
    },
    context = {
      sourceContent: content,
      content,
      viewport,
      operators,
      rulePaintBounds,
      nativeEvidenceGraphics: graphics.map(({ kind, rect }) => ({ kind, rect })),
      nativePaintIdentityGraphics: graphics,
      nativeGlyphContext: {
        content: structuredClone(content),
        viewport,
        operators,
        graphicsBounds: graphics.map(({ kind, operationIndex, rect }) => ({
          kind,
          operationIndex,
          normalizedRect: rect.map((v, i) => v / (i % 2 ? 150 : 220))
        })),
        glyphBounds: [
          {
            fontName: 'F',
            glyphs: [...new Set(items.flatMap((i) => Array.from(i.str)))].map((c) => ({
              fontChar: c,
              bounds: c === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7]
            }))
          }
        ]
      }
    }
  return { table, tokens, rules, context, polygons, graphics }
}

const {
  proveNativeGraphicalTableCrop: proveGraphicalCrop,
  validateNativeGraphicalTableCropPng: validateGraphicalPng
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-graphical-table-crop.mjs')).href
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function graphicalScope(f: ReturnType<typeof JSON.parse>) {
  return {
    page: {
      pageNumber: 1,
      width: 220,
      height: 150,
      invalidGraphicsBounds: 0,
      graphicsBounds: f.context.nativeGlyphContext.graphicsBounds
    },
    context: f.context,
    competingRects: [] as number[][],
    captions: [] as { rect: number[] }[]
  }
}
it('completes the native graphical terminal column without changing table sources or reliability', () => {
  const f = graphicalTableExample(),
    before = structuredClone(f.table),
    result = proveGraphicalCrop(f.table, graphicalScope(f))
  expect(result?.nativeCrop).toEqual([5, 30, 195, 110])
  expect(result?.cropRect).toEqual([5, 30, 195, 110])
  expect(f.table).toEqual(before)
})

it('uses exact outlines with zero font metrics and restored opaque paint', () => {
  const f: ReturnType<typeof JSON.parse> = graphicalTableExample()
  for (const content of [f.context.sourceContent, f.context.nativeGlyphContext.content]) {
    content.styles.F.ascent = 0
    content.styles.F.descent = 0
  }
  prependGraphicalState(f, OPS.restore, [])
  prependGraphicalState(f, OPS.setFillRGBColor, ['#ffffff'])
  prependGraphicalState(f, OPS.save, [])
  expect(proveGraphicalCrop(f.table, graphicalScope(f))?.nativeCrop).toEqual([5, 30, 195, 110])
})

function prependGraphicalState(
  f: ReturnType<typeof JSON.parse>,
  op: number,
  args: unknown[]
): void {
  f.context.operators.fnArray.unshift(op)
  f.context.operators.argsArray.unshift(args)
  for (const graphic of f.graphics) graphic.operationIndex++
  for (const graphic of f.context.nativeGlyphContext.graphicsBounds) graphic.operationIndex++
}
function addGraphicalStroke(f: ReturnType<typeof JSON.parse>, points: number[][]): void {
  const operationIndex = f.context.operators.fnArray.length,
    rect = [
      Math.min(...points.map((p) => p[0])) - 0.25,
      Math.min(...points.map((p) => p[1])) - 0.25,
      Math.max(...points.map((p) => p[0])) + 0.25,
      Math.max(...points.map((p) => p[1])) + 0.25
    ]
  f.context.operators.fnArray.push(OPS.constructPath)
  f.context.operators.argsArray.push([
    OPS.stroke,
    [new Float32Array(points.flatMap(([x, y], i) => [i ? 1 : 0, x, 150 - y]))],
    new Float32Array([rect[0] + 0.25, 150 - rect[3] + 0.25, rect[2] - 0.25, 150 - rect[1] - 0.25])
  ])
  f.graphics.push({ kind: 'path', operationIndex, rect })
  f.context.nativeEvidenceGraphics.push({ kind: 'path', rect })
  f.context.nativeGlyphContext.graphicsBounds.push({
    kind: 'path',
    operationIndex,
    normalizedRect: rect.map((n, i) => n / (i % 2 ? 150 : 220))
  })
}

it.each([
  'outline',
  'empty-letter',
  'packet',
  'source-id',
  'source-rect',
  'duplicate-source',
  'span',
  'segment',
  'filled-graphical-cell',
  'missing-row-paint',
  'line-cap',
  'translucent-text',
  'white-text',
  'white-rules',
  'foreign-body-paint',
  'invalid-graphics',
  'caption',
  'competing-object'
])('requires complete native graphical crop evidence: %s', (guard) => {
  const f: ReturnType<typeof JSON.parse> = graphicalTableExample()
  if (guard === 'outline') f.context.nativeGlyphContext.glyphBounds[0].glyphs.pop()
  if (guard === 'empty-letter')
    f.context.nativeGlyphContext.glyphBounds[0].glyphs.find(
      (g: { fontChar: string }) => g.fontChar === 'A'
    ).bounds = [0, 0, 0, 0]
  if (guard === 'packet') f.context.operators.fnArray[3] = OPS.dependency
  if (guard === 'source-id') f.context.sourceContent.items[0].sourceItem.index++
  if (guard === 'source-rect') f.table.cells[0].sourceRects[0][2]++
  if (guard === 'duplicate-source') {
    f.table.cells[1].sourceItems = structuredClone(f.table.cells[0].sourceItems)
    f.table.cells[1].sourceRects = structuredClone(f.table.cells[0].sourceRects)
  }
  if (guard === 'span') f.table.cells[0].colSpan = 2
  if (guard === 'segment') f.table.cells[0].sourceSegments = [{ index: 0 }]
  if (guard === 'filled-graphical-cell') {
    f.table.cells[5].text = 'Unproved'
    f.table.grid[1][2] = 'Unproved'
  }
  if (guard === 'missing-row-paint') {
    f.context.operators.fnArray.pop()
    f.context.operators.argsArray.pop()
    f.graphics.pop()
    f.context.nativeEvidenceGraphics.pop()
    f.context.nativeGlyphContext.graphicsBounds.pop()
  }
  if (guard === 'line-cap')
    f.context.operators.argsArray[f.context.operators.fnArray.indexOf(OPS.setLineCap)] = [1]
  if (guard === 'translucent-text') prependGraphicalState(f, OPS.setGState, [[['ca', 0.5]]])
  if (guard === 'white-text') prependGraphicalState(f, OPS.setFillRGBColor, ['#ffffff'])
  if (guard === 'white-rules') prependGraphicalState(f, OPS.setStrokeRGBColor, ['#ffffff'])
  if (guard === 'foreign-body-paint')
    addGraphicalStroke(f, [
      [20, 60],
      [30, 75]
    ])
  const scope = graphicalScope(f)
  if (guard === 'invalid-graphics') scope.page.invalidGraphicsBounds = 1
  if (guard === 'caption') scope.captions = [{ rect: [170, 60, 190, 70] }]
  if (guard === 'competing-object') scope.competingRects = [[170, 60, 190, 70]]
  expect(proveGraphicalCrop(f.table, scope)).toBeUndefined()
})

it('checks exterior native paint against the actual PNG footprint, including reduced rasters', async () => {
  const { createCanvas } = await import('@napi-rs/canvas'),
    f: ReturnType<typeof JSON.parse> = graphicalTableExample(),
    full = createCanvas(760, 320).toBuffer('image/png'),
    reduced = createCanvas(152, 64).toBuffer('image/png')
  let proof = proveGraphicalCrop(f.table, graphicalScope(f))
  expect(proof).toBeDefined()
  expect(validateGraphicalPng(full, proof)).toBe(true)
  expect(validateGraphicalPng(reduced, proof)).toBe(true)
  addGraphicalStroke(f, [
    [195.3, 60],
    [195.3, 75]
  ])
  proof = proveGraphicalCrop(f.table, graphicalScope(f))
  expect(proof?.foreignPaints).toHaveLength(1)
  expect(validateGraphicalPng(full, proof)).toBe(false)
  expect(validateGraphicalPng(reduced, proof)).toBe(false)
  expect(validateGraphicalPng(full.subarray(0, 20), proof)).toBe(false)
  expect(validateGraphicalPng(full, undefined)).toBe(false)
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function verticalBodyExample(rows = 3) {
  const f = terminalPacketExample(rows)
  f.table.cropRect[2] = 180
  return {
    ...f,
    scope: {
      page: {
        pageNumber: 1,
        width: 300,
        height: 200,
        renderRotation: 0,
        invalidGraphicsBounds: 0,
        graphicsBounds: [] as unknown[]
      },
      competingRects: [] as number[][],
      captions: [] as { rect: number[] }[]
    }
  }
}

it('removes exterior caption and note ink only after a complete vertical body proof', () => {
  const f = verticalBodyExample(),
    before = structuredClone(f.table),
    proof = proveBodyCrop(f.table, f.rules, f.context, f.scope)
  expect(proof?.cropRect).toEqual([45, 43, 180, 100])
  expect(proof?.nativeCrop).toEqual([45, 43, 180, 100])
  expect(proof?.foreignGlyphs.length).toBeGreaterThan(0)
  expect(f.table).toEqual(before)
  // The existing terminal path does not acquire a new admission condition.
  expect(refineVisual(f.table, f.tokens, f.rules, f.context)).toBeUndefined()
})

it.each(terminalPacketNegatives)(
  'requires the same complete vertical body evidence: %s',
  (_name, mutate) => {
    const f = verticalBodyExample()
    mutate(f)
    expect(proveBodyCrop(f.table, f.rules, f.context, f.scope)).toBeUndefined()
  }
)

it.each([
  'empty-letter',
  'painted-space',
  'white-fill',
  'faded-text',
  'stroke-text',
  'unknown-spacing',
  'invalid-page-graphics',
  'renderer-rotation',
  'missing-page-paint',
  'explicit-note',
  'foreign-caption',
  'competing-object',
  'missing-competition',
  'missing-captions',
  'existing-regions',
  'horizontal-expansion',
  'too-few-rows'
])('rejects optional vertical body crop with %s', (guard) => {
  const f: ReturnType<typeof JSON.parse> = verticalBodyExample(guard === 'too-few-rows' ? 2 : 3)
  if (guard === 'empty-letter' || guard === 'painted-space')
    f.context.nativeGlyphContext.glyphBounds[0].glyphs.find(
      (g: { fontChar: string }) => g.fontChar === (guard === 'empty-letter' ? 'G' : ' ')
    ).bounds = guard === 'empty-letter' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7]
  const state =
    guard === 'white-fill'
      ? [OPS.setFillRGBColor, ['#ffffff']]
      : guard === 'faded-text'
        ? [OPS.setGState, [[['ca', 0.5]]]]
        : guard === 'stroke-text'
          ? [OPS.setTextRenderingMode, [1]]
          : guard === 'unknown-spacing'
            ? [OPS.setCharSpacing, [0]]
            : undefined
  if (state) {
    f.context.nativeGlyphContext.operators.fnArray.unshift(state[0])
    f.context.nativeGlyphContext.operators.argsArray.unshift(state[1])
  }
  if (guard === 'invalid-page-graphics') f.scope.page.invalidGraphicsBounds = 1
  if (guard === 'renderer-rotation') f.scope.page.renderRotation = 90
  if (guard === 'missing-page-paint') f.scope.page.graphicsBounds.push({ kind: 'path' })
  if (guard === 'explicit-note') f.table.notes = [{ text: 'A separate note.' }]
  if (guard === 'foreign-caption') f.scope.captions = [{ rect: [50, 50, 60, 60] }]
  if (guard === 'competing-object') f.scope.competingRects = [[50, 50, 60, 60]]
  if (guard === 'missing-competition') delete f.scope.competingRects
  if (guard === 'missing-captions') delete f.scope.captions
  if (guard === 'existing-regions') f.table.cropRects = [f.table.cropRect]
  if (guard === 'horizontal-expansion') f.table.cropRect[2] = 155
  expect(proveBodyCrop(f.table, f.rules, f.context, f.scope)).toBeUndefined()
})

it('validates the actual vertical crop raster and abstains when a retry reaches exterior note ink', async () => {
  const { createCanvas } = await import('@napi-rs/canvas'),
    f = verticalBodyExample(),
    before = structuredClone(f.table)
  for (const styles of [
    f.context.sourceContent.styles,
    f.context.nativeGlyphContext.content.styles
  ])
    styles.F.ascent = styles.F.descent = 0
  const proof = proveBodyCrop(f.table, f.rules, f.context, f.scope),
    full = createCanvas(540, 228).toBuffer('image/png'),
    reduced = createCanvas(270, 114).toBuffer('image/png'),
    low = createCanvas(68, 29).toBuffer('image/png')
  expect(proof).toBeDefined()
  expect(validateBodyPng(full, proof)).toBe(true)
  expect(validateBodyPng(reduced, proof)).toBe(true)
  expect(validateBodyPng(low, proof)).toBe(false)
  expect(validateBodyPng(full.subarray(0, 20), proof)).toBe(false)
  expect(validateBodyPng(full, undefined)).toBe(false)
  expect(f.table).toEqual(before)
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function repeatedMissingStubs() {
  type Any = ReturnType<typeof JSON.parse>
  const entries: [string, number, number, number?, number?][] = [
    ['Table 1. Results.', 50, 15],
    ['Count', 160, 50],
    ['Rate', 230, 50],
    ['Group A', 50, 80],
    ['Alpha', 110, 80],
    ['1', 160, 80],
    ['2', 230, 80],
    ['Beta', 110, 100],
    ['3', 160, 100],
    ['4', 230, 100],
    ['Group B', 50, 120],
    ['Alpha', 110, 120],
    ['5', 160, 120],
    ['6', 230, 120],
    ['Beta', 110, 140],
    ['7', 160, 140],
    ['8', 230, 140],
    ['A separate explanation.', 40, 164]
  ]
  const items = entries.map(([str, x, y, height = 10], index) => ({
    str,
    dir: 'ltr',
    width: str.length * 5,
    height,
    fontName: 'F',
    transform: [height, 0, 0, height, x, 200 - y],
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  const box = (i: number): number[] => [
    items[i].transform[4],
    200 - items[i].transform[5] - items[i].height,
    items[i].transform[4] + items[i].width,
    200 - items[i].transform[5]
  ]
  const content = { items, styles: { F: { ascent: 0.8, descent: -0.2, vertical: false } } },
    viewport = { width: 300, height: 200, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 200] },
    operators = { fnArray: [] as number[], argsArray: [] as Any[] },
    rules = [30, 60, 108, 150].map((y) => [40, y, 280, y]),
    rulePaintBounds = new Map(
      rules.map((r) => [r.join(','), [r[0], r[1] - 0.2, r[2], r[3] + 0.2]])
    ),
    graphics: Any[] = []
  for (const item of items) {
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      ['F', item.height],
      [new Float32Array([1, 0, 0, 1, item.transform[4], item.transform[5]])],
      [Array.from(item.str, (c) => ({ unicode: c, fontChar: c, width: 500, isInFont: true }))],
      null
    )
  }
  operators.fnArray.push(OPS.setStrokeRGBColor, OPS.setLineWidth, OPS.setLineCap)
  operators.argsArray.push(['#000000'], [0.4], [0])
  for (const r of rules) {
    const operationIndex = operators.fnArray.length,
      rect = rulePaintBounds.get(r.join(','))!
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push([
      OPS.stroke,
      [[0, r[0], 200 - r[1], 1, r[2], 200 - r[3]]],
      [r[0], 200 - r[1], r[2], 200 - r[3]]
    ])
    graphics.push({ kind: 'path', operationIndex, rect })
  }
  const cells: Any[] = [
      { row: 0, column: 0, rowSpan: 1, colSpan: 1, text: '', sourceItems: [], sourceRects: [] }
    ],
    grid = [['', 'Count', 'Rate']]
  const rowIndices = [
    [1, 2],
    [4, 5, 6],
    [7, 8, 9],
    [11, 12, 13],
    [14, 15, 16]
  ]
  for (const [row, indices] of rowIndices.entries())
    for (const [n, index] of indices.entries()) {
      const column = row === 0 ? n + 1 : n
      grid[row] ??= []
      grid[row][column] = items[index].str
      cells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: items[index].str,
        sourceItems: [items[index].sourceItem],
        sourceRects: [box(index)]
      })
    }
  const context: Any = {
    content,
    sourceContent: content,
    viewport,
    operators,
    rulePaintBounds,
    nativeEvidenceGraphics: graphics.map((g) => ({ kind: g.kind, rect: g.rect })),
    nativePaintIdentityGraphics: graphics,
    nativeGlyphContext: {
      content: structuredClone(content),
      viewport,
      operators,
      graphicsBounds: [],
      glyphBounds: [
        {
          fontName: 'F',
          glyphs: [...new Set(items.flatMap((i) => Array.from(i.str)))].map((c) => ({
            fontChar: c,
            bounds: c === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7]
          }))
        }
      ]
    }
  }
  const table: Any = {
    page: 1,
    cropRect: [75, 25, 290, 155],
    grid,
    cells,
    issues: ['text-crosses-crop-boundary'],
    clipped: [3, 10, 17].map((i) => ({ text: items[i].str, rect: box(i) })),
    caption: { page: 1, text: items[0].str, rect: box(0) },
    reviewCandidate: true
  }
  return { table, context, rules }
}

it('restores repeated missing stub groups through the native closing stroke and keeps the grid unreliable', () => {
  const f = repeatedMissingStubs(),
    before = structuredClone(f.table),
    next = refine(f.table, f.rules, f.context)
  expect(next?.cropRect).toEqual([40, 25, 290, 150.2])
  expect(next?.issues).toContain('native-table-structure-ambiguous')
  expect(next?.reviewCandidate).toBe(false)
  expect(next?.cells).toBe(f.table.cells)
  expect(f.table).toEqual(before)
})

it.each(['missing group rule', 'foreign strip paint', 'missing glyph program'])(
  'does not own missing native stubs without complete boundary evidence: %s',
  (mode) => {
    const f = repeatedMissingStubs()
    if (mode === 'missing group rule') f.rules.splice(2, 1)
    if (mode === 'foreign strip paint')
      f.context.nativeEvidenceGraphics.push({ kind: 'path', rect: [60, 85, 70, 90] })
    if (mode === 'missing glyph program') f.context.nativeGlyphContext.glyphBounds = []
    expect(refine(f.table, f.rules, f.context)?.issues ?? []).not.toContain(
      'native-table-structure-ambiguous'
    )
  }
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function omittedGroupedHeader() {
  const entries: [string, number, number][] = [
    ['Table 1: A measured comparison.', 10, 20],
    ['Kind', 20, 40],
    ['Left', 85, 40],
    ['Right', 165, 40],
    ['Count', 65, 60],
    ['Rate', 105, 60],
    ['Count', 145, 60],
    ['Rate', 185, 60],
    ['Alpha', 20, 80],
    ['1', 65, 80],
    ['2', 105, 80],
    ['3', 145, 80],
    ['4', 185, 80],
    ['Beta', 20, 100],
    ['5', 65, 100],
    ['6', 105, 100],
    ['7', 145, 100],
    ['8', 185, 100]
  ]
  const items = entries.map(([str, x, y], index) => ({
      str,
      dir: 'ltr',
      width: str.length * 5,
      height: 10,
      fontName: 'F',
      transform: [10, 0, 0, 10, x, 130 - y],
      sourceItem: { pageNumber: 1, index, text: str }
    })),
    box = (i: number): number[] => [
      items[i].transform[4],
      120 - items[i].transform[5],
      items[i].transform[4] + items[i].width,
      130 - items[i].transform[5]
    ],
    content = { items, styles: { F: { ascent: 0.8, descent: -0.2, vertical: false } } },
    viewport = { width: 220, height: 130, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 130] },
    operators = { fnArray: [] as number[], argsArray: [] as Any[] },
    rules = [65, 105].map((y) => [10, y, 210, y]),
    rulePaintBounds = new Map(
      rules.map((r) => [r.join(','), [r[0], r[1] - 0.2, r[2], r[3] + 0.2]])
    ),
    graphics: Any[] = []
  for (const item of items) {
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      ['F', 10],
      [new Float32Array([1, 0, 0, 1, item.transform[4], item.transform[5]])],
      [Array.from(item.str, (c) => ({ unicode: c, fontChar: c, width: 500, isInFont: true }))],
      null
    )
  }
  operators.fnArray.push(OPS.setStrokeRGBColor, OPS.setLineWidth, OPS.setLineCap)
  operators.argsArray.push(['#000000'], [0.4], [0])
  for (const r of rules) {
    const operationIndex = operators.fnArray.length,
      rect = rulePaintBounds.get(r.join(','))!
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push([
      OPS.stroke,
      [[0, r[0], 130 - r[1], 1, r[2], 130 - r[3]]],
      [r[0], 130 - r[1], r[2], 130 - r[3]]
    ])
    graphics.push({ kind: 'path', operationIndex, rect })
  }
  const edges = [10, 50, 95, 130, 175, 210],
    cells: Any[] = [],
    grid = [
      ['', 'Count', 'Rate', 'Count', 'Rate'],
      ['Alpha', '1', '2', '3', '4'],
      ['Beta', '5', '6', '7', '8']
    ]
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < 5; column++) {
      const index = row === 0 ? (column === 0 ? undefined : column + 3) : 8 + (row - 1) * 5 + column
      cells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: grid[row][column],
        rect: [edges[column], 50 + row * 20, edges[column + 1], 60 + row * 20],
        sourceItems: index === undefined ? [] : [items[index].sourceItem],
        sourceRects: index === undefined ? [] : [box(index)]
      })
    }
  const context: Any = {
    content,
    sourceContent: content,
    viewport,
    operators,
    captions: [{ page: 1, lines: [items[0].str], rect: box(0) }],
    rulePaintBounds,
    nativeEvidenceGraphics: graphics.map((g) => ({ kind: g.kind, rect: g.rect })),
    nativePaintIdentityGraphics: graphics,
    nativeGlyphContext: {
      content: structuredClone(content),
      viewport,
      operators,
      graphicsBounds: [],
      glyphBounds: [
        {
          fontName: 'F',
          glyphs: [...new Set(items.flatMap((i) => Array.from(i.str)))].map((c) => ({
            fontChar: c,
            bounds: c === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7]
          }))
        }
      ]
    }
  }
  return {
    table: {
      page: 1,
      cropRect: [10, 50, 210, 110],
      grid,
      cells,
      issues: [],
      reviewCandidate: true,
      caption: { page: 1, text: items[0].str, rect: box(0) }
    } as Any,
    context,
    rules
  }
}

it('keeps a table image and native cells while pausing mappings that omit a complete grouped header', () => {
  const f = omittedGroupedHeader(),
    before = structuredClone(f.table),
    next = refine(f.table, f.rules, f.context)
  expect(next?.issues).toContain('native-table-structure-ambiguous')
  expect(next?.reviewCandidate).toBe(false)
  expect(next?.cropRect).toBe(f.table.cropRect)
  expect(next?.cells).toBe(f.table.cells)
  expect(f.table).toEqual(before)
})

it.each(['broken repeated headers', 'unclosed native interval', 'missing native glyphs'])(
  'does not reject grouped headers without their independent native proof: %s',
  (fault) => {
    const f = omittedGroupedHeader()
    if (fault === 'broken repeated headers') f.table.cells[4].text = 'Other'
    if (fault === 'unclosed native interval') {
      f.table.cells[8].sourceItems = []
      f.table.cells[8].sourceRects = []
    }
    if (fault === 'missing native glyphs') f.context.nativeGlyphContext.glyphBounds = []
    expect(refine(f.table, f.rules, f.context)?.issues ?? []).not.toContain(
      'native-table-structure-ambiguous'
    )
  }
)

// Anonymous three-source, three-rail geometry; no external paper data.
function bottomStripExample(): ReturnType<typeof JSON.parse> {
  type Evidence = ReturnType<typeof JSON.parse>
  const texts: [string, number, number, number][] = [
      ['Table 1: Example', 10, 100, 80],
      ['s', 10, 62, 0],
      ['i', 10, 34, 5]
    ],
    items = texts.map(([str, x, y, width], index) => ({
      str,
      dir: 'ltr',
      width,
      height: 10,
      fontName: 'F',
      transform: [10, 0, 0, 10, x, y],
      hasEOL: false,
      sourceItem: { pageNumber: 1, index, text: str }
    })),
    content = { styles: { F: { ascent: 0.8, descent: -0.3, vertical: false } }, items },
    operators: Evidence = { fnArray: [], argsArray: [] },
    add = (op: number, args: unknown[]): number => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
      return operators.fnArray.length - 1
    },
    graphics: Evidence[] = []
  add(OPS.setLineWidth, [1])
  add(OPS.setStrokeRGBColor, ['#000000'])
  for (const y of [30, 50, 90]) {
    const index = add(OPS.constructPath, [
      OPS.stroke,
      [Float32Array.from([0, 1, 120 - y, 1, 99, 120 - y])],
      [1, 120 - y, 99, 120 - y]
    ])
    graphics.push({
      kind: 'path',
      operationIndex: index,
      normalizedRect: [0.01, (y - 0.5) / 120, 0.99, (y + 0.5) / 120]
    })
  }
  for (const item of items) {
    add(OPS.beginText, [])
    add(OPS.setFont, ['F', 10])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, item.transform[4], item.transform[5]]])
    add(OPS.showText, [
      Array.from(item.str).map((c) => ({
        unicode: c,
        fontChar: c,
        width: 500,
        isInFont: true,
        isSpace: c === ' '
      }))
    ])
    add(OPS.endText, [])
  }
  const glyphs = [...new Set(items.flatMap((i) => Array.from(i.str)))].map((c) => ({
      fontChar: c,
      bounds: c === ' ' ? [0, 0, 0, 0] : [0, -0.3, 0.5, 0.8]
    })),
    viewport = {
      width: 100,
      height: 120,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 120],
      convertToViewportPoint: (x, y) => [x, 120 - y]
    },
    nativeGlyphContext = {
      content: structuredClone(content),
      operators,
      viewport,
      glyphBounds: [{ fontName: 'F', glyphs }],
      skippedSpaceGlyphs: [],
      graphicsBounds: graphics
    },
    rulePaintBounds = new Map(),
    rules = bottomStripRules(operators, viewport, rulePaintBounds),
    paths = new Map<string, Info>(),
    compiled = new Map<string, { getBounds: () => number[] }>()
  class Info {
    #buffer = new ArrayBuffer(4)
    get path(): Float32Array {
      return new Float32Array(this.#buffer)
    }
  }
  class Font {
    get fontMatrix(): number[] {
      return [0.001, 0, 0, 0.001, 0, 0]
    }
  }
  const font = Object.assign(new Font(), {
    loadedName: 'F',
    missingFile: false,
    isType3Font: false,
    isInvalidPDFjsFont: false,
    disableFontFace: true,
    vertical: false,
    getPathGenerator(_objs: unknown, c: string): Evidence {
      return compiled.get(c)
    }
  })
  for (const g of glyphs) {
    paths.set('F_path_' + g.fontChar, new Info())
    compiled.set(g.fontChar, { getBounds: (): number[] => [...g.bounds] })
  }
  const page = {
      pageNumber: 1,
      width: 100,
      height: 120,
      invalidGraphicsBounds: 0,
      graphicsBounds: graphics
    },
    context = { nativeGlyphContext, viewport, sourceContent: content, content, rulePaintBounds },
    nativePage = {
      commonObjs: { get: (key: string): Evidence => (key === 'F' ? font : paths.get(key)) }
    },
    table = {
      page: 1,
      cropRect: [0, 29, 100, 85],
      sourceViewport: { width: 100, height: 120, scale: 1 },
      caption: { page: 1, text: items[0].str, rect: [10, 10, 90, 20] },
      cells: [{ text: 's', sourceItems: [items[1].sourceItem] }],
      unassigned: [items[2].sourceItem],
      grid: { rows: 1, columns: 1 },
      clipped: [{ text: 'i', rect: [10, 76, 15, 86] }],
      issues: ['text-crosses-crop-boundary', 'native-table-structure-ambiguous']
    },
    captions = [{ ...table.caption, lines: [items[0].str] }]
  const options = {
    page,
    nativePage,
    nativeContent: structuredClone(content),
    captions,
    competingRects: []
  }
  const renderCrop = async (r: number[]): Promise<Buffer> => {
    const s = 4,
      c = createCanvas(Math.ceil((r[2] - r[0]) * s), Math.ceil((r[3] - r[1]) * s)),
      ctx = c.getContext('2d')
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.fillStyle = 'black'
    for (const y of [30, 50, 90]) ctx.fillRect((1 - r[0]) * s, (y - 0.5 - r[1]) * s, 98 * s, s)
    for (const item of items)
      for (const [j, char] of Array.from(item.str).entries())
        if (char !== ' ')
          ctx.fillRect(
            (item.transform[4] + j * 5 - r[0]) * s,
            (120 - item.transform[5] - 8 - r[1]) * s,
            5 * s,
            11 * s
          )
    return c.toBuffer('image/png')
  }
  return { table, rules, context, options, renderCrop, font, paths }
}

it('restores only a closed mathematical table bottom while preserving ambiguous cells and prior pixels', async () => {
  const f = bottomStripExample(),
    before = structuredClone(f.table),
    proof = proveBottomStrip(f.table, f.rules, f.context, f.options)
  expect(proof?.cropRect).toEqual([0, 29, 100, 90.5])
  const png = await renderBottomStrip(proof, f.renderCrop),
    next = commitBottomStrip(proof, png)
  expect(next.cropRect).toEqual([0, 29, 100, 90.5])
  expect(next.issues).toEqual(['native-table-structure-ambiguous'])
  expect(next.cells).toBe(f.table.cells)
  expect(next.unassigned).toBe(f.table.unassigned)
  expect(next.grid).toBe(f.table.grid)
  expect(f.table).toEqual(before)
})
it.each(['foreign paint', 'unclosed caption', 'unknown text rise', 'missing native glyph'])(
  'keeps the original mathematical crop without complete independent physical evidence: %s',
  (fault) => {
    const f = bottomStripExample()
    if (fault === 'foreign paint') f.options.competingRects.push([5, 89, 60, 95])
    if (fault === 'unclosed caption') f.options.captions = []
    if (fault === 'unknown text rise') {
      f.context.nativeGlyphContext.operators.fnArray.push(OPS.setTextRise)
      f.context.nativeGlyphContext.operators.argsArray.push([1])
    }
    if (fault === 'missing native glyph') f.context.nativeGlyphContext.glyphBounds[0].glyphs.pop()
    expect(proveBottomStrip(f.table, f.rules, f.context, f.options)).toBeUndefined()
  }
)
it('rejects a changed complete font-path byte during actual PNG decoding', async () => {
  const f = bottomStripExample(),
    proof = proveBottomStrip(f.table, f.rules, f.context, f.options)
  let count = 0
  const png = await renderBottomStrip(proof, async (rect: number[]): Promise<Buffer> => {
    const png = await f.renderCrop(rect)
    if (++count === 2)
      queueMicrotask(() => {
        new Uint8Array(f.paths.get('F_path_T').path.buffer)[0] ^= 1
      })
    return png
  })
  expect(png).toBeUndefined()
  expect(commitBottomStrip(proof, png)).toBeUndefined()
})
it('rejects late source or PNG changes before the synchronous image and metadata commit', async () => {
  for (const fault of ['source', 'png']) {
    const f = bottomStripExample(),
      proof = proveBottomStrip(f.table, f.rules, f.context, f.options),
      png = await renderBottomStrip(proof, f.renderCrop)
    expect(png).toBeDefined()
    if (fault === 'source') f.context.sourceContent.items = [...f.context.sourceContent.items]
    else png[100] ^= 1
    expect(commitBottomStrip(proof, png)).toBeUndefined()
  }
})

const {
  proveNativeTableCaptionStrip: proveCaptionStrip,
  renderNativeTableCaptionStrip: renderCaptionStrip,
  commitNativeTableCaptionStrip: commitCaptionStrip
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-table-caption-strip.mjs')).href
)
// Four native owners, two fonts, three rails, and one independently captioned
// neighboring group. Reuse the existing anonymous font and path witnesses.
function captionStripExample(): ReturnType<typeof JSON.parse> {
  type Evidence = ReturnType<typeof JSON.parse>
  const f = bottomStripExample(),
    original = f.context.sourceContent.items,
    items = [
      { ...original[0] },
      { ...original[0], str: 'T', width: 8, height: 16, transform: [16, 0, 0, 16, 0, 44] },
      { ...original[1], width: 5, transform: [10, 0, 0, 10, 11, 75] },
      { ...original[2], fontName: 'G', transform: [10, 0, 0, 10, 11, 40] }
    ].map((item, index) => ({ ...item, sourceItem: { pageNumber: 1, index, text: item.str } })),
    content = {
      styles: { ...f.context.sourceContent.styles, G: { ...f.context.sourceContent.styles.F } },
      items
    },
    operators: Evidence = { fnArray: [], argsArray: [] },
    graphics: Evidence[] = [],
    add = (op: number, args: unknown[]): number => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
      return operators.fnArray.length - 1
    },
    text = (item: Evidence): void => {
      add(OPS.beginText, [])
      add(OPS.setFont, [item.fontName, item.height])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, item.transform[4], item.transform[5]]])
      add(OPS.showText, [
        Array.from(item.str as string, (c) => ({
          unicode: c,
          fontChar: c,
          width: 500,
          isInFont: true,
          isSpace: c === ' '
        }))
      ])
      add(OPS.endText, [])
    }
  add(OPS.setLineWidth, [1])
  add(OPS.setStrokeRGBColor, ['#000000'])
  for (const y of [30, 50, 90]) {
    const operationIndex = add(OPS.constructPath, [
      OPS.stroke,
      [Float32Array.from([0, 10, 120 - y, 1, 99, 120 - y])],
      [10, 120 - y, 99, 120 - y]
    ])
    graphics.push({
      kind: 'path',
      operationIndex,
      normalizedRect: [0.1, (y - 0.5) / 120, 0.99, (y + 0.5) / 120]
    })
  }
  text(items[0])
  const group = {
    matrix: null,
    bbox: [0, 70, 8, 85],
    smask: null,
    isolated: false,
    knockout: false
  }
  add(OPS.beginGroup, [group])
  const operationIndex = add(OPS.constructPath, [
    OPS.fill,
    [Float32Array.from([0, 0, 70, 1, 8, 70, 1, 8, 85, 1, 0, 85, 4])],
    [0, 70, 8, 85]
  ])
  graphics.push({ kind: 'path', operationIndex, normalizedRect: [0, 35 / 120, 0.08, 50 / 120] })
  add(OPS.endGroup, [group])
  for (const item of items.slice(1)) text(item)
  const native = f.context.nativeGlyphContext
  native.content = structuredClone(content)
  native.operators = operators
  native.graphicsBounds = graphics
  native.glyphBounds.push({
    fontName: 'G',
    glyphs: [
      structuredClone(native.glyphBounds[0].glyphs.find((g: Evidence) => g.fontChar === 'i'))
    ]
  })
  f.context.sourceContent = content
  f.context.content = content
  f.context.rulePaintBounds = new Map()
  f.rules = bottomStripRules(operators, f.context.viewport, f.context.rulePaintBounds)
  f.options.page.graphicsBounds = graphics
  f.options.nativeContent = structuredClone(content)
  f.secondFont = Object.assign(Object.create(Object.getPrototypeOf(f.font)), f.font, {
    loadedName: 'G'
  })
  f.paths.set('G_path_i', f.paths.get('F_path_i'))
  const get = f.options.nativePage.commonObjs.get
  f.options.nativePage.commonObjs.get = (key: string): Evidence =>
    key === 'G' ? f.secondFont : get(key)
  f.table = {
    ...f.table,
    cropRect: [0, 30.25, 100, 95],
    selectedTextItems: 2,
    cells: items.slice(2).map((item) => ({
      text: item.str,
      sourceItems: [item.sourceItem],
      sourceRects: [
        [
          item.transform[4],
          120 - item.transform[5] - 10,
          item.transform[4] + 5,
          120 - item.transform[5]
        ]
      ]
    })),
    unassigned: [],
    clipped: [],
    issues: ['native-table-structure-ambiguous']
  }
  const caption = { page: 1, text: 'T', lines: ['T'], rect: [0, 60, 8, 76] }
  f.options.captions.push(caption)
  f.options.otherFigures = [{ id: 'neighbor', page: 1, caption }]
  f.options.competingRects = []
  f.renderCrop = async (r: number[]): Promise<Buffer> => {
    const scale = 4,
      c = createCanvas(Math.ceil((r[2] - r[0]) * scale), Math.ceil((r[3] - r[1]) * scale)),
      ctx = c.getContext('2d')
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.fillStyle = 'black'
    for (const y of [30, 50, 90])
      ctx.fillRect((10 - r[0]) * scale, (y - 0.5 - r[1]) * scale, 89 * scale, scale)
    ctx.fillRect(-r[0] * scale, (35 - r[1]) * scale, 8 * scale, 15 * scale)
    for (const item of items)
      for (const [j, char] of Array.from(item.str).entries())
        if (char !== ' ')
          ctx.fillRect(
            (item.transform[4] + j * item.height * 0.5 - r[0]) * scale,
            (120 - item.transform[5] - item.height * 0.8 - r[1]) * scale,
            item.height * 0.5 * scale,
            item.height * 1.1 * scale
          )
    return c.toBuffer('image/png')
  }
  return f
}
it('removes only the independently owned neighbor strip while retaining every table glyph and rail AA pixel', async () => {
  const f = captionStripExample(),
    before = structuredClone(f.table),
    proof = proveCaptionStrip(f.table, f.rules, f.context, f.options)
  expect(proof?.cropRect).toEqual([9.75, 29.25, 100, 95])
  const png = await renderCaptionStrip(proof, f.renderCrop),
    next = commitCaptionStrip(proof, png)
  expect(next?.cropRect).toEqual([9.75, 29.25, 100, 95])
  expect(next?.cells).toBe(f.table.cells)
  expect(next?.grid).toBe(f.table.grid)
  expect(next?.issues).toEqual(before.issues)
  expect(f.table).toEqual(before)
})
it.each(['lost caption line', 'mixed caption owners', 'unknown native paint', 'unclosed group'])(
  'preserves the original neighboring crop without its complete native certificate: %s',
  (fault) => {
    const f = captionStripExample()
    if (fault === 'lost caption line') f.options.otherFigures[0].caption.lines = []
    if (fault === 'mixed caption owners')
      f.options.otherFigures.push({ ...f.options.otherFigures[0], id: 'other' })
    if (fault === 'unknown native paint') f.options.page.invalidGraphicsBounds = 1
    if (fault === 'unclosed group')
      f.context.nativeGlyphContext.operators.argsArray
        .find((args: ReturnType<typeof JSON.parse>) => args?.[0]?.bbox)?.[0]
        .bbox.splice(2, 1, 80)
    expect(proveCaptionStrip(f.table, f.rules, f.context, f.options)).toBeUndefined()
  }
)
it.each(['fontMatrix', 'loadedName'])(
  'rejects a late unknown %s getter before it can mutate an earlier font path',
  async (key) => {
    const f = captionStripExample(),
      proof = proveCaptionStrip(f.table, f.rules, f.context, f.options),
      png = await renderCaptionStrip(proof, f.renderCrop)
    expect(commitCaptionStrip(proof, png)).toBeDefined()
    const path = f.paths.get('F_path_T').path,
      bytes = new Uint8Array(path.buffer, path.byteOffset, path.byteLength),
      first = bytes[0],
      original = f.secondFont[key]
    let calls = 0
    Object.defineProperty(f.secondFont, key, {
      configurable: true,
      get() {
        delete f.secondFont[key]
        bytes[0] ^= 1
        calls++
        return original
      }
    })
    expect(commitCaptionStrip(proof, png)).toBeUndefined()
    expect(calls).toBe(0)
    expect(bytes[0]).toBe(first)
  }
)

// A small anonymous ruled body reuses the existing font/path doubles. No paper
// text, images, identities, or coordinates are required by this regression.
function ruledBodyExample(): ReturnType<typeof JSON.parse> {
  type Evidence = ReturnType<typeof JSON.parse>
  const f = bottomStripExample(),
    base = f.context.sourceContent.items[0],
    items = [
      { ...base },
      ...Array.from({ length: 12 }, (_, i) => ({
        ...base,
        str: 'i',
        width: 5,
        transform: [10, 0, 0, 10, 10 + (i % 4) * 24, 76 - Math.floor(i / 4) * 20]
      })),
      { ...base, str: 'i', width: 5, transform: [10, 0, 0, 10, 10, 15] }
    ].map((r, index) => ({ ...r, sourceItem: { pageNumber: 1, index, text: r.str } })),
    content = { styles: f.context.sourceContent.styles, items },
    operators: Evidence = { fnArray: [], argsArray: [] },
    graphics: Evidence[] = []
  const add = (op: number, args: unknown[]): number => {
    operators.fnArray.push(op)
    operators.argsArray.push(args)
    return operators.fnArray.length - 1
  }
  add(OPS.setLineWidth, [1])
  add(OPS.setStrokeRGBColor, ['#000000'])
  for (const y of [30, 50, 90]) {
    const operationIndex = add(OPS.constructPath, [
      OPS.stroke,
      [Float32Array.from([0, 1, 120 - y, 1, 99, 120 - y])],
      [1, 120 - y, 99, 120 - y]
    ])
    graphics.push({
      kind: 'path',
      operationIndex,
      normalizedRect: [0.01, (y - 0.5) / 120, 0.99, (y + 0.5) / 120]
    })
  }
  for (const item of items) {
    add(OPS.beginText, [])
    add(OPS.setFont, ['F', 10])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, item.transform[4], item.transform[5]]])
    add(OPS.showText, [
      Array.from(item.str as string, (c) => ({
        unicode: c,
        fontChar: c,
        width: 500,
        isInFont: true,
        isSpace: c === ' '
      }))
    ])
    add(OPS.endText, [])
  }
  const rect = (r: Evidence): number[] => [
      r.transform[4],
      120 - r.transform[5] - 10,
      r.transform[4] + r.width,
      120 - r.transform[5]
    ],
    native = f.context.nativeGlyphContext
  native.content = structuredClone(content)
  native.operators = operators
  native.graphicsBounds = graphics
  delete native.skippedSpaceGlyphs
  f.context.sourceContent = content
  f.context.content = content
  f.context.operators = structuredClone(operators)
  f.rules = bottomStripRules(operators, f.context.viewport, (f.context.rulePaintBounds = new Map()))
  f.options.page.graphicsBounds = graphics
  f.options.nativeContent = structuredClone(content)
  f.options.otherFigures = []
  f.table.cropRect = [5, 34, 95, 101]
  f.table.selectedTextItems = 13
  f.table.unassigned = ['i']
  f.table.clipped = [{ text: 'i', rect: rect(items.at(-1)) }]
  f.table.cells = items.slice(1, -1).map((r, i) => ({
    row: Math.floor(i / 4),
    column: i % 4,
    text: r.str,
    sourceItems: [r.sourceItem],
    sourceRects: [rect(r)]
  }))
  f.table.grid = Array.from({ length: 3 }, () => ['i', 'i', 'i', 'i'])
  f.renderCrop = async (r: number[], parts?: number[][]): Promise<Buffer> => {
    const scale = 4,
      c = createCanvas(Math.ceil((r[2] - r[0]) * scale), Math.ceil((r[3] - r[1]) * scale)),
      ctx = c.getContext('2d')
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, c.width, c.height)
    if (parts) {
      ctx.beginPath()
      for (const p of parts)
        ctx.rect(
          (p[0] - r[0]) * scale,
          (p[1] - r[1]) * scale,
          (p[2] - p[0]) * scale,
          (p[3] - p[1]) * scale
        )
      ctx.clip()
    }
    ctx.fillStyle = 'black'
    for (const y of [30, 50, 90])
      ctx.fillRect((1 - r[0]) * scale, (y - 0.5 - r[1]) * scale, 98 * scale, scale)
    for (const item of items)
      for (const [j, char] of Array.from(item.str as string).entries())
        if (char !== ' ')
          ctx.fillRect(
            (item.transform[4] + j * 5 - r[0]) * scale,
            (120 - item.transform[5] - 8 - r[1]) * scale,
            5 * scale,
            11 * scale
          )
    return c.toBuffer('image/png')
  }
  return f
}

function ownedGlyphOverhang(): ReturnType<typeof JSON.parse> {
  const f = ruledBodyExample(),
    original = f.context.nativeGlyphContext.operators,
    order = [
      0,
      1,
      ...Array.from({ length: 5 }, (_, i) => i + 5),
      2,
      3,
      ...Array.from({ length: 60 }, (_, i) => i + 10),
      4,
      ...Array.from({ length: 5 }, (_, i) => i + 70)
    ],
    operators = {
      fnArray: order.map((i) => original.fnArray[i]),
      argsArray: order.map((i) => original.argsArray[i])
    },
    graphics = f.context.nativeGlyphContext.graphicsBounds.map(
      (g: ReturnType<typeof JSON.parse>) => ({
        ...g,
        operationIndex: order.indexOf(g.operationIndex)
      })
    )
  f.context.nativeGlyphContext.operators = operators
  f.context.nativeGlyphContext.graphicsBounds = graphics
  f.context.operators = structuredClone(operators)
  f.context.nativeEvidenceGraphics = graphics.map((g: ReturnType<typeof JSON.parse>) => ({
    kind: g.kind,
    rect: g.normalizedRect.map((x: number, i: number) => x * (i % 2 ? 120 : 100))
  }))
  f.context.nativePaintIdentityGraphics = f.context.nativeEvidenceGraphics.map(
    (g: ReturnType<typeof JSON.parse>, i: number) => ({
      ...g,
      operationIndex: graphics[i].operationIndex
    })
  )
  f.table.cropRect = [0.8, 29.2, 99.2, 85.1]
  f.table.unassigned = []
  f.table.clipped = []
  f.table.issues = []
  f.table.selectedTextItems = 12
  return f
}

it('completes an already owned glyph overhang and its closing stroke without changing cell claims', () => {
  const f = ownedGlyphOverhang(),
    before = structuredClone(f.table),
    result = refine(f.table, f.rules, f.context)
  expect(result?.cropRect).toEqual([0.55, 29.2, 99.45, 90.85])
  expect({ ...result, cropRect: before.cropRect }).toEqual(before)
  expect(result?.cells).toBe(f.table.cells)
  expect(f.table).toEqual(before)
})

it('binds the owned glyph crop to its native sources and actual raster protection', async () => {
  const f = ownedGlyphOverhang(),
    result = refine(f.table, f.rules, f.context),
    proof = ownedGlyphProof(result),
    png = await f.renderCrop(proof.nativeCrop),
    finalTable = { ...result, cropRect: [...result.cropRect] }
  expect(ownedGlyphPng(proof, png, finalTable)).toBe(true)
  const fallback = ownedGlyphFallback(proof, finalTable)
  expect(fallback).toEqual(f.table.cropRect)
  expect(fallback).not.toBe(proof.oldCropRect)
  fallback[0]--
  expect(ownedGlyphFallback(proof, finalTable)).toEqual(f.table.cropRect)
  expect(ownedGlyphFallback(structuredClone(proof), finalTable)).toBeUndefined()
  expect(ownedGlyphProof(structuredClone(result))).toBeUndefined()
  expect(ownedGlyphPng(structuredClone(proof), png, finalTable)).toBe(false)
  expect(ownedGlyphPng(proof, png, structuredClone(finalTable))).toBe(false)
  // A moderate retry still fits the page and exterior gap, but cannot keep
  // a whole antialiasing pixel around its own closing rule.
  const reduced = createCanvas(99, 62)
  expect(ownedGlyphPng(proof, reduced.toBuffer('image/png'), finalTable)).toBe(false)
  // This is a valid lower renderer scale, but its ceil/AA footprint reaches
  // foreign title ink. A byte-limit retry cannot inherit initial-scale safety.
  const small = createCanvas(8, 5)
  expect(ownedGlyphPng(proof, small.toBuffer('image/png'), finalTable)).toBe(false)
  expect(ownedGlyphFallback(proof, finalTable)).toEqual(f.table.cropRect)
})

it('refuses fallback after the public old crop is changed without exposing its private baseline', () => {
  const f = ownedGlyphOverhang(),
    result = refine(f.table, f.rules, f.context),
    proof = ownedGlyphProof(result)
  expect(ownedGlyphFallback(proof, result)).toEqual(f.table.cropRect)
  proof.oldCropRect[0]++
  expect(ownedGlyphFallback(proof, result)).toBeUndefined()
})

function closingRailFrame(): ReturnType<typeof JSON.parse> {
  const f = ownedGlyphOverhang(),
    native = f.context.nativeGlyphContext,
    operators = { fnArray: [] as number[], argsArray: [] as ReturnType<typeof JSON.parse>[] },
    graphics: ReturnType<typeof JSON.parse>[] = [],
    add = (op: number, args: unknown = null): number => {
      operators.fnArray.push(op)
      return operators.argsArray.push(args) - 1
    }
  for (const content of [f.context.sourceContent, native.content])
    for (const item of content.items.slice(5, 13)) {
      item.str = '1'
      item.sourceItem.text = '1'
    }
  if (!native.glyphBounds[0].glyphs.some((g: { fontChar: string }) => g.fontChar === '1'))
    native.glyphBounds[0].glyphs.push({
      ...structuredClone(
        native.glyphBounds[0].glyphs.find((g: { fontChar: string }) => g.fontChar === 'i')
      ),
      fontChar: '1'
    })
  let shown = 0
  add(OPS.setFillRGBColor, ['#000000'])
  for (const [i, op] of native.operators.fnArray.entries()) {
    const args = native.operators.argsArray[i]
    if (op === OPS.constructPath) {
      const y = 120 - args[1][0][2]
      for (const [left, right] of [
        [1, 48.5],
        [48.5, 49.5],
        [49.5, 99]
      ]) {
        const operationIndex = add(OPS.constructPath, [
          OPS.fill,
          [
            Float32Array.from([
              0,
              left,
              120 - y + 0.5,
              1,
              right,
              120 - y + 0.5,
              1,
              right,
              120 - y - 0.5,
              1,
              left,
              120 - y - 0.5,
              4
            ])
          ],
          [left, 120 - y - 0.5, right, 120 - y + 0.5]
        ])
        graphics.push({
          kind: 'path',
          operationIndex,
          normalizedRect: [left / 100, (y - 0.5) / 120, right / 100, (y + 0.5) / 120]
        })
      }
    } else {
      if (op === OPS.showText) {
        if (shown >= 5 && shown <= 12) Object.assign(args[0][0], { unicode: '1', fontChar: '1' })
        shown++
      }
      add(op, args)
    }
  }
  add(OPS.save)
  add(OPS.transform, [10, 0, 0, 10, 80, 15])
  const image = add(OPS.paintImageXObject, ['neighbor-image', 10, 10])
  add(OPS.restore)
  graphics.push({
    kind: 'image',
    operationIndex: image,
    normalizedRect: [0.8, 95 / 120, 0.9, 105 / 120]
  })
  native.operators = operators
  native.graphicsBounds = graphics
  native.pageNumber = 1
  native.sourceSha256 = 'a'.repeat(64)
  f.options.page.graphicsBounds = graphics
  f.context.sourcePage = f.options.page
  f.context.operators = structuredClone(operators)
  f.context.nativeEvidenceGraphics = graphics.map((g) => ({
    kind: g.kind,
    rect: g.normalizedRect.map((x: number, i: number) => x * (i % 2 ? 120 : 100))
  }))
  f.context.nativePaintIdentityGraphics = f.context.nativeEvidenceGraphics.map(
    (g: ReturnType<typeof JSON.parse>, i: number) => ({
      ...g,
      operationIndex: graphics[i].operationIndex
    })
  )
  f.rules = bottomStripRules(operators, f.context.viewport, (f.context.rulePaintBounds = new Map()))
  f.table.cropRect = [0.5, 29.5, 99.5, 88.6]
  for (const cell of f.table.cells)
    cell.text = cell.sourceItems.map((s: { text: string }) => s.text).join('')
  const unassigned = f.table.cells.pop()
  f.table.unassigned = [unassigned.text]
  f.table.issues = ['unassigned-source-text']
  f.table.notes = []
  f.table.selectedTextItems = 12
  f.context.captions = [f.table.caption]
  return f
}

it('restores only a complete closing rail while retaining unassigned Source and old pixel coordinates', async () => {
  const f = closingRailFrame(),
    before = structuredClone(f.table),
    result = refine(f.table, f.rules, f.context),
    proof = ownedGlyphProof(result)
  expect(result?.cropRect).toEqual([0.5, 29.5, 99.5, 90.85])
  expect({ ...result, cropRect: before.cropRect }).toEqual(before)
  expect(result.cells).toBe(f.table.cells)
  expect(result.unassigned).toBe(f.table.unassigned)
  const png = await f.renderCrop(proof.nativeCrop)
  expect(ownedGlyphPng(proof, png, result)).toBe(true)
  expect(ownedGlyphPng(proof, png, { ...result, unassigned: [...result.unassigned] })).toBe(false)
  expect(ownedGlyphPng(proof, png, { ...result, issues: [] })).toBe(false)
  expect(ownedGlyphPng(proof, png, { ...result, notes: [] })).toBe(true)
  expect(ownedGlyphPng(proof, png, { ...result, notes: undefined })).toBe(false)
  expect(ownedGlyphPng(proof, png, { ...result, notes: [{ text: 'foreign' }] })).toBe(false)
  const retry = createCanvas(Math.ceil(99 * 3.2), Math.ceil(61.35 * 3.2))
  expect(ownedGlyphPng(proof, retry.toBuffer('image/png'), result)).toBe(false)
  const baseline = ownedGlyphFallback(proof, result)
  expect(baseline).toEqual(before.cropRect)
  expect(ownedGlyphFallback(proof, { ...result, cropRect: baseline })).toEqual(before.cropRect)
  expect(
    ownedGlyphFallback(proof, { ...result, unassigned: [...result.unassigned] })
  ).toBeUndefined()
})

it('returns the existing refined baseline instead of the earlier detector crop when a rail PNG is declined', () => {
  const f = closingRailFrame()
  f.table.cropRect[1] = 22.5
  f.table.excludedCaptionItems = [f.table.caption.text]
  const result = refine(f.table, f.rules, f.context),
    proof = ownedGlyphProof(result)
  expect(result?.cropRect).toEqual([0.5, 29.5, 99.5, 90.85])
  expect(proof.oldCropRect).toEqual([0.5, 22.5, 99.5, 88.6])
  expect(ownedGlyphFallback(proof, result)).toEqual([0.5, 29.5, 99.5, 88.6])
})

it.each([
  'missing-body',
  'unassigned-literal',
  'missing-rail-piece',
  'foreign-image',
  'foreign-glyph',
  'caption',
  'paint-opacity'
])('declines an incomplete native closing-rail certificate: %s', (fault) => {
  const f = closingRailFrame()
  if (fault === 'missing-body') f.table.selectedTextItems--
  if (fault === 'unassigned-literal') f.table.unassigned[0] = 'unknown'
  if (fault === 'missing-rail-piece') {
    const op = f.context.nativeGlyphContext.graphicsBounds
      .filter((g: { kind: string }) => g.kind === 'path')
      .at(-1).operationIndex
    f.context.nativeGlyphContext.operators.fnArray[op] = OPS.dependency
    f.context.nativeGlyphContext.operators.argsArray[op] = []
  }
  if (fault === 'foreign-image') {
    const image = f.context.nativeEvidenceGraphics.at(-1)
    image.rect[1] = 89
    f.context.nativePaintIdentityGraphics.at(-1).rect = [...image.rect]
  }
  if (fault === 'foreign-glyph')
    for (const content of [f.context.sourceContent, f.context.nativeGlyphContext.content])
      content.items.at(-1).transform[5] = 30
  if (fault === 'caption') f.context.captions = []
  if (fault === 'paint-opacity') f.context.nativeGlyphContext.operators.argsArray[0] = ['#777777']
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
})

it.each([
  'source identity',
  'glyph evidence',
  'operator bytes',
  'geometry',
  'proof bounds',
  'late getter'
])('refuses an owned glyph certificate after its last renderer await changes %s', async (fault) => {
  const f = ownedGlyphOverhang(),
    result = refine(f.table, f.rules, f.context),
    proof = ownedGlyphProof(result),
    png = await f.renderCrop(proof.nativeCrop)
  let getterCalls = 0
  if (fault === 'source identity')
    f.context.sourceContent.items[1] = structuredClone(f.context.sourceContent.items[1])
  if (fault === 'glyph evidence')
    f.context.nativeGlyphContext.glyphBounds = structuredClone(
      f.context.nativeGlyphContext.glyphBounds
    )
  if (fault === 'operator bytes')
    f.context.nativeGlyphContext.operators.argsArray[7][0] = OPS.endPath
  if (fault === 'geometry') result.cropRect[3] += 0.25
  if (fault === 'proof bounds') proof.bounds.width += 1
  if (fault === 'late getter')
    Object.defineProperty(f.context, 'sourceContent', {
      get: () => {
        getterCalls++
        return f.context.content
      }
    })
  expect(ownedGlyphPng(proof, png, result)).toBe(false)
  expect(ownedGlyphFallback(proof, result)).toBeUndefined()
  expect(getterCalls).toBe(0)
})

it.each([
  'missing owner',
  'stale stroke',
  'foreign glyph',
  'unknown paint',
  'missing identity',
  'already complete'
])('does not extend an owned glyph crop without complete native paint ownership: %s', (fault) => {
  const f = ownedGlyphOverhang()
  if (fault === 'missing owner') f.table.cells.pop()
  if (fault === 'stale stroke') f.context.nativeGlyphContext.operators.argsArray[7][0] = OPS.endPath
  if (fault === 'foreign glyph')
    for (const content of [f.context.sourceContent, f.context.nativeGlyphContext.content])
      content.items.at(-1).transform[5] = 29
  if (fault === 'unknown paint')
    f.context.nativeEvidenceGraphics.push({ kind: 'path', rect: [2, 86, 98, 92] })
  if (fault === 'missing identity') delete f.context.nativePaintIdentityGraphics
  if (fault === 'already complete') f.table.cropRect = [0.55, 29.2, 99.45, 90.85]
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
})
it('completes a native ruled preview while retaining uncertain cells and excluding the cut note', async () => {
  const f = ruledBodyExample(),
    before = structuredClone(f.table),
    proof = proveCaptionStrip(f.table, f.rules, f.context, f.options)
  expect(proof?.nativeCrop).toEqual([0.75, 29.25, 99.25, 90.75])
  const png = await renderCaptionStrip(proof, f.renderCrop),
    next = commitCaptionStrip(proof, png)
  expect(next?.cells).toBe(f.table.cells)
  expect(next?.grid).toBe(f.table.grid)
  expect(next?.issues).toEqual(before.issues)
  expect(f.table).toEqual(before)
})
it.each([
  'missing actual operators',
  'changed actual glyph',
  'uncertified skipped glyph',
  'competing body'
])('declines a ruled crop with incomplete physical ownership: %s', (fault) => {
  const f = ruledBodyExample()
  if (fault === 'missing actual operators') delete f.context.operators
  if (fault === 'changed actual glyph') {
    const glyph = f.context.operators.argsArray.find(
      (a: ReturnType<typeof JSON.parse>) => a?.[0]?.[0]?.unicode
    )[0][0]
    glyph.unicode = 'X'
  }
  if (fault === 'uncertified skipped glyph')
    for (const o of [f.context.operators, f.context.nativeGlyphContext.operators])
      o.argsArray.find((a: ReturnType<typeof JSON.parse>) => a?.[0]?.[0]?.unicode)[0][0].isInFont =
        false
  if (fault === 'competing body') f.options.competingRects.push([1, 30, 99, 90])
  expect(proveCaptionStrip(f.table, f.rules, f.context, f.options)).toBeUndefined()
})
it('refuses a changed ruled preview after the last renderer await', async () => {
  const f = ruledBodyExample(),
    proof = proveCaptionStrip(f.table, f.rules, f.context, f.options),
    png = await renderCaptionStrip(proof, f.renderCrop)
  expect(png).toBeDefined()
  png[40] ^= 1
  expect(commitCaptionStrip(proof, png)).toBeUndefined()
})
it('retains the original ruled preview when only white margins would change', async () => {
  const f = ruledBodyExample()
  f.table.cropRect = [0.875, 29.375, 99.125, 90.625]
  const before = structuredClone(f.table),
    proof = proveCaptionStrip(f.table, f.rules, f.context, f.options)
  expect(proof).toBeDefined()
  const png = await renderCaptionStrip(proof, f.renderCrop)
  expect(png).toBeUndefined()
  expect(commitCaptionStrip(proof, png)).toBeUndefined()
  expect(f.table).toEqual(before)
})

// Generated complete native paint; the omitted parent/column labels remain
// original text, and the logical grid is deliberately never reconstructed.
type NativeHeaderFixtureData = ReturnType<typeof JSON.parse>

function multilineNativeHeader(): NativeHeaderFixtureData {
  const width = 320,
    height = 320,
    items: NativeHeaderFixtureData[] = [],
    operators: NativeHeaderFixtureData = { fnArray: [], argsArray: [] },
    graphics: NativeHeaderFixtureData[] = [],
    rules: number[][] = [],
    cells: NativeHeaderFixtureData[] = [],
    grid: string[][] = []
  const viewport = {
    width,
    height,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, height],
    convertToViewportPoint: (x: number, y: number): number[] => [x, height - y]
  }
  const text = (
    str: string,
    center: number,
    y: number,
    rotated = false
  ): NativeHeaderFixtureData => {
    const x = center - str.length * 2.5,
      index = items.length,
      item = {
        str,
        width: str.length * 5,
        height: 10,
        dir: 'ltr',
        fontName: 'F',
        transform: rotated ? [0, 10, -10, 0, center, height - y] : [10, 0, 0, 10, x, height - y],
        sourceItem: { pageNumber: 1, index, text: str }
      }
    items.push(item)
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      ['F', 10],
      [new Float32Array(rotated ? [0, 1, -1, 0, center, height - y] : [1, 0, 0, 1, x, height - y])],
      [Array.from(str, (c) => ({ unicode: c, fontChar: c, width: 500, isInFont: true }))],
      null
    )
    return item
  }
  const rule = (x: number, y: number, right: number): void => {
    const operationIndex = operators.fnArray.length,
      rect = [x, y - 0.2, right, y + 0.2],
      r = [x, y, right, y]
    operators.fnArray.push(
      OPS.setStrokeRGBColor,
      OPS.setLineWidth,
      OPS.setLineCap,
      OPS.constructPath
    )
    operators.argsArray.push(
      ['#000000'],
      [0.4],
      [0],
      [OPS.stroke, [[0, x, height - y, 1, right, height - y]], [x, height - y, right, height - y]]
    )
    graphics.push({ kind: 'path', operationIndex: operationIndex + 3, rect })
    rules.push(r)
  }
  const box = (i: NativeHeaderFixtureData): number[] => [
    i.transform[4],
    height - i.transform[5] - 10,
    i.transform[4] + i.width,
    height - i.transform[5]
  ]
  const caption = text('Table 1: Results.', 100, 30)
  rule(40, 50, 300)
  text('Metric', 135, 65)
  text('(u)', 132.5, 75)
  text('↑', 150, 75)
  const centers = [60, 90, 120, 150, 185, 215, 245, 275]
  for (const x of centers.slice(4)) {
    text('Rate', x, 65)
    text('(u)', x, 75)
    text('↑', x, 85)
  }
  rule(110, 88, 160)
  grid.push(['Kind', 'Flag', 'Near', 'Far', '', '', '', ''])
  for (const [column, label] of grid[0].entries()) {
    const i = label ? text(label, centers[column], 100) : undefined
    cells.push({
      row: 0,
      column,
      rowSpan: 1,
      colSpan: 1,
      text: label,
      sourceItems: i ? [i.sourceItem] : [],
      sourceRects: i ? [box(i)] : []
    })
  }
  rule(40, 108, 300)
  for (let row = 1; row <= 4; row++) {
    const labels = centers.map((_, column) =>
      column === 0 ? 'Item ' + row : column === 1 ? '+' : String(10 + row + column)
    )
    grid.push(labels)
    for (const [column, label] of labels.entries()) {
      const i = text(label, centers[column], 110 + row * 20)
      cells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: label,
        sourceItems: [i.sourceItem],
        sourceRects: [box(i)]
      })
    }
  }
  rule(40, 210, 300)
  text('Z', 15, 285, true)
  const content = { items, styles: { F: { ascent: 0.8, descent: -0.2, vertical: false } } },
    bounds = graphics.map((g) => ({
      kind: g.kind,
      operationIndex: g.operationIndex,
      normalizedRect: g.rect.map((n: number, i: number) => n / (i % 2 ? height : width))
    })),
    page = { pageNumber: 1, width, height, graphicsBounds: bounds, invalidGraphicsBounds: 0 },
    context = {
      content,
      sourceContent: content,
      viewport,
      sourcePage: page,
      captions: [{ page: 1, lines: [caption.str], rect: box(caption) }],
      rulePaintBounds: new Map(rules.map((r, i) => [r.join(','), graphics[i].rect])),
      nativeEvidenceGraphics: graphics.map((g) => ({ kind: g.kind, rect: g.rect })),
      nativePaintIdentityGraphics: graphics,
      nativeGlyphContext: {
        pageNumber: 1,
        sourceSha256: 'a'.repeat(64),
        content: structuredClone(content),
        viewport,
        operators,
        graphicsBounds: bounds,
        skippedSpaceGlyphs: [],
        glyphBounds: [
          {
            fontName: 'F',
            glyphs: [...new Set(items.flatMap((i) => Array.from(i.str)))].map((c) => ({
              fontChar: c,
              bounds: c === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7]
            }))
          }
        ]
      }
    },
    table = {
      id: 'table',
      page: 1,
      cropRect: [35, 70, 305, 215],
      sourceViewport: { width, height, scale: 1 },
      grid,
      cells,
      notes: [],
      unassigned: ['Metric'],
      clipped: items
        .filter((i) => !i.transform[1] && box(i)[1] < 70 && box(i)[3] > 70)
        .map((i) => ({ text: i.str, rect: box(i) })),
      issues: [
        'text-crosses-crop-boundary',
        'unsupported-text-orientation',
        'unassigned-source-text'
      ],
      reviewCandidate: true,
      caption: { page: 1, text: caption.str, rect: box(caption) }
    }
  return { table, context, rules }
}
function multilineHeaderPng(rect: number[], factor = 1): Buffer {
  const canvas = createCanvas(
    Math.ceil((rect[2] - rect[0]) * 4 * factor),
    Math.ceil((rect[3] - rect[1]) * 4 * factor)
  )
  try {
    return canvas.toBuffer('image/png')
  } finally {
    canvas.width = canvas.height = 0
  }
}
it('recovers only a closed multiline header image while pausing the unchanged incomplete grid', () => {
  const f = multilineNativeHeader(),
    before = structuredClone(f.table),
    next = refine(f.table, f.rules, f.context)
  expect(next?.cropRect).toEqual([35, 49.5, 305, 215])
  expect(next?.cells).toBe(f.table.cells)
  expect(next?.grid).toBe(f.table.grid)
  expect(next?.issues).toEqual([...f.table.issues, 'native-table-structure-ambiguous'])
  expect(next?.reviewCandidate).toBe(false)
  expect(f.table).toEqual(before)
  const proof = ownedGlyphProof(next),
    png = multilineHeaderPng(next.cropRect)
  expect(proof).toBeDefined()
  expect(ownedGlyphPng(proof, png, next)).toBe(true)
  expect(ownedGlyphPng(proof, multilineHeaderPng(next.cropRect, 0.5), next)).toBe(false)
  expect(ownedGlyphFallback(proof, next)).toEqual(before.cropRect)
})
it.each([
  'foreign glyph',
  'unknown font',
  'foreign outline',
  'wrong source',
  'wrong source frame',
  'lost header rule',
  'wrong rule paint',
  'peer caption',
  'unsupported paint',
  'wrong numeric lane',
  'overlapping header',
  'wrong caption',
  'missing graphic identity'
])('retains the old multiline preview when native ownership is incomplete: %s', (fault) => {
  const f = multilineNativeHeader(),
    n = f.context.nativeGlyphContext
  if (fault === 'foreign glyph') n.operators.argsArray.at(-2)[0][0].isInFont = false
  if (fault === 'unknown font') f.context.content.styles.F.ascent = n.content.styles.F.ascent = 0
  if (fault === 'foreign outline')
    n.glyphBounds[0].glyphs = n.glyphBounds[0].glyphs.filter(
      (g: NativeHeaderFixtureData) => g.fontChar !== 'Z'
    )
  if (fault === 'wrong source') f.table.cells[10].sourceItems[0].text = 'different'
  if (fault === 'wrong source frame') f.table.cells[10].sourceRects[0][0] += 1
  if (fault === 'lost header rule') f.rules.splice(0, 1)
  if (fault === 'wrong rule paint') f.context.rulePaintBounds.get(f.rules[0].join(','))[1] += 1
  if (fault === 'peer caption')
    f.context.captions.push({ page: 1, lines: ['Table 2: Other.'], rect: [180, 55, 200, 65] })
  if (fault === 'unsupported paint') {
    n.operators.fnArray.push(OPS.setGState)
    n.operators.argsArray.push([[['BM', 'multiply']]])
  }
  if (fault === 'wrong numeric lane') f.table.cells[10].text = 'text'
  if (fault === 'overlapping header') n.content.items[4].transform[4] += 50
  if (fault === 'wrong caption') f.table.caption.text = 'Other caption'
  if (fault === 'missing graphic identity') f.context.nativePaintIdentityGraphics = []
  expect(ownedGlyphProof(refine(f.table, f.rules, f.context))).toBeUndefined()
})
it.each([
  'source item',
  'operator array',
  'foreign bounds',
  'glyph outline',
  'map identity',
  'skipped spaces'
])('revokes a multiline crop certificate after late input changes: %s', (fault) => {
  const f = multilineNativeHeader(),
    next = refine(f.table, f.rules, f.context),
    proof = ownedGlyphProof(next),
    png = multilineHeaderPng(next.cropRect)
  expect(ownedGlyphPng(proof, png, next)).toBe(true)
  if (fault === 'source item') f.context.content.items[0] = { ...f.context.content.items[0] }
  if (fault === 'operator array')
    f.context.nativeGlyphContext.operators.fnArray = [
      ...f.context.nativeGlyphContext.operators.fnArray
    ]
  if (fault === 'foreign bounds') f.context.sourcePage.graphicsBounds[0].normalizedRect[0] += 0.01
  if (fault === 'glyph outline')
    f.context.nativeGlyphContext.glyphBounds[0].glyphs[0].bounds[0] += 0.01
  if (fault === 'map identity')
    f.context.rulePaintBounds.set(f.rules[0].join(','), [
      ...f.context.rulePaintBounds.get(f.rules[0].join(','))
    ])
  if (fault === 'skipped spaces') f.context.nativeGlyphContext.skippedSpaceGlyphs = []
  expect(ownedGlyphPng(proof, png, next)).toBe(false)
  expect(ownedGlyphFallback(proof, next)).toBeUndefined()
})

// Generated paired panels retain their complete native Source and paint.
function repeatedNativePanel(): NativeHeaderFixtureData {
  const width = 320,
    height = 420,
    items: NativeHeaderFixtureData[] = [],
    operators: NativeHeaderFixtureData = { fnArray: [], argsArray: [] },
    graphics: NativeHeaderFixtureData[] = [],
    rules: number[][] = [],
    grid: string[][] = [],
    cells: NativeHeaderFixtureData[] = [],
    heads: NativeHeaderFixtureData[] = []
  const viewport = {
    width,
    height,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, height],
    convertToViewportPoint: (x: number, y: number) => [x, height - y]
  }
  function text(str: string, center: number, y: number): NativeHeaderFixtureData {
    const x = center - str.length * 2.5,
      index = items.length,
      item = {
        str,
        width: str.length * 5,
        height: 10,
        dir: 'ltr',
        fontName: 'F',
        transform: [10, 0, 0, 10, x, height - y],
        sourceItem: { pageNumber: 1, index, text: str }
      }
    items.push(item)
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      ['F', 10],
      [new Float32Array([1, 0, 0, 1, x, height - y])],
      [Array.from(str, (c) => ({ unicode: c, fontChar: c, width: 500, isInFont: true }))],
      null
    )
    return item
  }
  function rule(y: number, left = 40, right = 280): void {
    const operationIndex = operators.fnArray.length,
      rect = [left, y - 0.2, right, y + 0.2]
    operators.fnArray.push(
      OPS.setStrokeRGBColor,
      OPS.setLineWidth,
      OPS.setLineCap,
      OPS.constructPath
    )
    operators.argsArray.push(
      ['#000000'],
      [0.4],
      [0],
      [
        OPS.stroke,
        [[0, left, height - y, 1, right, height - y]],
        [left, height - y, right, height - y]
      ]
    )
    graphics.push({ kind: 'path', operationIndex: operationIndex + 3, rect })
    rules.push([left, y, right, y])
  }
  const box = (i: NativeHeaderFixtureData): number[] => [
    i.transform[4],
    height - i.transform[5] - 10,
    i.transform[4] + i.width,
    height - i.transform[5]
  ]
  const caption = text('Table 1: Values.', 160, 30)
  function panel(top: number, label: string, lower: boolean): NativeHeaderFixtureData {
    rule(top)
    const title = text(label, 160, top + 11)
    heads.push(title)
    rule(top + 18)
    const first: NativeHeaderFixtureData[] = [],
      last: NativeHeaderFixtureData[] = []
    for (let n = 0; n < 9; n++) first.push(text('H' + n, 55 + n * 26.25, top + 32))
    for (let n = 0; n < 3; n++) rule(top + 38, 70 + n * 70, 120 + n * 70)
    for (let n = 0; n < 9; n++) last.push(text('N' + n, 55 + n * 26.25, top + 49))
    rule(top + 58)
    if (lower)
      for (const [row, record] of [first, last].entries()) {
        const groups = [
            [record[0]],
            [record[1], record[2]],
            [record[3]],
            [record[4], record[5]],
            [record[6]],
            [record[7]],
            [record[8]]
          ],
          line = []
        for (const [column, source] of groups.entries()) {
          const value = source.map((i) => i.str).join(' ')
          line.push(value)
          cells.push({
            row,
            column,
            rowSpan: 1,
            colSpan: 1,
            text: value,
            sourceItems: source.map((i) => i.sourceItem),
            sourceRects: source.map(box)
          })
        }
        grid.push(line)
      }
    for (let row = 0; row < 4; row++) {
      const line = []
      for (let column = 0; column < 7; column++) {
        const i = text(String(row * 7 + column + 1), 55 + column * 35, top + 75 + row * 20)
        line.push(i.str)
        if (lower)
          cells.push({
            row: row + 2,
            column,
            rowSpan: 1,
            colSpan: 1,
            text: i.str,
            sourceItems: [i.sourceItem],
            sourceRects: [box(i)]
          })
      }
      if (lower) grid.push(line)
    }
    rule(top + 148)
    return title
  }
  panel(50, 'AA', false)
  const title = panel(214, 'BB', true),
    content = { items, styles: { F: { ascent: 0.8, descent: -0.2, vertical: false } } },
    bounds = graphics.map((g) => ({
      kind: g.kind,
      operationIndex: g.operationIndex,
      normalizedRect: g.rect.map((n: number, i: number) => n / (i % 2 ? height : width))
    })),
    page = { pageNumber: 1, width, height, graphicsBounds: bounds, invalidGraphicsBounds: 0 },
    context = {
      content,
      sourceContent: content,
      viewport,
      sourcePage: page,
      captions: [{ page: 1, lines: [caption.str], rect: box(caption) }],
      rulePaintBounds: new Map(rules.map((r, i) => [r.join(','), graphics[i].rect])),
      nativeEvidenceGraphics: bounds.map((g) => ({
        kind: g.kind,
        rect: g.normalizedRect.map((n: number, i: number) => n * (i % 2 ? height : width))
      })),
      nativePaintIdentityGraphics: bounds.map((g) => ({
        kind: g.kind,
        operationIndex: g.operationIndex,
        rect: g.normalizedRect.map((n: number, i: number) => n * (i % 2 ? height : width))
      })),
      nativeGlyphContext: {
        pageNumber: 1,
        sourceSha256: 'c'.repeat(64),
        content: structuredClone(content),
        viewport,
        operators,
        graphicsBounds: bounds,
        skippedSpaceGlyphs: [],
        glyphBounds: [
          {
            fontName: 'F',
            glyphs: [...new Set(items.flatMap((i) => Array.from(i.str)))].map((c) => ({
              fontChar: c,
              bounds: c === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7]
            }))
          }
        ]
      }
    },
    table = {
      id: 'table',
      page: 1,
      cropRect: [35, 224, 285, 370],
      sourceViewport: { width, height, scale: 1 },
      grid,
      cells,
      notes: [],
      unassigned: [],
      clipped: [{ text: title.str, rect: box(title) }],
      issues: ['text-crosses-crop-boundary'],
      reviewCandidate: true
    }
  return { table, context, rules, heads, items, text, rule, box }
}

it('restores a proven repeated panel heading without granting cell or mapping rights', () => {
  const f = repeatedNativePanel(),
    before = structuredClone(f.table),
    next = refine(f.table, f.rules, f.context)
  expect(next?.cropRect).toEqual([35, 213.5, 285, 370])
  expect(next).toEqual({ ...before, cropRect: [35, 213.5, 285, 370] })
  expect(next.cells).toBe(f.table.cells)
  expect(next.grid).toBe(f.table.grid)
  expect(f.table).toEqual(before)
  const proof = ownedGlyphProof(next),
    png = multilineHeaderPng(next.cropRect)
  expect(proof).toBeDefined()
  expect(ownedGlyphPng(proof, png, next)).toBe(true)
  expect(ownedGlyphPng(proof, multilineHeaderPng(next.cropRect, 0.5), next)).toBe(false)
  expect(ownedGlyphFallback(proof, next)).toEqual(before.cropRect)
})
it.each([
  'header mismatch',
  'missing font',
  'wrong numeric Source',
  'wrong Source frame',
  'grid conflict',
  'wrong caption',
  'foreign paint',
  'unmatched path insertion'
])('retains the previous crop when repeated panel evidence is incomplete: %s', (fault) => {
  const f = repeatedNativePanel(),
    n = f.context.nativeGlyphContext
  if (fault === 'header mismatch') f.items[2].str = n.content.items[2].str = 'Other'
  if (fault === 'missing font') delete n.content.styles.F.ascent
  if (fault === 'wrong numeric Source') f.table.cells[14].sourceItems[0].text = 'Other'
  if (fault === 'wrong Source frame') f.table.cells[14].sourceRects[0][0] += 1
  if (fault === 'grid conflict') f.table.grid[2][0] = 'Other'
  if (fault === 'wrong caption') f.context.captions[0].lines = ['Table 2: Other.']
  if (fault === 'foreign paint') n.graphicsBounds[0].normalizedRect[1] = 0.53
  if (fault === 'unmatched path insertion') {
    n.operators.fnArray.unshift(OPS.constructPath, OPS.clip, OPS.endPath)
    n.operators.argsArray.unshift(
      [OPS.rectangle, [[0, 0, 1, 320, 420]], [0, 0, 320, 420]],
      null,
      null
    )
  }

  expect(ownedGlyphProof(refine(f.table, f.rules, f.context))).toBeUndefined()
})
it('revokes the repeated panel PNG proof after native source changes', () => {
  const f = repeatedNativePanel(),
    next = refine(f.table, f.rules, f.context),
    proof = ownedGlyphProof(next),
    png = multilineHeaderPng(next.cropRect)
  expect(ownedGlyphPng(proof, png, next)).toBe(true)
  f.context.content.items[0] = { ...f.context.content.items[0] }
  expect(ownedGlyphPng(proof, png, next)).toBe(false)
  expect(ownedGlyphFallback(proof, next)).toBeUndefined()
})

it('uses the source viewport for repeated panel crops and caption ownership', () => {
  const f = repeatedNativePanel(),
    c = f.context,
    s = 1.5,
    v = c.viewport
  c.viewport = {
    ...v,
    width: v.width * s,
    height: v.height * s,
    scale: s,
    transform: v.transform.map((n: number) => n * s),
    convertToViewportPoint: (x: number, y: number) => [x * s, (v.height - y) * s]
  }
  f.table.sourceViewport = { width: v.width * s, height: v.height * s, scale: s }
  f.table.cropRect = f.table.cropRect.map((n: number) => n * s)
  for (const cell of f.table.cells)
    cell.sourceRects = cell.sourceRects.map((r: number[]) => r.map((n) => n * s))
  f.table.clipped = f.table.clipped.map((i: NativeHeaderFixtureData) => ({
    ...i,
    rect: i.rect.map((n: number) => n * s)
  }))
  c.captions = c.captions.map((i: NativeHeaderFixtureData) => ({
    ...i,
    rect: i.rect.map((n: number) => n * s)
  }))
  f.rules = f.rules.map((r: number[]) => r.map((n) => n * s))
  c.rulePaintBounds = new Map(
    [...c.rulePaintBounds].map(([key, r]: [string, number[]]) => [
      key
        .split(',')
        .map(Number)
        .map((n) => n * s)
        .join(','),
      r.map((n) => n * s)
    ])
  )
  c.nativeEvidenceGraphics = c.nativeEvidenceGraphics.map(
    (g: NativeHeaderFixtureData, i: number) => ({
      ...g,
      rect: c.nativeGlyphContext.graphicsBounds[i].normalizedRect.map(
        (n: number, k: number) => n * (k % 2 ? c.viewport.height : c.viewport.width)
      )
    })
  )
  c.nativePaintIdentityGraphics = c.nativePaintIdentityGraphics.map(
    (g: NativeHeaderFixtureData, i: number) => ({
      ...g,
      rect: c.nativeGlyphContext.graphicsBounds[i].normalizedRect.map(
        (n: number, k: number) => n * (k % 2 ? c.viewport.height : c.viewport.width)
      )
    })
  )
  const before = structuredClone(f.table),
    next = refine(f.table, f.rules, c)
  expect(next?.cropRect).toEqual([52.5, 320.25, 427.5, 555])
  expect(next).toEqual({ ...before, cropRect: [52.5, 320.25, 427.5, 555] })
  expect(ownedGlyphProof(next)).toBeDefined()
  expect(f.table).toEqual(before)
})

it('requires opaque strokes with stable native path identities for a repeated panel crop', () => {
  for (const alpha of [1, 0.5]) {
    const f = repeatedNativePanel(),
      n = f.context.nativeGlyphContext
    n.operators.fnArray.unshift(OPS.setGState)
    n.operators.argsArray.unshift([[['CA', alpha]]])
    for (const graphic of n.graphicsBounds) graphic.operationIndex++
    for (const graphic of f.context.nativePaintIdentityGraphics) graphic.operationIndex++
    const next = refine(f.table, f.rules, f.context)
    if (alpha === 1) expect(next?.cropRect).toEqual([35, 213.5, 285, 370])
    else expect(ownedGlyphProof(next)).toBeUndefined()
  }
})

// Complete primitive paint with an independent prose line above a small lattice.
function uncaptainedNativeLattice(following = false): NativeHeaderFixtureData {
  const width = 260,
    height = 140,
    items: NativeHeaderFixtureData[] = [],
    operators: NativeHeaderFixtureData = { fnArray: [], argsArray: [] },
    graphics: NativeHeaderFixtureData[] = [],
    cells: NativeHeaderFixtureData[] = []
  const viewport = {
    width,
    height,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, height],
    convertToViewportPoint: (x: number, y: number): number[] => [x, height - y]
  }
  function draw(str: string, x: number, y: number, fontName = 'F'): NativeHeaderFixtureData {
    const item = {
      str,
      dir: 'ltr',
      height: 10,
      width: str === '~' ? 0 : str.length * 5,
      fontName,
      transform: [10, 0, 0, 10, x, height - y],
      sourceItem: { pageNumber: 1, index: items.length, text: str }
    }
    items.push(item)
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      [fontName, 10],
      [[1, 0, 0, 1, x, height - y]],
      [
        Array.from(str, (c) => ({
          unicode: c,
          fontChar: c,
          width: c === '~' ? 0 : 500,
          isInFont: true
        }))
      ],
      null
    )
    return item
  }
  function rail(x: number, y: number, right: number, bottom: number): void {
    const vertical = x === right,
      rect = [
        x - (vertical ? 0.2 : 0),
        y - (vertical ? 0 : 0.2),
        right + (vertical ? 0.2 : 0),
        bottom + (vertical ? 0 : 0.2)
      ]
    const op = operators.fnArray.length
    operators.fnArray.push(
      OPS.setStrokeRGBColor,
      OPS.setLineWidth,
      OPS.setLineCap,
      OPS.constructPath
    )
    operators.argsArray.push(
      ['#000000'],
      [0.4],
      [0],
      [
        OPS.stroke,
        [[0, x, height - y, 1, right, height - bottom]],
        [x, height - bottom, right, height - y]
      ]
    )
    graphics.push({ kind: 'path', operationIndex: op + 3, rect })
  }
  if (!following) {
    draw('Some previous prose', 10, 40)
    draw('and the next sentence', 112, 40)
  }
  const grid = [
    ['A', 'B'],
    ['3', '4']
  ]
  for (const [row, line] of grid.entries())
    for (const [column, label] of line.entries()) {
      const item = draw(label, 110 + column * 30, 62 + row * 20)
      cells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: label,
        sourceItems: [item.sourceItem],
        sourceRects: [
          [
            item.transform[4],
            height - item.transform[5] - 10,
            item.transform[4] + item.width,
            height - item.transform[5]
          ]
        ]
      })
    }
  if (following) {
    items.at(-1).hasEOL = true
    draw('Following plain prose', 10, 104)
    draw('continues outside the table', 117, 104).hasEOL = true
    draw('~', 240, 20)
  } else draw('Z', 240, 20, 'G')
  for (const y of [50, 70, 90]) rail(99.8, y, following ? 159.999 : 160.2, y)
  for (const top of [50, 70]) for (const x of [100, 130, 160]) rail(x, top + 0.2, x, top + 19.8)
  if (following) {
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push([OPS.endPath, [null], null])
  }
  const content = {
      items,
      styles: {
        F: { ascent: 0.8, descent: -0.2, vertical: false },
        G: { ascent: 0, descent: 0, vertical: false }
      }
    },
    bounds = graphics.map((g) => ({
      kind: g.kind,
      operationIndex: g.operationIndex,
      normalizedRect: g.rect.map((n: number, i: number) => n / (i % 2 ? height : width))
    })),
    sourcePage = { pageNumber: 1, width, height, graphicsBounds: bounds, invalidGraphicsBounds: 0 },
    context = {
      content,
      sourceContent: content,
      sourcePage,
      viewport,
      captions: [],
      rulePaintBounds: new Map(),
      nativeEvidenceGraphics: graphics.map((g) => ({ kind: g.kind, rect: g.rect })),
      nativePaintIdentityGraphics: graphics,
      nativeGlyphContext: {
        pageNumber: 1,
        sourceSha256: 'e'.repeat(64),
        content: structuredClone(content),
        viewport,
        operators,
        graphicsBounds: bounds,
        skippedSpaceGlyphs: [],
        glyphBounds: ['F', 'G'].map((fontName) => ({
          fontName,
          glyphs: [
            ...new Set(
              items.filter((i) => i.fontName === fontName).flatMap((i) => Array.from(i.str))
            )
          ].map((c) => ({ fontChar: c, bounds: c === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7] }))
        }))
      }
    },
    table = {
      id: 'table',
      page: 1,
      cropRect: following ? [95, 49, 161, 98] : [95, 39, 160.25, 95],
      sourceViewport: { width, height, scale: 1 },
      grid,
      cells,
      notes: [],
      unassigned: [],
      clipped: following
        ? [{ text: 'Following plain prose', rect: [10, 94, 110, 104] }]
        : [{ text: 'prose', rect: [95, 30, 105, 40] }],
      issues: ['text-crosses-crop-boundary'],
      reviewCandidate: false
    }
  const rules = bottomStripRules(operators, viewport, context.rulePaintBounds)
  return { table, context, rules }
}

it('excludes following prose from a native lattice while retaining remote zero advance and empty end paths', () => {
  const f = uncaptainedNativeLattice(true),
    before = structuredClone(f.table)
  const r = refineVisual(f.table, nativeLatticeItems(f), f.rules, f.context)
  expect(r).toEqual({ ...before, cropRect: [95, 49, 161, 90.5] })
  expect(r.cells).toBe(f.table.cells)
  expect(r.grid).toBe(f.table.grid)
  expect(ownedGlyphProof(r)).toBeDefined()
  expect(f.table).toEqual(before)
})
it.each([
  'missing source',
  'different owner',
  'foreign paint',
  'open text',
  'incomplete line',
  'transparent stroke',
  'foreign zero ink',
  'unrepresented stroke',
  'short rail',
  'missing native',
  'owned zero'
])('declines following prose exclusion without complete native evidence: %s', (fault) => {
  const f = uncaptainedNativeLattice(true),
    c = f.context,
    n = c.nativeGlyphContext
  if (fault === 'missing source') f.table.cells[0].sourceItems = []
  if (fault === 'missing native') c.nativeGlyphContext = undefined
  if (fault === 'owned zero') {
    c.content.items[0].width = 0
    n.content.items[0].width = 0
    n.operators.argsArray[3][0][0].width = 0
    f.table.cells[0].sourceRects[0][2] = 110
  }
  if (fault === 'different owner') f.table.cells[0].sourceItems[0].index = 3
  if (fault === 'foreign paint') c.nativePaintIdentityGraphics[0].operationIndex++
  if (fault === 'open text') n.operators.fnArray[29] = OPS.beginText
  if (fault === 'incomplete line') {
    c.content.items[5].hasEOL = false
    n.content.items[5].hasEOL = false
  }
  if (fault === 'transparent stroke') {
    const op = c.nativePaintIdentityGraphics[0].operationIndex
    n.operators.fnArray[op - 3] = OPS.setGState
    n.operators.argsArray[op - 3] = [[['CA', 0.5]]]
  }
  if (fault === 'foreign zero ink') {
    for (const item of [c.content.items[6], n.content.items[6]])
      item.transform = [10, 0, 0, 10, 120, 50]
    n.operators.argsArray[32] = [[1, 0, 0, 1, 120, 50]]
  }
  if (fault === 'unrepresented stroke') n.operators.argsArray.at(-1)[0] = OPS.stroke
  if (fault === 'short rail') {
    for (const g of c.nativePaintIdentityGraphics) {
      const a = n.operators.argsArray[g.operationIndex],
        p = a[1][0]
      if (p[2] !== p[5]) continue
      p[4] = 159.6
      a[2][2] = 159.6
      g.rect[2] = 159.6
      n.graphicsBounds.find(
        (b: NativeHeaderFixtureData) => b.operationIndex === g.operationIndex
      ).normalizedRect[2] = 159.6 / c.viewport.width
    }
    c.rulePaintBounds = new Map()
    f.rules = bottomStripRules(n.operators, c.viewport, c.rulePaintBounds)
  }
  expect(ownedGlyphProof(refineVisual(f.table, nativeLatticeItems(f), f.rules, c))).toBeUndefined()
})
it('invalidates following-lattice crop authority after native content changes', () => {
  const f = uncaptainedNativeLattice(true),
    next = refineVisual(f.table, nativeLatticeItems(f), f.rules, f.context),
    proof = ownedGlyphProof(next)
  expect(proof).toBeDefined()
  expect(ownedGlyphFallback(proof, next)).toEqual(f.table.cropRect)
  f.context.nativeGlyphContext.content.items[5].hasEOL = false
  expect(ownedGlyphFallback(proof, next)).toBeUndefined()
})
it('bounds an uncaptioned native lattice without changing its owners or diagnostics', () => {
  const f = uncaptainedNativeLattice(),
    before = structuredClone(f.table),
    r = refine(f.table, f.rules, f.context)
  expect(r?.cropRect).toEqual([95, 49.5, 160.5, 95])
  expect(r.cells).toBe(f.table.cells)
  expect(r.grid).toBe(f.table.grid)
  expect(r.issues).toBe(f.table.issues)
  expect(r.clipped).toBe(f.table.clipped)
  expect(ownedGlyphProof(r)).toBeDefined()
  expect(f.table).toEqual(before)
})
it.each(['missing source', 'different owner', 'foreign paint'])(
  'declines an uncaptioned native lattice without complete evidence: %s',
  (fault) => {
    const f = uncaptainedNativeLattice()
    if (fault === 'missing source') f.table.cells[0].sourceItems = []
    if (fault === 'different owner') f.table.cells[0].sourceItems[0].index = 3
    if (fault === 'foreign paint') f.context.nativePaintIdentityGraphics[0].operationIndex++
    expect(refine(f.table, f.rules, f.context)).toBeUndefined()
  }
)

// A complete native page, not a rectangle-only detector stub.
function nativeRuledMarker(
  kind: 'continuation' | 'panel' | 'footer',
  marginFiltered = false,
  captioned = false
): NativeHeaderFixtureData {
  const width = 299.3,
    height = 220,
    items: NativeHeaderFixtureData[] = [],
    operators: NativeHeaderFixtureData = { fnArray: [], argsArray: [] },
    graphics: NativeHeaderFixtureData[] = [],
    cells: NativeHeaderFixtureData[] = [],
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number): number[] => [x, height - y]
    }
  const box = (item: NativeHeaderFixtureData): number[] => [
    item.transform[4],
    height - item.transform[5] - 10,
    item.transform[4] + item.width,
    height - item.transform[5]
  ]
  function text(str: string, x: number, y: number): NativeHeaderFixtureData {
    const item = {
      str,
      dir: 'ltr',
      fontName: 'F',
      height: 10,
      width: str.length * 5,
      transform: [10, 0, 0, 10, x, height - y],
      sourceItem: { pageNumber: 1, index: items.length, text: str }
    }
    items.push(item)
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      ['F', 10],
      [[1, 0, 0, 1, x, height - y]],
      [Array.from(str, (c) => ({ unicode: c, fontChar: c, width: 500, isInFont: true }))],
      null
    )
    return item
  }
  function rule(y: number): void {
    const operationIndex = operators.fnArray.length + 3,
      rect = [20, y - 0.2, 280, y + 0.2]
    operators.fnArray.push(
      OPS.setStrokeRGBColor,
      OPS.setLineWidth,
      OPS.setLineCap,
      OPS.constructPath
    )
    operators.argsArray.push(
      ['#000000'],
      [0.4],
      [0],
      [OPS.stroke, [[0, 20, height - y, 1, 280, height - y]], [20, height - y, 280, height - y]]
    )
    graphics.push({ kind: 'path', operationIndex, rect })
  }
  if (kind === 'footer') captioned = true
  text(captioned ? 'Table 1. Values.' : 'Outside explanation', 20, 25)
  const marker = kind === 'panel' ? text('Panel B. Sample values', 25, 64) : null,
    grid = [
      ['Name', 'Value'],
      ['First', '5']
    ]
  for (const [row, line] of grid.entries()) {
    if (kind === 'footer') rule(row === 0 ? 40 : 70)
    for (const [column, label] of line.entries()) {
      const item = text(label, 40 + column * 150, (kind === 'panel' ? 80 : 60) + row * 40)
      cells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: label,
        sourceItems: [item.sourceItem],
        sourceRects: [box(item)]
      })
    }
  }
  if (kind === 'footer') rule(125)
  const hint =
    kind === 'continuation'
      ? text('continued on next page', 165, 140)
      : kind === 'footer'
        ? text('Summary 10', 40, 140)
        : null
  if (kind === 'footer') rule(150)
  const note = kind === 'footer' ? text('Notes: native values', 20, 175) : null
  if (kind === 'footer') for (const item of items) item.hasEOL = false
  if (kind !== 'footer') for (const y of kind === 'panel' ? [50, 90, 160] : [40, 70, 125]) rule(y)
  if (marginFiltered) rule(200)
  const content = { items, styles: { F: { ascent: 0.8, descent: -0.2, vertical: false } } }
  if (kind === 'footer') Object.assign(content.styles.F, { fontFamily: 'serif' })
  const bounds = graphics.map((g) => ({
      kind: g.kind,
      operationIndex: g.operationIndex,
      normalizedRect: g.rect.map((v: number, i: number) => v / (i % 2 ? height : width))
    })),
    context: NativeHeaderFixtureData = {
      content,
      sourceContent: content,
      viewport,
      captions: [],
      sourcePage: {
        pageNumber: 1,
        width,
        height,
        graphicsBounds: bounds,
        invalidGraphicsBounds: 0
      },
      rulePaintBounds: new Map(),
      nativeEvidenceGraphics: graphics
        .filter((g) => !marginFiltered || g.rect[1] < 190)
        .map((g) => ({ kind: g.kind, rect: g.rect })),
      nativePaintIdentityGraphics: graphics.filter((g) => !marginFiltered || g.rect[1] < 190),
      nativeGlyphContext: {
        pageNumber: 1,
        sourceSha256: 'a'.repeat(64),
        content: structuredClone(content),
        viewport,
        operators,
        graphicsBounds: bounds,
        skippedSpaceGlyphs: [],
        glyphBounds: [
          {
            fontName: 'F',
            glyphs: [...new Set(items.flatMap((i) => Array.from(i.str)))].map((c) => ({
              fontChar: c,
              bounds: c === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7]
            }))
          }
        ]
      }
    }
  const table: NativeHeaderFixtureData = {
    id: 'table',
    page: 1,
    cropRect: kind === 'panel' ? [15, 60, 285, 165] : [15, 35, 285, 137.5],
    sourceViewport: { width, height, scale: 1 },
    grid,
    cells,
    notes: [],
    unassigned: [],
    clipped: marker ? [{ text: marker.str, rect: box(marker) }] : [],
    issues: marker ? ['text-crosses-crop-boundary'] : [],
    reviewCandidate: false
  }
  if (kind === 'footer') {
    table.unassigned = [hint.str]
    table.clipped = [{ text: hint.str, rect: box(hint) }]
    table.issues = [
      'text-crosses-crop-boundary',
      'unassigned-source-text',
      'native-table-structure-ambiguous'
    ]
    table.selectedTextItems = cells.length + 1
    table.notes = [{ text: note.str, rect: box(note) }]
  }
  if (captioned) {
    const item = items[0],
      caption = { page: 1, text: item.str, lines: [item.str], rect: box(item) }
    table.caption = caption
    context.captions = [caption]
  }
  return {
    table,
    context,
    rules: bottomStripRules(operators, viewport, context.rulePaintBounds),
    marker: marker ?? hint
  }
}
it.each(['continuation', 'panel'] as const)(
  'completes an exclusive native ruled %s marker without changing content',
  (kind) => {
    const f = nativeRuledMarker(kind),
      before = structuredClone(f.table),
      r = refineMarker(f.table, f.rules, f.context)
    expect(r?.cropRect).toEqual(kind === 'panel' ? [15, 49.5, 285, 165] : [15, 35, 285, 140.25])
    expect({ ...r, cropRect: before.cropRect }).toEqual(before)
    expect(r.cells).toBe(f.table.cells)
    expect(r.notes).toBe(f.table.notes)
    expect(ownedGlyphProof(r)).toBeDefined()
    expect(f.table).toEqual(before)
  }
)
it.each(['continuation', 'panel'] as const)(
  'declines a %s marker without complete original ownership and paint',
  (kind) => {
    for (const fault of ['source', 'native identity', 'stroke', 'foreign header']) {
      const f = nativeRuledMarker(kind)
      if (fault === 'source') f.table.cells[0].sourceItems[0].text += '!'
      if (fault === 'native identity') f.context.nativePaintIdentityGraphics[0].operationIndex++
      if (fault === 'stroke')
        f.context.nativeGlyphContext.operators.argsArray[
          f.context.nativePaintIdentityGraphics[0].operationIndex
        ][0] = OPS.fillStroke
      if (fault === 'foreign header') {
        f.table.cells.shift()
        f.table.grid[0][0] = ''
      }
      const r = refineMarker(f.table, f.rules, f.context)
      expect(ownedGlyphProof(r)).toBeUndefined()
      expect(r?.cropRect ?? f.table.cropRect).toEqual(f.table.cropRect)
    }
  }
)

it.each(['continuation', 'panel'] as const)(
  'protects complete native paint when margin filtering omits an external stroke: %s',
  (kind) => {
    const f = nativeRuledMarker(kind, true),
      r = refineMarker(f.table, f.rules, f.context)
    expect(r?.cropRect).toEqual(kind === 'panel' ? [15, 49.5, 285, 165] : [15, 35, 285, 140.25])
    expect(ownedGlyphProof(r)).toBeDefined()
  }
)

it.each(['continuation', 'panel'] as const)(
  'uses the original page multiplication order for scaled native paint: %s',
  (kind) => {
    const f = nativeRuledMarker(kind, true),
      n = f.context.nativeGlyphContext,
      scale = 1.5,
      width = n.viewport.width * scale,
      height = n.viewport.height * scale
    f.context.viewport = {
      ...n.viewport,
      width,
      height,
      scale,
      transform: [scale, 0, 0, -scale, 0, height],
      convertToViewportPoint: (x: number, y: number): number[] => [x * scale, height - y * scale]
    }
    f.table.sourceViewport = { width, height, scale }
    f.table.cropRect = f.table.cropRect.map((v: number) => v * scale)
    for (const c of f.table.cells)
      c.sourceRects = c.sourceRects.map((r: number[]) => r.map((v) => v * scale))
    for (const c of f.table.clipped) c.rect = c.rect.map((v: number) => v * scale)
    const all = n.graphicsBounds.map((g: NativeHeaderFixtureData) => ({
      kind: g.kind,
      operationIndex: g.operationIndex,
      rect: g.normalizedRect.map(
        (v: number, i: number) => v * (i % 2 ? n.viewport.height : n.viewport.width) * scale
      )
    }))
    f.context.nativePaintIdentityGraphics = all.slice(0, -1)
    f.context.nativeEvidenceGraphics = all
      .slice(0, -1)
      .map((g: NativeHeaderFixtureData) => ({ kind: g.kind, rect: g.rect }))
    f.context.rulePaintBounds = new Map()
    f.rules = bottomStripRules(n.operators, f.context.viewport, f.context.rulePaintBounds)
    const r = refineMarker(f.table, f.rules, f.context)
    expect(r?.cropRect).toEqual(
      (kind === 'panel' ? [15, 49.5, 285, 165] : [15, 35, 285, 140.25]).map((v) => v * scale)
    )
    expect(ownedGlyphProof(r)).toBeDefined()
  }
)

it('leaves a captioned peer to its existing downstream crop family', () => {
  const f = nativeRuledMarker('panel', false, true),
    before = structuredClone(f.table)
  expect(refineMarker(f.table, f.rules, f.context)).toBeUndefined()
  expect(f.table).toEqual(before)
})

const { retainNativeRecoveryInputs: markerOutputEpoch } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-figure-recovery-profile.mjs')).href
)

it('finishes an existing peer image before publishing an overlapping native marker image', async () => {
  const f = nativeRuledMarker('panel'),
    n = f.context.nativeGlyphContext,
    items = f.context.content.items,
    operators = n.operators,
    width = n.viewport.width,
    height = n.viewport.height,
    first = items[0],
    captionText = 'Table 1. Values.'
  first.str = captionText
  first.width = captionText.length * 5
  first.sourceItem.text = captionText
  operators.argsArray[3] = [
    Array.from(captionText, (c) => ({
      unicode: c,
      fontChar: c,
      width: 500,
      isInFont: true,
      isSpace: c === ' '
    }))
  ]
  const peerCells: NativeHeaderFixtureData[] = []
  for (let row = 0; row < 2; row++)
    for (let column = 0; column < 5; column++) {
      const str = (row ? 'v' : 'h') + column,
        x = 35 + column * 45,
        y = row ? 47 : 37,
        item = {
          str,
          dir: 'ltr',
          fontName: 'F',
          height: 4,
          width: str.length * 2,
          transform: [4, 0, 0, 4, x, height - y],
          sourceItem: { pageNumber: 1, index: items.length, text: str }
        }
      items.push(item)
      operators.fnArray.push(
        OPS.beginText,
        OPS.setFont,
        OPS.setTextMatrix,
        OPS.showText,
        OPS.endText
      )
      operators.argsArray.push(
        null,
        ['F', 4],
        [[1, 0, 0, 1, x, height - y]],
        [Array.from(str, (c) => ({ unicode: c, fontChar: c, width: 500, isInFont: true }))],
        null
      )
      peerCells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: str,
        sourceItems: [item.sourceItem],
        sourceRects: [[x, y - 4, x + item.width, y]]
      })
    }
  for (const y of [30, 40]) {
    const operationIndex = operators.fnArray.length + 3
    operators.fnArray.push(
      OPS.setStrokeRGBColor,
      OPS.setLineWidth,
      OPS.setLineCap,
      OPS.constructPath
    )
    operators.argsArray.push(
      ['#000000'],
      [0.4],
      [0],
      [OPS.stroke, [[0, 20, height - y, 1, 280, height - y]], [20, height - y, 280, height - y]]
    )
    n.graphicsBounds.push({
      kind: 'path',
      operationIndex,
      normalizedRect: [20 / width, (y - 0.2) / height, 280 / width, (y + 0.2) / height]
    })
  }
  n.content = structuredClone(f.context.content)
  n.glyphBounds = [
    {
      fontName: 'F',
      glyphs: [...new Set(items.flatMap((i: NativeHeaderFixtureData) => Array.from(i.str)))].map(
        (c) => ({ fontChar: c, bounds: c === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7] })
      )
    }
  ]
  f.context.operators = operators
  f.context.sourcePage.graphicsBounds = n.graphicsBounds
  f.context.nativePaintIdentityGraphics = n.graphicsBounds.map((g: NativeHeaderFixtureData) => ({
    kind: g.kind,
    operationIndex: g.operationIndex,
    rect: g.normalizedRect.map((v: number, i: number) => v * (i % 2 ? height : width))
  }))
  f.context.nativeEvidenceGraphics = f.context.nativePaintIdentityGraphics.map(
    (g: NativeHeaderFixtureData) => ({ kind: g.kind, rect: g.rect })
  )
  f.context.rulePaintBounds = new Map()
  f.rules = bottomStripRules(operators, f.context.viewport, f.context.rulePaintBounds)
  const caption = {
      page: 1,
      text: captionText,
      lines: [captionText],
      rect: [20, 15, 20 + first.width, 25]
    },
    peer = {
      id: 'peer',
      page: 1,
      cropRect: [15, 30.25, 285, 49.75],
      sourceViewport: f.table.sourceViewport,
      caption,
      grid: [peerCells.slice(0, 5).map((c) => c.text), peerCells.slice(5).map((c) => c.text)],
      cells: peerCells,
      selectedTextItems: 10,
      notes: [],
      unassigned: [],
      clipped: [],
      issues: ['unassigned-source-text']
    },
    before = structuredClone(peer),
    base = bottomStripExample(),
    Info = base.paths.values().next().value.constructor,
    compiled = new Map(
      n.glyphBounds[0].glyphs.map((g: NativeHeaderFixtureData) => [
        g.fontChar,
        { getBounds: (): number[] => [...g.bounds] }
      ])
    )
  base.font.getPathGenerator = (_objs: unknown, c: string): NativeHeaderFixtureData =>
    compiled.get(c)
  for (const g of n.glyphBounds[0].glyphs) base.paths.set('F_path_' + g.fontChar, new Info())
  f.context.captions = [caption]
  const render = async (r: number[]): Promise<Buffer> => {
    const s = 4,
      canvas = createCanvas(Math.ceil((r[2] - r[0]) * s), Math.ceil((r[3] - r[1]) * s)),
      ctx = canvas.getContext('2d')
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = 'black'
    for (const g of f.context.nativePaintIdentityGraphics) {
      const q = g.rect
      ctx.fillRect((q[0] - r[0]) * s, (q[1] - r[1]) * s, (q[2] - q[0]) * s, (q[3] - q[1]) * s)
    }
    for (const item of items)
      for (const [i, c] of Array.from(item.str as string).entries())
        if (c !== ' ')
          ctx.fillRect(
            (item.transform[4] + i * item.height * 0.5 - r[0]) * s,
            (height - item.transform[5] - item.height * 0.7 - r[1]) * s,
            item.height * 0.5 * s,
            item.height * 0.7 * s
          )
    return canvas.toBuffer('image/png')
  }
  const peerProof = proveCaptionStrip(peer, f.rules, f.context, {
    page: f.context.sourcePage,
    nativePage: base.options.nativePage,
    nativeContent: n.content,
    captions: [caption],
    otherFigures: [],
    competingRects: [f.table.cropRect]
  })
  expect(peerProof).toBeDefined()
  const peerPng = await renderCaptionStrip(peerProof, render),
    publishedPeer = commitCaptionStrip(peerProof, peerPng)
  expect(publishedPeer?.cropRect).toEqual([19.75, 29.5, 280.25, 50.5])
  const peerBytes = Buffer.from(peerPng),
    peerPublished = structuredClone(publishedPeer),
    target = refineMarker(f.table, f.rules, f.context),
    proof = ownedGlyphProof(target),
    png = await render(proof.nativeCrop)
  expect(target?.cropRect).toEqual([15, 49.5, 285, 165])
  expect(ownedGlyphPng(proof, png, target)).toBe(true)
  expect(publishedPeer).toEqual(peerPublished)
  expect(peerPng.equals(peerBytes)).toBe(true)
  expect({ ...publishedPeer, cropRect: before.cropRect, region: undefined }).toEqual({
    ...before,
    region: undefined
  })
  for (const field of ['region', 'extra metadata']) {
    const published: NativeHeaderFixtureData = { ...target, region: [0.1, 0.2, 0.9, 0.8] },
      epoch = markerOutputEpoch([published], f.context.viewport)
    expect(epoch?.()).toBe(true)
    if (field === 'region') published.region[0] += 0.01
    else published.extraMetadata = 'changed'
    expect(epoch?.()).toBe(false)
  }
  const originalCells = f.table.cells
  originalCells[0].text += '!'
  expect(ownedGlyphPng(proof, png, target)).toBe(false)
})
// One anonymous paused table reuses the complete native font/path fixture.
it('completes a native unassigned footer while preserving every old content field', () => {
  const f = nativeRuledMarker('footer'),
    before = structuredClone(f.table),
    next = refineFooter?.(f.table, f.rules, f.context)
  expect(next).toBeDefined()
  expect(next.cropRect[3]).toBeGreaterThan(150.2)
  const proof = ownedGlyphProof(next),
    canvas = createCanvas(
      Math.ceil((next.cropRect[2] - next.cropRect[0]) * 4),
      Math.ceil((next.cropRect[3] - next.cropRect[1]) * 4)
    )
  expect(ownedGlyphPng(proof, canvas.toBuffer('image/png'), next)).toBe(true)
  expect({ ...next, cropRect: before.cropRect }).toEqual(before)
  expect(next.cells).toBe(f.table.cells)
  expect(next.notes).toBe(f.table.notes)
  expect(ownedGlyphFallback(proof, next)).toEqual(before.cropRect)
  next.region = [0, 0, 1, 1]
  expect(ownedGlyphFallback(proof, next)).toBeUndefined()
  canvas.width = canvas.height = 1
})
it.each(['mapped', 'foreign-note', 'source-alias', 'white-stroke', 'unknown-stroke', 'stale'])(
  'declines an unassigned footer with %s evidence',
  (fault) => {
    const f = nativeRuledMarker('footer')
    if (fault === 'mapped') f.table.reviewCandidate = true
    if (fault === 'foreign-note') {
      const note = f.context.sourceContent.items.at(-1)
      note.transform[5] += 27
      f.context.nativeGlyphContext.content.items.at(-1).transform[5] += 27
    }
    if (fault === 'source-alias') f.table.clipped[0].text = 'different literal'
    if (fault === 'white-stroke')
      f.context.nativeGlyphContext.operators.argsArray[
        f.context.nativeGlyphContext.operators.fnArray.indexOf(OPS.setStrokeRGBColor)
      ] = ['#ffffff']
    if (fault === 'unknown-stroke')
      f.context.nativeGlyphContext.operators.fnArray[
        f.context.nativeGlyphContext.operators.fnArray.indexOf(OPS.setStrokeRGBColor)
      ] = OPS.setStrokeGray
    const next = refineFooter?.(f.table, f.rules, f.context)
    if (fault === 'stale') {
      expect(next).toBeDefined()
      const proof = ownedGlyphProof(next)
      f.table.notes[0].text = 'changed'
      expect(ownedGlyphFallback(proof, next)).toBeUndefined()
    } else expect(next).toBeUndefined()
  }
)

it('requires a complete native advance for the following paragraph even when its scoped page packet closes', async () => {
  const f = uncaptainedNativeLattice(true),
    c = f.context,
    n = c.nativeGlyphContext
  for (const i of [c.content.items[5], n.content.items[5]]) {
    i.str += ' '
    i.width += 5
    i.sourceItem.text = i.str
  }
  n.operators.argsArray[28][0].push({ unicode: ' ', fontChar: ' ', width: 500, isInFont: true })
  const { nativePageTextPacketInventory } = await import(
    pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
  )
  const { tableTextToken } = await import(
    pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
  )
  const tokens = n.content.items
    .filter((i: NativeHeaderFixtureData) => i.str.trim())
    .map((i: NativeHeaderFixtureData) => tableTextToken(i, c.viewport, 0))
  const claims = new Set(
    f.table.cells.flatMap((cell: NativeHeaderFixtureData) =>
      cell.sourceItems.map((s: NativeHeaderFixtureData) => s.index)
    )
  )
  const packet = nativePageTextPacketInventory(c.sourcePage, tokens, n, true, claims)
  expect(packet).toBeDefined()
  expect(packet.records.find((r: NativeHeaderFixtureData) => r.index === 5).advanceComplete).toBe(
    false
  )
  expect(ownedGlyphProof(refineVisual(f.table, nativeLatticeItems(f), f.rules, c))).toBeUndefined()
})

function nativeLatticeItems(f: NativeHeaderFixtureData): NativeHeaderFixtureData[] {
  return f.context.content.items.map((i: NativeHeaderFixtureData) => ({
    text: i.str,
    sourceItem: i.sourceItem,
    height: i.height,
    baseline: f.context.viewport.height - i.transform[5],
    horizontal: true,
    rect: [
      i.transform[4],
      f.context.viewport.height - i.transform[5] - i.height,
      i.transform[4] + i.width,
      f.context.viewport.height - i.transform[5]
    ]
  }))
}

const { tableTextToken: headerPixelToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- anonymous native page
function oneSourceHeaderPixels(kind = 'normal') {
  const width = 220,
    height = 200,
    scale = 1.5,
    items: {
      str: string
      dir: string
      width: number
      height: number
      transform: number[]
      fontName: string
      sourceItem: { pageNumber: number; index: number; text: string }
    }[] = [],
    glyphs: { fontChar: string; bounds: number[] }[] = [],
    operators: { fnArray: number[]; argsArray: unknown[] } = { fnArray: [], argsArray: [] },
    graphics: { kind: string; operationIndex: number; normalizedRect: number[] }[] = []
  const add = (op: number, a: unknown): void => {
    operators.fnArray.push(op)
    operators.argsArray.push(a)
  }
  const text = (str: string, x: number, y: number): number => {
    add(OPS.beginText, null)
    add(OPS.setFont, ['F', 8])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - y]])
    add(OPS.showText, [
      [...str].map((c) =>
        c === ' ' ? -500 : { unicode: c, fontChar: c, width: 500, isInFont: true }
      )
    ])
    add(OPS.endText, null)
    const index = items.length
    items.push({
      str,
      dir: 'ltr',
      width: [...str].length * 4,
      height: 8,
      transform: [8, 0, 0, 8, x, height - y],
      fontName: 'F',
      sourceItem: { pageNumber: 1, index, text: str }
    })
    for (const c of str)
      if (!glyphs.some((g) => g.fontChar === c))
        glyphs.push({ fontChar: c, bounds: [0, -0.1, 0.5, 0.7] })
    return index
  }
  const line = (x0: number, y0: number, x1: number, y1: number): void => {
    add(OPS.constructPath, [
      OPS.stroke,
      [[0, x0, height - y0, 1, x1, height - y1]],
      [Math.min(x0, x1), height - Math.max(y0, y1), Math.max(x0, x1), height - Math.min(y0, y1)]
    ])
    graphics.push({
      kind: 'path',
      operationIndex: operators.fnArray.length - 1,
      normalizedRect: [
        (Math.min(x0, x1) - (x0 === x1 ? 0.2 : 0)) / width,
        (Math.min(y0, y1) - (y0 === y1 ? 0.2 : 0)) / height,
        (Math.max(x0, x1) + (x0 === x1 ? 0.2 : 0)) / width,
        (Math.max(y0, y1) + (y0 === y1 ? 0.2 : 0)) / height
      ]
    })
  }
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.4])
  text('Unrelated paragraph', 20, 18)
  const header = text('Level Test Accuracy Stable Repetitions', 22, 42)
  if (kind === 'duplicate') text(items[header].str, 22, 42)
  if (kind === 'foreign') text('Other', 170, 36)
  if (kind !== 'missing-rule') line(20, 46, 180, 46)
  const body: number[] = []
  for (let row = 0; row < 5; row++)
    for (const [column, value] of [
      [0, row ? '10−' + row : '0'],
      [1, '70% ± 1'],
      [2, '3/5']
    ] as const)
      body.push(text(value, [30, 80, 130][column], 58 + row * 16))
  line(20, 126, 180, 126)
  for (let n = 0; n < 6; n++) {
    const a = 35 + n * 15,
      b = 45.8 + n * 15
    line(64, n % 2 ? a : b, 64, n % 2 ? b : a)
  }
  const cap = text('TABLE A3: Scores', 20, 150)
  text('Following paragraph', 20, 178)
  const nativeViewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number) => [x, height - y]
    },
    viewport = {
      width: width * scale,
      height: height * scale,
      scale,
      rotation: 0,
      transform: [scale, 0, 0, -scale, 0, height * scale],
      convertToViewportPoint: (x: number, y: number) => [x * scale, (height - y) * scale]
    },
    content = { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
    tokens = items.map((r) => headerPixelToken(r, viewport, 0)),
    rulePaintBounds = new Map<string, number[]>(),
    rules = bottomStripRules(operators, viewport, rulePaintBounds),
    cells = body.map((index, i) => ({
      row: Math.floor(i / 3),
      column: i % 3,
      rowSpan: 1,
      colSpan: 1,
      text: items[index].str,
      sourceItems: [items[index].sourceItem],
      sourceRects: [tokens[index].rect]
    })),
    native = {
      operators,
      content,
      glyphBounds: [{ fontName: 'F', glyphs }],
      graphicsBounds: graphics,
      viewport: nativeViewport,
      pageNumber: 1,
      sourceSha256: 'a'.repeat(64)
    },
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, graphicsBounds: graphics },
    context = {
      nativeGlyphContext: native,
      sourcePage: page,
      sourceContent: content,
      content,
      viewport,
      rulePaintBounds,
      nativeEvidenceGraphics: graphics.map((g) => ({
        kind: g.kind,
        rect: g.normalizedRect.map((n, i) => n * (i % 2 ? height : width) * scale)
      })),
      nativePaintIdentityGraphics: graphics.map((g) => ({
        kind: g.kind,
        operationIndex: g.operationIndex,
        rect: g.normalizedRect.map((n, i) => n * (i % 2 ? height : width) * scale)
      }))
    },
    table = {
      id: 'anonymous-table',
      page: 1,
      cropRect: [18, 39, 152, 132].map((n) => n * scale),
      grid: Array.from({ length: 5 }, (_, r) => cells.slice(r * 3, r * 3 + 3).map((c) => c.text)),
      cells,
      unassigned: [],
      clipped: [{ text: items[header].str, rect: tokens[header].rect }],
      issues: ['text-crosses-crop-boundary'],
      repairs: [],
      reviewCandidate: false,
      notes: [],
      caption: {
        page: 1,
        text: items[cap].str,
        rect: headerPixelToken(items[cap], nativeViewport, 0).rect
      },
      sourceViewport: { width: viewport.width, height: viewport.height, scale }
    }
  const png = (crop: number[], factor = 4): Buffer => {
    const r = crop.map((n) => n / scale),
      c = createCanvas(Math.ceil((r[2] - r[0]) * factor), Math.ceil((r[3] - r[1]) * factor)),
      x = c.getContext('2d')
    x.fillStyle = 'white'
    x.fillRect(0, 0, c.width, c.height)
    x.fillStyle = 'black'
    x.fillRect(2, 2, c.width - 4, c.height - 4)
    const out = c.toBuffer('image/png')
    c.width = c.height = 1
    return out
  }
  return { table, context, tokens, rules, header, items, png }
}

it('completes one whole unclaimed native header image without changing existing cells or metadata', () => {
  const f = oneSourceHeaderPixels(),
    before = JSON.stringify(f.table),
    out = refine(f.table, f.rules, f.context)
  expect(out).toBeDefined()
  expect(out.cropRect[1]).toBeLessThan(f.table.cropRect[1])
  expect(out.cropRect[2]).toBeGreaterThan(f.table.cropRect[2])
  expect(out.cropRect[0]).toBe(f.table.cropRect[0])
  expect(out.cropRect[3]).toBe(f.table.cropRect[3])
  for (const k of Object.keys(f.table) as (keyof typeof f.table)[])
    if (k !== 'cropRect') expect(out[k]).toBe(f.table[k])
  expect(JSON.stringify(f.table)).toBe(before)
  expect(
    out.cells
      .flatMap((c: (typeof f.table.cells)[number]) => c.sourceItems)
      .some((s: { index: number }) => s.index === f.header)
  ).toBe(false)
  const proof = ownedGlyphProof(out)
  expect(proof).toBeDefined()
  expect(ownedGlyphPng(proof, f.png(out.cropRect), out)).toBe(true)
})
it('declines the unclaimed-header pixel family without the original separator', () => {
  const f = oneSourceHeaderPixels('missing-rule')
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
})
it('retains overlapping foreign text when proving the unclaimed-header pixels', () => {
  const f = oneSourceHeaderPixels('foreign')
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
})
it('requires a unique complete native header Source instead of duplicate words', () => {
  const f = oneSourceHeaderPixels('duplicate')
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
})
it('revokes unclaimed-header pixel proof on cloned metadata or stale native inputs', () => {
  const f = oneSourceHeaderPixels(),
    out = refine(f.table, f.rules, f.context),
    proof = ownedGlyphProof(out)
  expect(proof).toBeDefined()
  const png = f.png(out.cropRect)
  expect(ownedGlyphProof({ ...out })).toBeUndefined()
  expect(ownedGlyphPng(proof, png, { ...out, grid: structuredClone(out.grid) })).toBe(false)
  expect(ownedGlyphPng(proof, f.png(out.cropRect, 1), out)).toBe(false)
  f.items[f.header].width += 1
  expect(ownedGlyphPng(proof, png, out)).toBe(false)
})
// One closing stroke and a multi-line caption whose real descender crosses the
// old crop. A rotated foreign owner remains in the complete page inventory.
function singleClosingCaptionExample(fault = ''): ReturnType<typeof JSON.parse> {
  type Evidence = ReturnType<typeof JSON.parse>
  const f = bottomStripExample(),
    base = f.context.sourceContent.items[0],
    items = [
      { ...base },
      { ...base, str: 'i', width: 5, transform: [10, 0, 0, 10, 10, 90] },
      ...Array.from({ length: 12 }, (_, i) => ({
        ...base,
        str: 'i',
        width: 5,
        transform: [
          10,
          0,
          0,
          10,
          10 + (i % 4) * 24,
          76.1 - (fault === 'top rail' ? 10 : 0) - Math.floor(i / 4) * 20
        ]
      })),
      {
        ...base,
        str: 'i',
        width: 5,
        transform:
          fault === 'foreign ink'
            ? [0, 10, -10, 0, 15, 75]
            : [0, 10, -10, 0, 15, fault === 'top rail' ? 2 : 15]
      },
      { ...base, str: '', width: 0, height: 0, transform: [10, 0, 0, 10, 70, 10] },
      {
        ...base,
        str: '',
        width: 5,
        transform:
          fault === 'blank envelope'
            ? [10, 0, 0, 10, 10, 75]
            : [10, 0, 0, 10, 70, fault === 'top rail' ? 2 : 10]
      }
    ].map((r, index) => ({ ...r, sourceItem: { pageNumber: 1, index, text: r.str } })),
    content = { styles: f.context.sourceContent.styles, items },
    operators: Evidence = { fnArray: [], argsArray: [] },
    graphics: Evidence[] = [],
    add = (op: number, args: unknown[]): number => {
      operators.fnArray.push(op)
      return operators.argsArray.push(args) - 1
    }
  add(OPS.setLineWidth, [1])
  add(OPS.setStrokeRGBColor, ['#000000'])
  for (const y of fault === 'duplicate closing'
    ? [90, 92]
    : fault === 'top rail'
      ? [33, 100]
      : [90]) {
    const operationIndex = add(OPS.constructPath, [
      OPS.stroke,
      [Float32Array.from([0, 1, 120 - y, 1, 99, 120 - y])],
      [1, 120 - y, 99, 120 - y]
    ])
    graphics.push({
      kind: 'path',
      operationIndex,
      normalizedRect: [0.01, (y - 0.5) / 120, 0.99, (y + 0.5) / 120]
    })
  }
  for (const item of items) {
    add(OPS.beginText, [])
    add(OPS.setFont, ['F', 10])
    add(OPS.setTextMatrix, [
      [...item.transform.slice(0, 4).map((x: number) => x / 10), ...item.transform.slice(4)]
    ])
    add(OPS.showText, [
      Array.from(item.str as string, (c) => ({
        unicode: c,
        fontChar: c,
        width: 500,
        isInFont: true,
        isSpace: c === ' '
      }))
    ])
    add(OPS.endText, [])
  }
  const native = f.context.nativeGlyphContext
  native.content = structuredClone(content)
  native.operators = operators
  native.graphicsBounds = graphics
  delete native.skippedSpaceGlyphs
  f.context.sourceContent = content
  f.context.content = content
  f.context.operators = structuredClone(operators)
  f.rules = bottomStripRules(operators, f.context.viewport, (f.context.rulePaintBounds = new Map()))
  f.options.page.graphicsBounds = graphics
  f.options.nativeContent = structuredClone(content)
  f.options.otherFigures = []
  f.table.caption = {
    page: 1,
    text: 'Table 1: Example i',
    lines: ['Table 1: Example', 'i'],
    rect: [10, 10, 90, 30]
  }
  f.options.captions = [{ ...f.table.caption }]
  f.table.cropRect = [5, 32.5, 95, fault === 'top rail' ? 101 : fault === 'unowned note' ? 110 : 91]
  f.table.issues = []
  f.table.clipped = []
  f.table.unassigned = []
  f.table.notes = []
  f.table.grid = Array.from({ length: 3 }, () => ['i', 'i', 'i', 'i'])
  f.table.selectedTextItems = 12
  f.table.cells = items.slice(2, 14).map((r, i) => ({
    row: Math.floor(i / 4),
    column: i % 4,
    text: 'i',
    sourceItems: [r.sourceItem],
    sourceRects: [
      [r.transform[4], 120 - r.transform[5] - 10, r.transform[4] + 5, 120 - r.transform[5]]
    ]
  }))
  f.renderCrop = async (r: number[], parts?: number[][]): Promise<Buffer> => {
    const s = 4,
      c = createCanvas(Math.ceil((r[2] - r[0]) * s), Math.ceil((r[3] - r[1]) * s)),
      ctx = c.getContext('2d')
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, c.width, c.height)
    if (parts) {
      ctx.beginPath()
      for (const p of parts)
        ctx.rect((p[0] - r[0]) * s, (p[1] - r[1]) * s, (p[2] - p[0]) * s, (p[3] - p[1]) * s)
      ctx.clip()
    }
    ctx.fillStyle = 'black'
    ctx.fillRect((1 - r[0]) * s, (89.5 - r[1]) * s, 98 * s, s)
    for (const item of items.slice(0, 14))
      for (const [j, char] of Array.from(item.str as string).entries())
        if (char !== ' ')
          ctx.fillRect(
            (item.transform[4] + j * 5 - r[0]) * s,
            (120 - item.transform[5] - 8 - r[1]) * s,
            5 * s,
            11 * s
          )
    return c.toBuffer('image/png')
  }
  return f
}

it('masks only foreign caption ink while keeping the complete single-rule table sources and pixels', async () => {
  const f = singleClosingCaptionExample(),
    before = structuredClone(f.table),
    proof = proveCaptionStrip(f.table, f.rules, f.context, f.options)
  expect(proof).toBeDefined()
  expect(proof.nativeCrop[1]).toBeLessThan(proof.regions[0][1])
  const png = await renderCaptionStrip(proof, f.renderCrop),
    next = commitCaptionStrip(proof, png)
  expect(png).toBeDefined()
  expect(next).toBeDefined()
  expect({ ...next, cropRect: before.cropRect, region: before.region }).toEqual({
    ...before,
    region: before.region
  })
  expect(next.cells).toBe(f.table.cells)
  expect(next.grid).toBe(f.table.grid)
  expect(f.table).toEqual(before)
})
it('keeps a rotated foreign glyph in the exclusion domain of the single closing-rule crop', () => {
  const f = singleClosingCaptionExample('foreign ink')
  expect(proveCaptionStrip(f.table, f.rules, f.context, f.options)).toBeUndefined()
})
it('refuses two plausible closing strokes rather than choosing by array order', () => {
  const f = singleClosingCaptionExample('duplicate closing')
  expect(proveCaptionStrip(f.table, f.rules, f.context, f.options)).toBeUndefined()
})
it('requires every selected whole Source claim and its original glyph outline', () => {
  const f = singleClosingCaptionExample()
  f.table.cells[0].sourceItems = []
  f.table.cells[0].sourceRects = []
  expect(proveCaptionStrip(f.table, f.rules, f.context, f.options)).toBeUndefined()
  const g = singleClosingCaptionExample()
  g.context.nativeGlyphContext.glyphBounds[0].glyphs =
    g.context.nativeGlyphContext.glyphBounds[0].glyphs.filter(
      (x: { fontChar: string }) => x.fontChar !== 'i'
    )
  expect(proveCaptionStrip(g.table, g.rules, g.context, g.options)).toBeUndefined()
})
it('rejects borrowed plans and revokes the single-rule proof after a retained foreign source changes', async () => {
  const f = singleClosingCaptionExample(),
    proof = proveCaptionStrip(f.table, f.rules, f.context, f.options)
  expect(proof).toBeDefined()
  expect(await renderCaptionStrip(structuredClone(proof), f.renderCrop)).toBeUndefined()
  const sourceContent = f.context.sourceContent,
    nativeContent = f.options.nativeContent
  f.context.sourceContent = structuredClone(sourceContent)
  expect(await renderCaptionStrip(proof, f.renderCrop)).toBeUndefined()
  f.context.sourceContent = sourceContent
  f.options.nativeContent = structuredClone(nativeContent)
  expect(await renderCaptionStrip(proof, f.renderCrop)).toBeUndefined()
  f.options.nativeContent = nativeContent
  f.context.nativeGlyphContext.content.items.at(-1).width++
  expect(await renderCaptionStrip(proof, f.renderCrop)).toBeUndefined()
})
it('binds the masked single-rule PNG bytes through the final synchronous commit', async () => {
  const f = singleClosingCaptionExample(),
    proof = proveCaptionStrip(f.table, f.rules, f.context, f.options),
    png = await renderCaptionStrip(proof, f.renderCrop)
  expect(png).toBeDefined()
  expect(commitCaptionStrip(proof, Buffer.from(png))).toBeUndefined()
  png[100] ^= 1
  expect(commitCaptionStrip(proof, png)).toBeUndefined()
})

it('retains blank foreign source envelopes even when they have no packet record', () => {
  const f = singleClosingCaptionExample('blank envelope')
  expect(proveCaptionStrip(f.table, f.rules, f.context, f.options)).toBeUndefined()
})

it.each(['top rail', 'unowned note'])(
  'declines deleting old crop content without its own caption provenance: %s',
  (fault) => {
    const f = singleClosingCaptionExample(fault)
    expect(proveCaptionStrip(f.table, f.rules, f.context, f.options)).toBeUndefined()
  }
)

// The source packet remains strict; this purpose may retain an unreliable image.
const {
  createNativeSingleClosingTablePixelEvidence: singleClosingPixels,
  nativeSingleClosingTablePixelEvidenceData: singleClosingPixelData,
  nativePageTextPacketInventory: strictSingleClosingPage,
  nativeFigurePaintCertificateData: singleClosingPaintData,
  nativeSavedUncoloredPixelEvidenceData: unrelatedSingleClosingData
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)

function unreliableSingleClosingPixels(fault = ''): ReturnType<typeof JSON.parse> {
  const f = singleClosingCaptionExample(fault),
    n = f.context.nativeGlyphContext,
    index = n.content.items.length,
    remote = {
      ...n.content.items[1],
      str: 'i ',
      width: 15,
      transform: [10, 0, 0, 10, 70, 5],
      sourceItem: { pageNumber: 1, index, text: 'i ' }
    }
  for (const content of [n.content, f.context.sourceContent, f.options.nativeContent])
    content.items.push(structuredClone(remote))
  n.operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
  n.operators.argsArray.push(
    [],
    ['F', 10],
    [[1, 0, 0, 1, 70, 5]],
    [
      [
        { unicode: 'i', fontChar: 'i', width: 500, isInFont: true, isSpace: false },
        { unicode: ' ', fontChar: ' ', width: 500, isInFont: true, isSpace: true }
      ]
    ],
    []
  )
  f.table.issues = ['overlapping-predicted-columns']
  f.pixelTokens = n.content.items
    .filter((r: ReturnType<typeof JSON.parse>) => r.str.trim())
    .map((r: ReturnType<typeof JSON.parse>) => headerPixelToken(r, n.viewport, 0))
  return f
}

it('keeps unreliable scalar metadata while restoring only a complete single-closing native image', async () => {
  const f = unreliableSingleClosingPixels(),
    before = structuredClone(f.table),
    proof = proveCaptionStrip(f.table, f.rules, f.context, f.options)
  expect(
    strictSingleClosingPage(f.options.page, f.pixelTokens, f.context.nativeGlyphContext)
  ).toBeUndefined()
  expect(proof).toBeDefined()
  const png = await renderCaptionStrip(proof, f.renderCrop),
    next = commitCaptionStrip(proof, png)
  expect(png).toBeDefined()
  expect(next).toBeDefined()
  expect({ ...next, cropRect: before.cropRect, region: before.region }).toEqual({
    ...before,
    region: before.region
  })
  expect(next.cells).toBe(f.table.cells)
  expect(next.issues).toBe(f.table.issues)
  expect(f.table).toEqual(before)
})
it('keeps the remote foreign raw envelope and distinct advance without granting a default packet', () => {
  const f = unreliableSingleClosingPixels(),
    n = f.context.nativeGlyphContext,
    handle = singleClosingPixels?.(f.options.page, f.pixelTokens, n, f.table),
    data = singleClosingPixelData?.(handle, f.options.page, f.pixelTokens, n, f.table)
  expect(proveCaptionStrip(f.table, f.rules, f.context, f.options)).toBeDefined()
  expect(handle).toBeDefined()
  expect(data).toBeDefined()
  const foreign = data.records.find(
    (r: ReturnType<typeof JSON.parse>) => r.index === n.content.items.length - 1
  )
  expect(foreign.r.str).toBe('i ')
  expect(foreign.rect[2]).toBe(85)
  expect(Math.max(...foreign.part.map((p: ReturnType<typeof JSON.parse>) => p.g.advance[2]))).toBe(
    75
  )
  expect(foreign.advanceComplete).toBe(false)
  expect(strictSingleClosingPage(f.options.page, f.pixelTokens, n)).toBeUndefined()
  expect(singleClosingPaintData(handle, f.options.page, f.pixelTokens, n)).toBeUndefined()
  expect(unrelatedSingleClosingData(handle, f.options.page, f.pixelTokens, n)).toBeUndefined()
})
it('requires whole original body literals, page identity, glyph outlines and advances in the pixel purpose', () => {
  for (const fault of ['advance', 'literal', 'page', 'font']) {
    const f = unreliableSingleClosingPixels(),
      n = f.context.nativeGlyphContext
    if (fault === 'advance') n.content.items[2].width += 2
    if (fault === 'literal') f.table.cells[0].sourceItems[0].text = 'different'
    if (fault === 'page') f.table.cells[0].sourceItems[0].pageNumber = 2
    if (fault === 'font')
      n.glyphBounds[0].glyphs = n.glyphBounds[0].glyphs.filter(
        (g: ReturnType<typeof JSON.parse>) => g.fontChar !== 'i'
      )
    expect(proveCaptionStrip(f.table, f.rules, f.context, f.options)).toBeUndefined()
  }
})
it('retains every foreign raw blank, rotated glyph and unknown old-crop path or note', () => {
  for (const fault of ['blank envelope', 'foreign ink', 'top rail', 'unowned note']) {
    const f = unreliableSingleClosingPixels(fault)
    expect(proveCaptionStrip(f.table, f.rules, f.context, f.options)).toBeUndefined()
  }
})
it('revokes unreliable pixel evidence on borrowed handles or source/context slot replacement', async () => {
  const f = unreliableSingleClosingPixels(),
    n = f.context.nativeGlyphContext,
    handle = singleClosingPixels?.(f.options.page, f.pixelTokens, n, f.table),
    proof = proveCaptionStrip(f.table, f.rules, f.context, f.options)
  expect(
    singleClosingPixelData?.({ ...handle }, f.options.page, f.pixelTokens, n, f.table)
  ).toBeUndefined()
  expect(
    singleClosingPixelData?.(handle, f.options.page, [...f.pixelTokens], n, f.table)
  ).toBeUndefined()
  expect(
    singleClosingPixelData?.(handle, f.options.page, f.pixelTokens, { ...n }, f.table)
  ).toBeUndefined()
  expect(
    singleClosingPixelData?.(handle, f.options.page, f.pixelTokens, n, { ...f.table })
  ).toBeUndefined()
  if (!proof) return
  const source = f.context.sourceContent,
    native = f.options.nativeContent
  f.context.sourceContent = structuredClone(source)
  expect(await renderCaptionStrip(proof, f.renderCrop)).toBeUndefined()
  f.context.sourceContent = source
  f.options.nativeContent = structuredClone(native)
  expect(await renderCaptionStrip(proof, f.renderCrop)).toBeUndefined()
  f.options.nativeContent = native
  proof.nativeCrop[0] -= 1
  expect(await renderCaptionStrip(proof, f.renderCrop)).toBeUndefined()
})
it('keeps old unreliable reasons outside the one exact pixel family', () => {
  for (const issues of [
    ['overlapping-predicted-columns', 'native-table-structure-ambiguous'],
    ['unassigned-source-text'],
    []
  ]) {
    const f = unreliableSingleClosingPixels()
    f.table.issues = issues
    expect(proveCaptionStrip(f.table, f.rules, f.context, f.options)).toBeUndefined()
  }
})

// Two complete native panels share one caption; scalar ownership stays unreliable.
function railPeerPixelExample(fault = ''): ReturnType<typeof JSON.parse> {
  type Evidence = ReturnType<typeof JSON.parse>
  const f = bottomStripExample(),
    height = 180,
    texts: [string, number, number][] = [
      ['Table 1: Complete comparison results for both panels', 10, 20],
      ['(a) Left', 40, 45.1],
      [fault === 'label' ? '(d) Right' : '(b) Right', 187.5, 45.1],
      ...[20, 170].flatMap((x) =>
        [65, 85, 109, 133].flatMap((y) =>
          [0, 24, 48, 72].map((dx): [string, number, number] => ['i', x + dx, y])
        )
      ),
      ...(fault === 'note' ? ([['i', 135, 90]] as [string, number, number][]) : [])
    ],
    items = texts.map(([str, x, y], index) => ({
      str,
      dir: 'ltr',
      width: str.length * 5,
      height: 10,
      fontName: 'F',
      transform: [10, 0, 0, 10, x, height - y],
      hasEOL: false,
      sourceItem: { pageNumber: 1, index, text: str }
    })),
    content = { styles: f.context.sourceContent.styles, items },
    viewport = {
      width: 280,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number): number[] => [x, height - y]
    },
    operators: Evidence = { fnArray: [], argsArray: [] },
    graphics: Evidence[] = [],
    rails: number[][] = [],
    add = (op: number, args: unknown[]): number => {
      operators.fnArray.push(op)
      return operators.argsArray.push(args) - 1
    }
  add(OPS.setLineWidth, [1])
  add(OPS.setStrokeRGBColor, ['#000000'])
  for (const x of [10, 160])
    for (const y of [55, 69, 93, 117, 141]) {
      if (fault === 'rail' && x === 10 && y === 93) continue
      const operationIndex = add(OPS.constructPath, [
        OPS.stroke,
        [Float32Array.from([0, x, height - y, 1, x + 100, height - y])],
        [x, height - y, x + 100, height - y]
      ])
      rails.push([x, y - 0.5, x + 100, y + 0.5])
      graphics.push({
        kind: 'path',
        operationIndex,
        normalizedRect: [x / 280, (y - 0.5) / height, (x + 100) / 280, (y + 0.5) / height]
      })
    }
  for (const item of items) {
    add(OPS.beginText, [])
    add(OPS.setFont, ['F', 10])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, ...item.transform.slice(4)]])
    add(OPS.showText, [
      Array.from(item.str, (c) =>
        c === ' '
          ? -500
          : {
              unicode: c,
              fontChar: c,
              width: 500,
              isInFont: true,
              isSpace: false
            }
      )
    ])
    add(OPS.endText, [])
  }
  const glyphs = [...new Set(items.flatMap((i) => [...i.str]))]
      .filter((c) => c !== ' ')
      .map((fontChar) => ({ fontChar, bounds: [0, -0.3, 0.5, 0.8] })),
    Info = f.paths.values().next().value.constructor
  for (const g of glyphs) f.paths.set('F_path_' + g.fontChar, new Info())
  const compiled = new Map(
    glyphs.map((g) => [g.fontChar, { getBounds: (): number[] => [...g.bounds] }])
  )
  f.font.getPathGenerator = (_: unknown, c: string): Evidence => compiled.get(c)
  Object.assign(f.context.nativeGlyphContext, {
    content: structuredClone(content),
    operators,
    viewport,
    graphicsBounds: graphics,
    glyphBounds: [{ fontName: 'F', glyphs }]
  })
  delete f.context.nativeGlyphContext.skippedSpaceGlyphs
  Object.assign(f.context, { sourceContent: content, content, viewport, operators })
  f.rules = bottomStripRules(operators, viewport, (f.context.rulePaintBounds = new Map()))
  Object.assign(f.options.page, { width: 280, height, graphicsBounds: graphics })
  Object.assign(f.options, {
    nativeContent: structuredClone(content),
    otherFigures: [],
    competingRects: [[6, 54, 114, 144]],
    captions: [{ page: 1, lines: [items[0].str], rect: [10, 10, 10 + items[0].width, 20] }]
  })
  // The existing public line union can round one ULP beyond the whole Source union.
  f.options.captions[0].rect[2] += Number.EPSILON * f.options.captions[0].rect[2]
  const rect = (r: Evidence): number[] => [
    r.transform[4],
    height - r.transform[5] - 10,
    r.transform[4] + r.width,
    height - r.transform[5]
  ]
  f.table = {
    page: 1,
    cropRect: [90, 54, 264, 144],
    sourceViewport: { width: 280, height, scale: 1 },
    captionIssue: 'shared-table-caption',
    issues: ['text-crosses-crop-boundary', 'span-conflicts-with-source-rows'],
    clipped: [{ text: 'i', rect: [92, 55, 97, 65] }],
    unassigned: [],
    notes: [],
    selectedTextItems: 20,
    grid: Array.from({ length: 4 }, () => ['i', 'i', 'i', 'i']),
    cells: items.slice(19, 35).map((r, i) => {
      const claims = i % 4 === 0 ? [items[6 + Math.floor(i / 4) * 4], r] : [r]
      return {
        row: Math.floor(i / 4),
        column: i % 4,
        text: claims.map((s) => s.str).join(' '),
        sourceItems: claims.map((s) => s.sourceItem),
        sourceRects: claims.map(rect)
      }
    })
  }
  if (fault === 'claim') f.table.cells[0].sourceItems[0].text = 'changed'
  if (fault === 'blank') {
    const blank = {
      ...items[0],
      str: '',
      width: 5,
      transform: [10, 0, 0, 10, 180, 90],
      sourceItem: { pageNumber: 1, index: items.length, text: '' }
    }
    for (const c of [content, f.context.nativeGlyphContext.content, f.options.nativeContent])
      c.items.push(structuredClone(blank))
  }
  const empty = {
    ...items[0],
    str: '',
    width: 5,
    height: 0,
    transform: [10, 0, 0, 10, 180, 90],
    sourceItem: { pageNumber: 1, index: items.length, text: '' }
  }
  for (const c of [content, f.context.nativeGlyphContext.content, f.options.nativeContent])
    c.items.push(structuredClone(empty))
  // Original PDF.js content is untagged; the normal matched context is tagged.
  for (const r of f.options.nativeContent.items) delete r.sourceItem
  f.renderCrop = async (r: number[], parts?: number[][]): Promise<Buffer> => {
    const s = 4,
      c = createCanvas(Math.ceil((r[2] - r[0]) * s), Math.ceil((r[3] - r[1]) * s)),
      ctx = c.getContext('2d')
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, c.width, c.height)
    if (parts) {
      ctx.beginPath()
      for (const p of parts)
        ctx.rect((p[0] - r[0]) * s, (p[1] - r[1]) * s, (p[2] - p[0]) * s, (p[3] - p[1]) * s)
      ctx.clip()
    }
    ctx.fillStyle = 'black'
    for (const p of rails)
      ctx.fillRect((p[0] - r[0]) * s, (p[1] - r[1]) * s, (p[2] - p[0]) * s, (p[3] - p[1]) * s)
    for (const item of items)
      for (const [j, c] of [...item.str].entries())
        if (c !== ' ')
          ctx.fillRect(
            (item.transform[4] + j * 5 - r[0]) * s,
            (height - item.transform[5] - 8 - r[1]) * s,
            5 * s,
            11 * s
          )
    return c.toBuffer('image/png')
  }
  return f
}
it('removes only the fully closed peer panel while preserving unreliable mixed claims', async () => {
  const f = railPeerPixelExample(),
    before = structuredClone(f.table),
    proof = proveCaptionStrip(f.table, f.rules, f.context, f.options)
  expect(proof).toBeDefined()
  expect(proof.nativeCrop[0]).toBeGreaterThan(150)
  expect(proof.nativeCrop[1]).toBeLessThan(35)
  const n = f.context.nativeGlyphContext,
    tokens = n.content.items
      .filter((r: ReturnType<typeof JSON.parse>) => r.str.trim())
      .map((r: ReturnType<typeof JSON.parse>) => headerPixelToken(r, n.viewport, 0))
  expect(strictSingleClosingPage(f.options.page, tokens, n)).toBeDefined()
  expect(singleClosingPixelData(proof, f.options.page, tokens, n, f.table)).toBeUndefined()
  expect(singleClosingPaintData(proof, f.options.page, tokens, n)).toBeUndefined()
  expect(unrelatedSingleClosingData(proof, f.options.page, tokens, n)).toBeUndefined()
  const png = await renderCaptionStrip(proof, f.renderCrop),
    next = commitCaptionStrip(proof, png)
  expect(png).toBeDefined()
  expect(next).toBeDefined()
  expect({ ...next, cropRect: before.cropRect, region: undefined }).toEqual({
    ...before,
    region: undefined
  })
  expect(next.cells).toBe(f.table.cells)
  expect(f.table).toEqual(before)
})
it('requires both complete five-rail peers and whole consecutive panel labels', () => {
  for (const fault of ['rail', 'label']) {
    const f = railPeerPixelExample(fault)
    expect(proveCaptionStrip(f.table, f.rules, f.context, f.options)).toBeUndefined()
  }
})
it('refuses unknown old-crop material and every foreign blank envelope', () => {
  for (const fault of ['note', 'blank']) {
    const f = railPeerPixelExample(fault)
    expect(proveCaptionStrip(f.table, f.rules, f.context, f.options)).toBeUndefined()
  }
})
it('requires original whole claims and does not alter a clean peer crop', () => {
  for (const fault of ['claim', 'page', 'font', 'advance']) {
    const f = railPeerPixelExample(fault)
    if (fault === 'page') f.table.cells[0].sourceItems[0].pageNumber = 2
    if (fault === 'font') f.font.missingFile = true
    if (fault === 'advance') f.context.nativeGlyphContext.content.items[19].width++
    expect(proveCaptionStrip(f.table, f.rules, f.context, f.options)).toBeUndefined()
  }
  const g = railPeerPixelExample()
  g.table.cropRect = [159, 34, 261, 142]
  expect(proveCaptionStrip(g.table, g.rules, g.context, g.options)).toBeUndefined()
})
it('rejects borrowed peer plans and replaced retained source slots', async () => {
  const f = railPeerPixelExample(),
    proof = proveCaptionStrip(f.table, f.rules, f.context, f.options)
  expect(proof).toBeDefined()
  expect(await renderCaptionStrip(structuredClone(proof), f.renderCrop)).toBeUndefined()
  const source = f.context.sourceContent,
    native = f.options.nativeContent
  f.context.sourceContent = structuredClone(source)
  expect(await renderCaptionStrip(proof, f.renderCrop)).toBeUndefined()
  f.context.sourceContent = source
  f.options.nativeContent = structuredClone(native)
  expect(await renderCaptionStrip(proof, f.renderCrop)).toBeUndefined()
  f.options.nativeContent = native
  f.context.nativeGlyphContext.content.items[0].width++
  expect(await renderCaptionStrip(proof, f.renderCrop)).toBeUndefined()
})
// One anonymous native program; the detector's incomplete slots are audit data.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function isolatedBinaryPixels(fault = '') {
  const width = 220,
    height = 180,
    scale = 1.5
  const items: NativeHeaderFixtureData[] = [],
    glyphs = new Map<string, Set<string>>(),
    operators: NativeHeaderFixtureData = { fnArray: [], argsArray: [] },
    graphics: NativeHeaderFixtureData[] = []
  const add = (op: number, args: unknown): void => {
    operators.fnArray.push(op)
    operators.argsArray.push(args)
  }
  const text = (str: string, x: number, y: number, size = 8, font = 'F'): number => {
    const index = items.length
    items.push({
      str,
      dir: 'ltr',
      width: (str.length * size) / 2,
      height: size,
      transform: [size, 0, 0, size, x, height - y],
      fontName: font,
      hasEOL: true,
      sourceItem: { pageNumber: 1, index, text: str }
    })
    add(OPS.beginText, null)
    add(OPS.setFont, [font, size])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - y]])
    add(OPS.showText, [
      Array.from(str, (c) =>
        c === ' ' ? -500 : { unicode: c, fontChar: c, width: 500, isInFont: true }
      )
    ])
    add(OPS.endText, null)
    if (!glyphs.has(font)) glyphs.set(font, new Set())
    for (const c of str) if (c !== ' ') glyphs.get(font)?.add(c)
    return index
  }
  const line = (y: number): void => {
    add(OPS.constructPath, [
      OPS.stroke,
      [[0, 35, height - y, 1, 120, height - y]],
      [35, height - y, 120, height - y]
    ])
    graphics.push({
      kind: 'path',
      operationIndex: operators.fnArray.length - 1,
      normalizedRect: [35 / width, (y - 0.2) / height, 120 / width, (y + 0.2) / height]
    })
  }
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.4])
  add(OPS.setLineCap, [0])
  text('Prior prose outside the grid', 5, 20)
  items.push({
    str: '',
    width: 0,
    height: 0,
    dir: 'ltr',
    transform: [8, 0, 0, 8, 42, height - 50],
    fontName: 'F',
    hasEOL: true,
    sourceItem: { pageNumber: 1, index: items.length, text: '' }
  })
  text('a', 42, 50)
  text('1', 46, 52, 6)
  text('b', 64, 50)
  text('2', 68, 52, 6)
  text('c', 108, 50)
  if (fault === 'white rule') add(OPS.setStrokeRGBColor, ['#ffffff'])
  if (fault === 'transparent rule') add(OPS.setGState, [[['CA', 0]]])
  if (fault !== 'missing rule') line(55)
  if (fault === 'white rule') add(OPS.setStrokeRGBColor, ['#000000'])
  if (fault === 'transparent rule') add(OPS.setGState, [[['CA', 1]]])
  const body: number[][] = []
  for (const [row, pair] of [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1]
  ].entries()) {
    const y = 66 + row * 14,
      a = text(String(pair[0]), 45, y),
      b = text(String(fault === 'duplicate pair' && row === 3 ? 0 : pair[1]), 67, y),
      ids = [a, b]
    if (row === 0) ids.push(text('−', 97, y, 8, 'G'))
    ids.push(text(['1.0', '1.2', '2.0', '1.5'][row], 101, y))
    body.push(ids)
  }
  const paragraph = text('An outside paragraph extends across the whole page', 0, 132)
  if (fault === 'foreign glyph') text('Note', 84, 97)
  if (fault === 'extra rule') line(115)
  const vp = (s: number): NativeHeaderFixtureData => ({
      width: width * s,
      height: height * s,
      scale: s,
      rotation: 0,
      transform: [s, 0, 0, -s, 0, height * s],
      convertToViewportPoint: (x: number, y: number) => [x * s, (height - y) * s]
    }),
    nativeViewport = vp(1),
    viewport = vp(scale),
    content = {
      items,
      styles: {
        F: { ascent: 0.7, descent: -0.1, vertical: false },
        G: { ascent: 0, descent: 0, vertical: false }
      }
    },
    tokens = items.map((i) => headerPixelToken(i, viewport, 0)),
    cells: NativeHeaderFixtureData[] = [],
    grid = body.slice(1).map((ids) => ['', '', items[ids[0]].str, items[ids[1]].str])
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < 4; column++) {
      const index = column >= 2 ? body[row + 1][column - 2] : undefined
      cells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: grid[row][column],
        ...(index === undefined
          ? {}
          : { sourceItems: [items[index].sourceItem], sourceRects: [tokens[index].rect] })
      })
    }
  const rulePaintBounds = new Map<string, number[]>(),
    rules = bottomStripRules(operators, viewport, rulePaintBounds),
    bounds = graphics,
    native = {
      content: structuredClone(content),
      operators,
      viewport: nativeViewport,
      graphicsBounds: bounds,
      pageNumber: 1,
      sourceSha256: 'a'.repeat(64),
      skippedSpaceGlyphs: [],
      glyphBounds: [...glyphs].map(([fontName, chars]) => ({
        fontName,
        glyphs: [...chars].map((c) => ({
          fontChar: c,
          bounds: fontName === 'G' ? [0.1, 0.2, 0.45, 0.25] : [0, -0.1, 0.5, 0.7]
        }))
      }))
    },
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, graphicsBounds: bounds },
    context = {
      content,
      sourceContent: content,
      viewport,
      sourcePage: page,
      captions: [],
      rulePaintBounds,
      nativeEvidenceGraphics: graphics.map((g) => ({
        kind: g.kind,
        rect: g.normalizedRect.map((n: number, i: number) => n * (i % 2 ? height : width) * scale)
      })),
      nativePaintIdentityGraphics: graphics.map((g) => ({
        ...g,
        rect: g.normalizedRect.map((n: number, i: number) => n * (i % 2 ? height : width) * scale)
      })),
      nativeGlyphContext: native
    },
    table = {
      id: 'anonymous-grid',
      page: 1,
      cropRect: [20, 59, 102, 125].map((x) => x * scale),
      sourceViewport: { width: viewport.width, height: viewport.height, scale },
      grid,
      cells,
      notes: [],
      issues: ['text-crosses-crop-boundary', 'unassigned-source-text'],
      unassigned: ['0', '0', '−', items[paragraph].str],
      clipped: [...body[0].slice(0, 3), ...body.map((r) => r.at(-1) as number), paragraph].map(
        (i) => ({ text: items[i].str, rect: tokens[i].rect })
      ),
      repairs: [],
      reviewCandidate: false
    }
  if (fault === 'wrong origin') table.cells[2].sourceItems[0].pageNumber = 2
  if (fault === 'outline') native.glyphBounds[0].glyphs.pop()
  if (fault === 'positive blank') {
    const item = {
      ...items[1],
      str: ' ',
      width: 8,
      height: 8,
      transform: [8, 0, 0, 8, 87, height - 88],
      sourceItem: { pageNumber: 1, index: items.length, text: ' ' }
    }
    items.push(item)
    native.content.items.push(structuredClone(item))
  }
  return {
    table,
    context,
    rules,
    native,
    scale,
    png: (crop: number[], factor = 4) => {
      const r = crop.map((x) => x / scale)
      return createCanvas(
        Math.ceil((r[2] - r[0]) * factor),
        Math.ceil((r[3] - r[1]) * factor)
      ).toBuffer('image/png')
    }
  }
}
it('isolated binary-record pixels complete the whole image while preserving all scalar metadata', () => {
  const f = isolatedBinaryPixels(),
    before = structuredClone(f.table),
    result = refine(f.table, f.rules, f.context)
  expect(result).toBeDefined()
  expect({ ...result, cropRect: before.cropRect }).toEqual(before)
  expect(result?.cells).toBe(f.table.cells)
  expect(result?.cropRect[1]).toBeLessThan(f.table.cropRect[1])
  expect(result?.cropRect[2]).toBeGreaterThan(f.table.cropRect[2])
  expect(result?.cropRect[3]).toBeLessThan(f.table.cropRect[3])
  expect(f.context.content.styles.G.ascent).toBe(0)
  expect(f.context.content.styles.G.descent).toBe(0)
})
it('isolated binary-record pixels decline an incomplete physical record pattern', () => {
  for (const fault of ['missing rule', 'duplicate pair', 'white rule', 'transparent rule']) {
    const f = isolatedBinaryPixels(fault)
    expect(refine(f.table, f.rules, f.context)).toBeUndefined()
  }
})
it('isolated binary-record pixels do not remove unknown notes or extra native rules', () => {
  for (const fault of ['foreign glyph', 'extra rule']) {
    const f = isolatedBinaryPixels(fault)
    expect(refine(f.table, f.rules, f.context)).toBeUndefined()
  }
})
it('isolated binary-record pixels require whole original source identity and complete outlines', () => {
  for (const fault of ['wrong origin', 'outline']) {
    const f = isolatedBinaryPixels(fault)
    expect(refine(f.table, f.rules, f.context)).toBeUndefined()
  }
})
it('isolated binary-record pixels retain positive-area blank foreign domains', () => {
  const f = isolatedBinaryPixels('positive blank')
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
})
it('isolated binary-record pixels bind the private crop to original inputs and the initial PNG', () => {
  const f = isolatedBinaryPixels(),
    result = refine(f.table, f.rules, f.context)
  expect(result).toBeDefined()
  const proof = ownedGlyphProof(result)
  expect(proof).toBeDefined()
  expect(ownedGlyphPng(proof, f.png(result.cropRect), result)).toBe(true)
  expect(ownedGlyphPng(structuredClone(proof), f.png(result.cropRect), result)).toBe(false)
  expect(ownedGlyphPng(proof, f.png(result.cropRect, 1.5), result)).toBe(false)
  const content = f.context.sourceContent
  f.context.sourceContent = structuredClone(content)
  expect(ownedGlyphPng(proof, f.png(result.cropRect), result)).toBe(false)
  f.context.sourceContent = content
  f.native.glyphBounds[0].glyphs[0].bounds[0] += 0.01
  expect(ownedGlyphPng(proof, f.png(result.cropRect), result)).toBe(false)
})

it('completes native opening and closing half strokes when all cell glyphs already fit', () => {
  const f = ownedGlyphOverhang()
  f.table.cropRect = [0.8, 30, 99.2, 90]
  const before = structuredClone(f.table),
    result = refine(f.table, f.rules, f.context)
  expect(result?.cropRect).toEqual([0.55, 29.25, 99.45, 90.75])
  expect(result?.cells).toBe(f.table.cells)
  expect({ ...result, cropRect: before.cropRect }).toEqual(before)
})

it('keeps an already complete native ruled crop unchanged', () => {
  const f = ownedGlyphOverhang()
  f.table.cropRect = [0, 29, 100, 91]
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
})

it.each(['source', 'paint', 'missing owner'])(
  'does not complete half strokes with invalid %s proof',
  (fault) => {
    const f = ownedGlyphOverhang()
    f.table.cropRect = [0.8, 30, 99.2, 90]
    if (fault === 'source') f.table.cells[0].sourceItems[0].text += ' changed'
    if (fault === 'paint') f.context.rulePaintBounds.get(f.rules[0].join(','))[1] -= 2
    if (fault === 'missing owner') f.table.cells.pop()
    expect(refine(f.table, f.rules, f.context)).toBeUndefined()
  }
)
