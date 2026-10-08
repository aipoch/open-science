import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable, recoverCaptionedRuledTables } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const examples = readFileSync(
  resolve('src/main/literature/pdf-structure/fixtures/native-complete-records.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const fixture = (kind: string): ReturnType<typeof JSON.parse> =>
  structuredClone(examples.find((f) => f.kind === kind))
const run = (f: ReturnType<typeof fixture>): ReturnType<typeof refineTable> => {
  const table =
    f.table ?? recoverCaptionedRuledTables(f.items, f.rules, f.captions, 1, [], f.runs)[0]
  return table && refineTable(table, f.items, f.captions, [], f.rules, f.runs)
}
const characters = (text: string): string => [...text.replace(/\s/gu, '')].sort().join('')

for (const [kind, rows, columns] of [
  ['dense-deviation', 25, 6],
  ['scalar-pairs', 7, 10],
  ['wrapped-fields', 16, 2],
  ['compact-configuration', 5, 7],
  ['compact-measured', 13, 10]
] as const) {
  it(`recovers every complete ${kind} record without changing the input or its source text`, () => {
    const input = fixture(kind)
    const before = structuredClone(input)
    const result = run(input)
    expect(result).toBeDefined()
    expect(result.grid).toHaveLength(rows)
    expect(result.grid.every((row: string[]) => row.length === columns)).toBe(true)
    expect(result.unassigned).toEqual([])
    const [left, top, right, bottom] = result.cropRect
    const selected = input.items.filter(
      (i: { rect: number[] }) =>
        i.rect[0] >= left && i.rect[2] <= right && i.rect[1] >= top && i.rect[3] <= bottom
    )
    expect(characters(result.cells.map((cell: { text: string }) => cell.text).join(''))).toBe(
      characters(selected.map((i: { text: string }) => i.text).join(''))
    )
    expect(input).toEqual(before)
  })

  it(`keeps ${kind} stable after translation, scaling and reversed source order`, () => {
    const input = fixture(kind)
    const expected = run(input).grid
    const rect = (r: number[]): number[] => r.map((v, n) => v * 1.7 + (n % 2 ? 70 : 30))
    input.crop = rect(input.crop)
    if (input.table) {
      input.table.cropRect = rect(input.table.cropRect)
      for (const object of input.table.structure.objects)
        object.rect = object.rect.map((v: number) => v * 1.7)
    }
    input.items = input.items
      .map((item: { rect: number[]; baseline: number; height: number }) => ({
        ...item,
        rect: rect(item.rect),
        baseline: item.baseline * 1.7 + 70,
        height: item.height * 1.7
      }))
      .reverse()
    input.rules = input.rules.map(rect).reverse()
    input.captions = input.captions.map((c: { rect: number[] }) => ({ ...c, rect: rect(c.rect) }))
    input.runs = input.runs.map(
      (r: {
        rect: number[]
        baseline: number
        height: number
        gaps: { left: number; right: number }[]
      }) => ({
        ...r,
        rect: rect(r.rect),
        baseline: r.baseline * 1.7 + 70,
        height: r.height * 1.7,
        gaps: r.gaps.map((g) => ({ ...g, left: g.left * 1.7 + 30, right: g.right * 1.7 + 30 }))
      })
    )
    expect(run(input)?.grid).toEqual(expected)
  })
}

it('owns the two explicit mode labels only when each physical face has three complete records', () => {
  const input = fixture('scalar-pairs')
  const result = run(input)
  expect(
    result.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 0).rowSpan
  ).toBe(3)
  expect(
    result.cells.find((c: { row: number; column: number }) => c.row === 4 && c.column === 0).rowSpan
  ).toBe(3)
  const full = input.rules
    .filter((r: number[]) => r[1] === r[3] && r[2] - r[0] > 570)
    .sort((a: number[], b: number[]) => a[1] - b[1])
  const separator = full[2]
  separator[1] = separator[3] = 319
  for (const item of input.items.filter(
    (i: { rect: number[]; baseline: number }) =>
      i.rect[0] < 220 && i.baseline > 300 && i.baseline < 335
  )) {
    item.rect[1] -= 17
    item.rect[3] -= 17
    item.baseline -= 17
  }
  expect(run(input).repairs).not.toContain('native-scalar-pair-records-recovered')
})

it('refuses dense record reconstruction when one metric has unknown source text', () => {
  const input = fixture('dense-deviation')
  input.items.find((i: { text: string }) => i.text.includes('±')).text = 'uncertain'
  expect(run(input).repairs).not.toContain('native-dense-deviation-records-recovered')
})

it('leaves the parameter footnote outside the recovered body crop and cells', () => {
  const input = fixture('wrapped-fields'),
    result = run(input)
  const notes = input.items.filter((i: { rect: number[] }) => i.rect[1] > result.cropRect[3])
  expect(notes.length).toBeGreaterThan(0)
  const selected = result.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
  expect(notes.some((i: unknown) => selected.includes(i))).toBe(false)
})

it('requires a caption and the complete native closing frame for a tiny table', () => {
  for (const kind of ['compact-configuration', 'compact-measured']) {
    const noCaption = fixture(kind)
    noCaption.captions = []
    expect(run(noCaption)).toBeUndefined()
    const missingFrame = fixture(kind)
    missingFrame.rules = missingFrame.rules.filter(
      (r: number[]) => Math.abs(r[1] - missingFrame.crop[3]) > 0.05
    )
    expect(run(missingFrame)).toBeUndefined()
  }
})

it('refuses a measured native recovery without original glyph gap evidence', () => {
  const input = fixture('compact-measured')
  input.runs = []
  expect(run(input)?.repairs).not.toContain('native-measured-leaf-body-records-recovered')
})

it('orders a proved stacked fraction numerator before its denominator while retaining literal text runs', () => {
  const input = fixture('literal-fraction'),
    before = structuredClone(input),
    result = run(input)
  expect(result.grid[1][0]).toBe('A + 1 2 B ≥ 0.5')
  expect(result.cells[1].textRuns).toEqual([
    { text: 'A + ', position: 'normal' },
    { text: '1', position: 'superscript' },
    { text: ' ', position: 'normal' },
    { text: '2', position: 'subscript' },
    { text: ' B ≥ 0.5', position: 'normal' }
  ])
  expect(result.repairs).toContain('native-literal-fraction-order-reconciled')
  expect(input).toEqual(before)
})

it('refuses fraction ordering without one unique native fraction bar', () => {
  for (const count of [0, 2]) {
    const input = fixture('literal-fraction')
    input.rules = Array.from({ length: count }, () => structuredClone(input.rules[0]))
    expect(run(input).repairs).not.toContain('native-literal-fraction-order-reconciled')
  }
})
