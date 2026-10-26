import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const {
  refineNativeTableBoundaryInk: refine,
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
