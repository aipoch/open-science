import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { proveNativeFullyRuledLiteralGrid, findCaptionedNativePartialRuleTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
it('recovers a complete captioned numeric inventory with only a divider and continuous native stub fence', () => {
  const f = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/source-grids/native-partial-rule-numeric-inventory.jsonl'
      )
    ),
    before = structuredClone(f),
    plan = findCaptionedNativePartialRuleTable(f.caption, f.items, f.rules)
  expect(plan.groups).toHaveLength(4)
  expect(plan.columns).toHaveLength(5)
  expect(plan.consumed).toHaveLength(f.items.length)
  expect(plan.headerCells.map((c: { text: string }) => c.text)).toEqual([
    'Stage',
    '𝑁vp',
    '𝑁sample',
    '𝜂0',
    'change'
  ])
  expect(plan.bodyRecords.flat().map((i: { text: string }) => i.text)).toContain('−')
  const runs = f.items.map((i: { text: string }) => ({
    ...i,
    gaps: [],
    literalGlyphs: [...i.text],
    glyphRuns: [...i.text].map(() => 1)
  }))
  expect(
    findCaptionedNativePartialRuleTable(f.caption, f.items, f.rules, runs)?.consumed
  ).toHaveLength(f.items.length)
  expect(f).toEqual(before)
  for (const missing of ['stub', 'divider', 'record', 'caption']) {
    const sample = structuredClone(f)
    if (missing === 'stub') sample.rules = sample.rules.filter((r: number[]) => r[1] === r[3])
    if (missing === 'divider') sample.rules = sample.rules.filter((r: number[]) => r[0] === r[2])
    if (missing === 'record')
      sample.items = sample.items.filter((i: { baseline: number }) => i.baseline < 831)
    if (missing === 'caption') sample.caption.lines = ['Ordinary paragraph about the data.']
    expect(
      findCaptionedNativePartialRuleTable(sample.caption, sample.items, sample.rules)
    ).toBeUndefined()
  }
})
const fixture = (): ReturnType<typeof JSON.parse> => {
  const cuts = [0, 25, 55, 90, 130, 170],
    faces = [20, 46, 60, 74, 88, 102],
    rules = [
      ...cuts.map((x) => [x, faces[0], x, faces.at(-1)]),
      ...faces.map((y) => [cuts[0], y, cuts.at(-1), y])
    ],
    token = (text: string, x: number, y: number): ReturnType<typeof JSON.parse> => ({
      text,
      rect: [x, y - 9, x + 9, y],
      baseline: y,
      height: 9,
      horizontal: true
    }),
    items = cuts.slice(1).map((_, c) => token(`H${c}`, cuts[c] + 4, 41))
  for (let r = 1; r < faces.length - 1; r++) {
    items.push(token(`[${r}]`, 4, faces[r] + 10))
    items.push(token('✓', cuts[1 + (r % 4)] + 4, faces[r] + 10))
  }
  return {
    table: { cropRect: [-2, 18, 172, 104] },
    captions: [{ lines: ['Table 1: Anonymous printed marks.'], rect: [0, 0, 170, 15] }],
    items,
    rules,
    cuts,
    faces
  }
}
it('uses complete native fences for every literal cell, including physically empty faces', () => {
  const f = fixture(),
    before = structuredClone(f)
  const plan = proveNativeFullyRuledLiteralGrid(f.table, f.items, f.captions, f.rules)
  expect(plan.cuts).toEqual(f.cuts)
  expect(plan.groups).toHaveLength(5)
  expect(plan.rowRects).toHaveLength(5)
  expect(plan.headerRows).toBe(1)
  expect(plan.consumed).toHaveLength(f.items.length)
  expect(plan.groups.flat()).toEqual(expect.arrayContaining(f.items))
  expect(new Set(plan.groups.flat()).size).toBe(f.items.length)
  expect(f).toEqual(before)
})
it('joins contiguous native header glyph fragments without inventing word spaces', () => {
  const f = fixture()
  const first = f.items[0]
  first.text = 'A'
  first.rect[2] = 8
  f.items.push({ ...first, text: 'B', rect: [8, first.rect[1], 13, first.rect[3]] })
  const plan = proveNativeFullyRuledLiteralGrid(f.table, f.items, f.captions, f.rules)
  expect(plan.headerCells[0].text).toBe('AB')
  expect(plan.headerCells[0].sourceTokens).toHaveLength(2)
})
it.each(['superscript', 'subscript', 'normal'])(
  'preserves plain and rich %s header order through wide literal record reconstruction',
  (position) => {
    const f = fixture()
    f.cuts = Array.from({ length: 22 }, (_, n) => n * 30)
    f.rules = [
      ...f.cuts.map((x: number) => [x, 20, x, 102]),
      ...f.faces.map((y: number) => [0, y, 630, y])
    ]
    f.captions[0].rect = [0, 0, 630, 15]
    f.table = {
      id: 'anonymous-literal-matrix',
      cropRect: [-2, 18, 632, 104],
      structure: {
        objects: [
          ...f.cuts.slice(1).map((x: number, c: number) => ({
            label: 'table column',
            rect: [f.cuts[c] + 2, 0, x + 2, 86]
          })),
          ...f.faces.slice(1).map((y: number, r: number) => ({
            label: 'table row',
            rect: [0, f.faces[r] - 18, 634, y - 18]
          })),
          { label: 'table column header', rect: [0, 2, 634, 28] }
        ]
      }
    }
    const base = { text: 'm', rect: [4, 32, 10, 41], baseline: 41, height: 9, horizontal: true }
    f.items = f.cuts.slice(1).map((_: number, c: number) => ({
      ...base,
      text: c ? `H${c}` : 'm',
      rect: [f.cuts[c] + 4, 32, f.cuts[c] + (c ? 13 : 10), 41]
    }))
    const baseline = position === 'superscript' ? 37 : position === 'subscript' ? 44 : 41,
      height = position === 'normal' ? 9 : 5
    f.items.push({
      ...base,
      text: '2',
      rect: [10, baseline - height, 14, baseline],
      baseline,
      height
    })
    for (let r = 1; r < f.faces.length - 1; r++) {
      const y = f.faces[r] + 10,
        x = f.cuts[1 + (r % 4)] + 4
      f.items.push(
        { ...base, text: `[${r}]`, rect: [4, y - 9, 13, y], baseline: y },
        { ...base, text: '✓', rect: [x, y - 9, x + 9, y], baseline: y }
      )
    }
    const before = structuredClone(f),
      result = refineTable(f.table, f.items, f.captions, [], f.rules),
      header = result.cells.find((c: { row: number; column: number }) => !c.row && !c.column)
    expect(result.repairs).toContain('native-fully-ruled-literal-faces-proved')
    expect(header.text).toBe('m2')
    expect(result.grid[0][0]).toBe('m2')
    if (position === 'normal') expect(header.textRuns).toBeUndefined()
    else
      expect(header.textRuns).toEqual([
        { text: 'm', position: 'normal' },
        { text: '2', position }
      ])
    expect(f).toEqual(before)
    const reversed = refineTable(f.table, [...f.items].reverse(), f.captions, [], f.rules)
    expect(reversed.grid).toEqual(result.grid)
    const reversedHeader = reversed.cells.find(
      (c: { row: number; column: number }) => !c.row && !c.column
    )
    expect(reversedHeader.text).toBe(header.text)
    expect(reversedHeader.textRuns).toEqual(header.textRuns)
    expect(reversedHeader.sourceRects).toHaveLength(header.sourceRects.length)
    expect(reversedHeader.sourceRects).toEqual(expect.arrayContaining(header.sourceRects))
  }
)
it.each(['independent body baselines', 'interleaved body ink'])(
  'preserves existing record semantics when a physical face has %s',
  (variant) => {
    const f = fixture()
    const first = f.items.find((i: { text: string }) => i.text === '[1]')
    if (variant === 'independent body baselines') {
      f.faces = [20, 46, 80, 94, 108, 122]
      f.rules = [
        ...f.cuts.map((x: number) => [x, 20, x, 122]),
        ...f.faces.map((y: number) => [0, y, 170, y])
      ]
      f.table.cropRect = [-2, 18, 172, 124]
      f.items = f.items.filter((i: { baseline: number }) => i.baseline < 60)
      f.items.push({ ...first, text: 'Second record', rect: [4, 61, 20, 70], baseline: 70 })
      for (const y of [90, 104, 118])
        f.items.push({ ...first, text: 'Record', rect: [4, y - 9, 13, y], baseline: y })
    } else {
      f.items.push({ ...first, text: 'X', rect: [8, first.rect[1], 11, first.rect[3]] })
    }
    const before = structuredClone(f)
    expect(proveNativeFullyRuledLiteralGrid(f.table, f.items, f.captions, f.rules)).toBeUndefined()
    expect(f).toEqual(before)
  }
)
it.each(['ambiguous script row', 'rotated header'])(
  'does not serialize a literal header with %s evidence',
  (variant) => {
    const f = fixture(),
      first = f.items[0]
    if (variant === 'rotated header') first.horizontal = false
    else {
      first.rect[2] = 10
      f.items.push(
        { ...first, text: 'Other', rect: [4, 24, 10, 33], baseline: 33 },
        { ...first, text: '2', rect: [10, 32, 14, 37], baseline: 37, height: 5 }
      )
    }
    const before = structuredClone(f)
    expect(proveNativeFullyRuledLiteralGrid(f.table, f.items, f.captions, f.rules)).toBeUndefined()
    expect(f).toEqual(before)
  }
)
it('keeps proved wrapped header words in physical row order', () => {
  const f = fixture(),
    first = f.items[0]
  first.text = 'Second'
  f.items.push({ ...first, text: 'First', rect: [4, 20, 13, 29], baseline: 29 })
  const plan = proveNativeFullyRuledLiteralGrid(f.table, f.items, f.captions, f.rules)
  expect(plan.headerCells[0].text).toBe('First Second')
  expect(
    proveNativeFullyRuledLiteralGrid(f.table, [...f.items].reverse(), f.captions, f.rules)
      .headerCells[0].text
  ).toBe('First Second')
})
it.each(['missing interior edge', 'partial edge', 'crossed gutter', 'no caption', 'missing leaf'])(
  'refuses to infer a literal matrix from %s',
  (variant) => {
    const f = fixture()
    if (variant === 'missing interior edge') f.rules.splice(2, 1)
    if (variant === 'partial edge') f.rules[2][3] = 60
    if (variant === 'crossed gutter') f.items[2].rect[2] = 95
    if (variant === 'no caption') f.captions = []
    if (variant === 'missing leaf') f.items.splice(2, 1)
    expect(proveNativeFullyRuledLiteralGrid(f.table, f.items, f.captions, f.rules)).toBeUndefined()
  }
)
