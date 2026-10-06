import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const examples = readFileSync(
  resolve('src/main/literature/pdf-structure/fixtures/native-terminal-records.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const fixture = (kind: string): ReturnType<typeof JSON.parse> =>
  structuredClone(examples.find((f) => f.kind === kind))
const run = (f: ReturnType<typeof fixture>): ReturnType<typeof refineTable> =>
  refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)
const characters = (text: string): string => [...text.replace(/\s/gu, '')].sort().join('')

for (const kind of ['closed-field-faces', 'measured-four-leaf']) {
  it(`recovers complete ${kind} records with unique unchanged source ownership`, () => {
    const input = fixture(kind),
      before = structuredClone(input),
      result = run(input)
    expect(result.grid).toHaveLength(8)
    expect(
      result.grid.every((r: string[]) => r.length === (kind === 'closed-field-faces' ? 2 : 4))
    ).toBe(true)
    expect(result.unassigned).toEqual([])
    expect(characters(result.cells.map((c: { text: string }) => c.text).join(''))).toBe(
      characters(input.items.map((i: { text: string }) => i.text).join(''))
    )
    const selected = result.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
    expect(new Set(selected).size).toBe(selected.length)
    expect(input).toEqual(before)
  })

  it(`preserves ${kind} after scaling, translation and reversed source order`, () => {
    const input = fixture(kind),
      expected = run(input).grid
    const rect = (r: number[]): number[] => r.map((v, n) => v * 1.7 + (n % 2 ? 70 : 30))
    input.table.cropRect = rect(input.table.cropRect)
    input.table.structure.objects = input.table.structure.objects.map((o: { rect: number[] }) => ({
      ...o,
      rect: o.rect.map((v) => v * 1.7)
    }))
    input.items = input.items
      .map((i: { rect: number[]; height: number; baseline: number }) => ({
        ...i,
        rect: rect(i.rect),
        height: i.height * 1.7,
        baseline: i.baseline * 1.7 + 70
      }))
      .reverse()
    input.rules = input.rules.map(rect).reverse()
    input.captions = input.captions.map((c: { rect: number[] }) => ({ ...c, rect: rect(c.rect) }))
    input.runs = input.runs.map(
      (r: {
        rect: number[]
        height: number
        baseline: number
        gaps: { left: number; right: number }[]
      }) => ({
        ...r,
        rect: rect(r.rect),
        height: r.height * 1.7,
        baseline: r.baseline * 1.7 + 70,
        gaps: r.gaps.map((g) => ({ ...g, left: g.left * 1.7 + 30, right: g.right * 1.7 + 30 }))
      })
    )
    expect(run(input).grid).toEqual(expected)
  })
}

it('retains the final wrapped field inside its complete physical face', () => {
  const result = run(fixture('closed-field-faces'))
  expect(result.grid[7][0]).toBe('XXXXXXXXXX')
  expect(result.grid[7][1]).toContain('544 XX XXX 67 XX XXXX')
  expect(result.repairs).toContain('native-closed-field-faces-recovered')
})

it('refuses field recovery without every complete native row boundary', () => {
  const input = fixture('closed-field-faces')
  input.rules = input.rules.filter((r: number[]) => Math.abs(r[1] - 287.3115) > 0.05)
  expect(run(input).repairs).not.toContain('native-closed-field-faces-recovered')
})

it('refuses a paragraph crossing the proved field gutter', () => {
  const input = fixture('closed-field-faces')
  input.items.push({
    text: 'An ordinary paragraph crosses both lanes',
    height: 11.9,
    baseline: 310,
    rect: [220, 298.1, 640, 310],
    horizontal: true
  })
  expect(run(input).repairs).not.toContain('native-closed-field-faces-recovered')
})

it('keeps text outside the final native boundary out of repaired field cells', () => {
  const input = fixture('closed-field-faces')
  input.items.push({
    text: 'external note',
    height: 1,
    baseline: 330,
    rect: [220, 329, 300, 330],
    horizontal: true
  })
  const result = run(input)
  expect(result.grid.flat()).not.toContain('external note')
  expect(result.unassigned).toContain('external note')
})

it('recovers the fused labels, sample count and complete human metric record', () => {
  const result = run(fixture('measured-four-leaf'))
  expect(result.grid[5]).toEqual(['722-XXXX XXXXXXX, XXXXX', 'XXXXX (XXX)', '4,267', '4.0'])
  expect(result.grid[6].slice(1, 3)).toEqual(['', ''])
  expect(result.repairs).toContain('native-measured-four-leaf-records-recovered')
})

it('refuses measured records without a literal measured glyph run', () => {
  const input = fixture('measured-four-leaf')
  input.runs = []
  expect(run(input).repairs).not.toContain('native-measured-four-leaf-records-recovered')
})

it('refuses an uncertain complete count lane instead of inventing a value', () => {
  const input = fixture('measured-four-leaf')
  const item = input.items.find((i: { text: string }) => i.text === '3,318')
  item.text = 'uncertain'
  expect(run(input).repairs).not.toContain('native-measured-four-leaf-records-recovered')
})

it('requires native caption evidence for both record repairs', () => {
  for (const kind of ['closed-field-faces', 'measured-four-leaf']) {
    const input = fixture(kind)
    input.captions = []
    expect(run(input).repairs).not.toContain(
      kind === 'closed-field-faces'
        ? 'native-closed-field-faces-recovered'
        : 'native-measured-four-leaf-records-recovered'
    )
  }
})

it('refuses field recovery when a source glyph lacks a horizontal text contract', () => {
  const input = fixture('closed-field-faces')
  input.items.find((i: { text: string }) => i.text === 'XXXXXXXXXX').horizontal = false
  expect(run(input).repairs).not.toContain('native-closed-field-faces-recovered')
})

it('requires one unique nearby native table caption', () => {
  for (const kind of ['closed-field-faces', 'measured-four-leaf']) {
    const input = fixture(kind)
    input.captions.push(structuredClone(input.captions[0]))
    expect(run(input).repairs).not.toContain(
      kind === 'closed-field-faces'
        ? 'native-closed-field-faces-recovered'
        : 'native-measured-four-leaf-records-recovered'
    )
  }
})
