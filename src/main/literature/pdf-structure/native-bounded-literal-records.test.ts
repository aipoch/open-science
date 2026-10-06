import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable, seedNativeClosedRecordTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const examples = readFileSync(
  resolve('src/main/literature/pdf-structure/fixtures/native-bounded-literal-records.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const fixture = (kind: string): ReturnType<typeof JSON.parse> =>
  structuredClone(examples.find((f) => f.kind === kind))
const run = (f: ReturnType<typeof fixture>): ReturnType<typeof refineTable> =>
  refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)
const chars = (s: string): string => [...s.replace(/\s/gu, '')].sort().join('')
for (const [kind, rows, cols] of [
  ['wrapped-prose-pairs', 8, 2],
  ['headerless-field-pairs', 5, 2],
  ['literal-definition-records', 16, 3],
  ['closed-dimension-fields', 3, 4],
  ['four-stub-scalar-records', 15, 12],
  ['repeated-deviation-records', 24, 10],
  ['paired-interval-records', 13, 7],
  ['complete-estimator-intervals', 12, 7]
] as const) {
  it(`preserves complete physical records and source glyphs in ${kind}`, () => {
    const input = fixture(kind),
      before = structuredClone(input),
      result = run(input)
    expect(result.grid).toHaveLength(rows)
    expect(result.grid.every((r: string[]) => r.length === cols)).toBe(true)
    expect(chars(result.cells.map((c: { text: string }) => c.text).join(''))).toBe(
      chars(input.items.map((i: { text: string }) => i.text).join(''))
    )
    expect(result.unassigned).toEqual([])
    const source = result.cells.flatMap((c: { sourceTokens?: unknown[] }) => c.sourceTokens ?? [])
    expect(new Set(source).size).toBe(source.length)
    expect(input).toEqual(before)
  })
}
for (const kind of [
  'wrapped-prose-pairs',
  'headerless-field-pairs',
  'literal-definition-records',
  'closed-dimension-fields',
  'heterogeneous-literal-panels',
  'four-stub-scalar-records',
  'repeated-deviation-records',
  'paired-interval-records'
]) {
  it(`keeps ${kind} independent of source enumeration`, () => {
    const input = fixture(kind),
      expected = run(input).grid
    input.items.reverse()
    input.rules.reverse()
    input.runs.reverse()
    expect(run(input).grid).toEqual(expected)
  })
  it(`refuses unfenced ${kind} ownership`, () => {
    const input = fixture(kind)
    input.rules = []
    const result = run(input)
    expect(
      result.repairs.some((s: string) =>
        /^native-(?:bounded-literal|vertical-wrapped|physical-panel|closed-leaf-complete|repeated-deviation|paired-interval)/u.test(
          s
        )
      )
    ).toBe(false)
  })
}
it('refuses ordinary prose without a literal neighboring table caption', () => {
  const input = fixture('wrapped-prose-pairs')
  input.captions = []
  expect(run(input).repairs).not.toContain('native-bounded-literal-prose-records-recovered')
})
it('retains uncertainty when source prose crosses a independently witnessed gutter', () => {
  const input = fixture('wrapped-prose-pairs'),
    i = input.items.find((i: { text: string }) => i.text === 'XXXXXX')
  i.rect[2] = input.table.cropRect[2] - 1
  expect(run(input).repairs).not.toContain('native-bounded-literal-prose-records-recovered')
})
it('does not inherit a sparse first-stub factor label', () => {
  const result = run(fixture('literal-definition-records'))
  expect(result.grid[3][0]).toBe('')
  expect(result.grid[4][0]).toBe('')
  expect(result.cells.every((c: { rowSpan: number }) => c.rowSpan === 1)).toBe(true)
})
it('does not infer repeated groups if one literal sequence changes', () => {
  const input = fixture('repeated-deviation-records'),
    stub = input.items.filter(
      (i: { rect: number[]; baseline: number }) =>
        i.rect[0] > 160 && i.rect[0] < 170 && i.baseline > 398
    )
  stub[7].text += ' Q'
  expect(run(input).repairs).not.toContain('native-repeated-deviation-source-records-recovered')
})
it('keeps source uncertainty when one scalar witness is absent', () => {
  const input = fixture('four-stub-scalar-records'),
    i = input.items.findIndex(
      (i: { text: string; rect: number[] }) => i.rect[0] > 730 && /^0\.\d+$/u.test(i.text)
    )
  input.items.splice(i, 1)
  expect(run(input).repairs).not.toContain('native-closed-leaf-complete-records-recovered')
})
it('preserves lower literal panel fields through proved column unions', () => {
  const input = fixture('heterogeneous-literal-panels'),
    result = run(input)
  expect(
    result.cells.some(
      (c: { text: string; colSpan: number }) => c.text === '0.668 ± 0.006' && c.colSpan === 2
    )
  ).toBe(true)
  expect(chars(result.cells.map((c: { text: string }) => c.text).join(''))).toBe(
    chars(input.items.map((i: { text: string }) => i.text).join(''))
  )
  expect(result.unassigned).toEqual([])
})
for (const [kind, rows] of [
  ['boxed-native-field-seed', 11],
  ['captionless-native-deviation-seed', 5]
] as const) {
  it(`restores a detector-missed ${kind} from its complete native frame`, () => {
    const input = fixture(kind),
      frame = {
        ...input.frame,
        sourceTokens: input.items,
        headerTokens: input.frame.headerIndexes?.map((n: number) => input.items[n])
      },
      before = structuredClone(input),
      table = seedNativeClosedRecordTable(frame, input.items, input.rules, 1)
    expect(table).toBeDefined()
    const result = refineTable(table, input.items, input.captions, [], input.rules, input.runs)
    expect(result.grid).toHaveLength(rows)
    expect(result.grid.every((r: string[]) => r.length === 2)).toBe(true)
    expect(result.unassigned).toEqual([])
    expect(chars(result.cells.map((c: { text: string }) => c.text).join(''))).toBe(
      chars(input.items.map((i: { text: string }) => i.text).join(''))
    )
    expect(input).toEqual(before)
    expect(frame.caption).toEqual(
      kind === 'captionless-native-deviation-seed' ? undefined : input.captions[0]
    )
  })
  it(`rejects ${kind} when its physical fence is absent`, () => {
    const input = fixture(kind),
      frame = {
        ...input.frame,
        sourceTokens: input.items,
        headerTokens: input.frame.headerIndexes?.map((n: number) => input.items[n])
      }
    expect(seedNativeClosedRecordTable(frame, input.items, [], 1)).toBeUndefined()
  })
}
it('does not create a numerical table from an uncertain mathematical field', () => {
  const input = fixture('boxed-native-field-seed'),
    frame = { ...input.frame, sourceTokens: input.items }
  input.items.find((i: { rect: number[] }) => i.rect[0] > 460).text = 'a = unknown'
  expect(seedNativeClosedRecordTable(frame, input.items, input.rules, 1)).toBeUndefined()
})
it('orders a uniquely raised adjacent literal header without changing its script metadata', () => {
  const input = fixture('closed-dimension-fields'),
    result = run(input),
    cell = result.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 3)
  expect(cell.text).toBe('N(XXXX)')
  expect(cell.textRuns).toEqual([
    { text: 'N', position: 'normal' },
    { text: '(XXXX)', position: 'superscript' }
  ])
  expect(cell.sourceRects.every((r: number[]) => r[1] >= result.cropRect[1])).toBe(true)
})
it('does not expand a raised-header crop into caption-owned text', () => {
  const input = fixture('closed-dimension-fields')
  input.captions[0].rect[3] = 565
  expect(run(input).repairs).not.toContain('native-vertical-wrapped-literal-fields-recovered')
})
it('does not consume an undecodable zero-width literal as a native physical record', () => {
  const input = fixture('wrapped-prose-pairs'),
    i = input.items[3]
  i.rect[2] = i.rect[0]
  expect(run(input).repairs).not.toContain('native-bounded-literal-prose-records-recovered')
})
it('refuses incomplete estimator-interval atoms rather than completing a bracket', () => {
  const input = fixture('complete-estimator-intervals'),
    i = input.items.find((i: { text: string }) => i.text === ']')
  i.text = '?'
  expect(run(input).repairs).not.toContain('native-estimator-interval-fields-recovered')
})
it('trims only the proved closing boundary while retaining every external note diagnostic', () => {
  const input = fixture('closed-body-with-external-note'),
    result = run(input)
  expect(result.grid).toHaveLength(6)
  expect(result.grid[0]).toHaveLength(4)
  expect(result.cropRect[3]).toBeCloseTo(1044.38, 5)
  const note = input.items.filter((i: { rect: number[] }) => i.rect[1] > 1043.88)
  expect(note.length).toBeGreaterThan(0)
  for (const item of note) expect(result.unassigned).toContain(item.text)
  expect(
    result.cells.every((c: { sourceRects: number[][] }) =>
      c.sourceRects.every((r) => r[3] < 1043.88)
    )
  ).toBe(true)
  const before = structuredClone(input),
    changed = structuredClone(input)
  changed.rules = changed.rules.filter((r: number[]) => Math.abs(r[1] - 1043.88) > 0.05)
  expect(run(changed).repairs).not.toContain('native-closed-leaf-body-crop-trimmed')
  expect(input).toEqual(before)
})
