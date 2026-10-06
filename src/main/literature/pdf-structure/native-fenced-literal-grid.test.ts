import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { proveNativeFullyRuledLiteralGrid, findCaptionedNativePartialRuleTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
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
