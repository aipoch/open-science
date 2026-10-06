import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const examples = readFileSync(
  resolve('src/main/literature/pdf-structure/fixtures/native-script-record-controls.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
for (const kind of ['scientific-script-pairs', 'wrapped-script-pairs', 'script-unit-records']) {
  it(`retains established scientific script ownership in ${kind}`, () => {
    const f = structuredClone(examples.find((f) => f.kind === kind))
    const before = structuredClone(f)
    const result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)
    expect(result.repairs).not.toContain('native-bounded-literal-prose-records-recovered')
    const scripts = result.cells.flatMap(
      (c: { textRuns?: { position: string }[] }) => c.textRuns ?? []
    )
    expect(scripts.some((r: { position: string }) => r.position === 'superscript')).toBe(true)
    expect(f).toEqual(before)
  })
}
for (const kind of ['script-header-leaves', 'script-average-header']) {
  it(`preserves previously proven rich header ownership in ${kind}`, () => {
    const f = structuredClone(examples.find((f) => f.kind === kind))
    const result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)
    const header = result.cells.filter((c: { row: number }) => c.row === 0)
    expect(
      header.some((c: { textRuns?: { position: string }[] }) =>
        c.textRuns?.some((r: { position: string }) => r.position === 'subscript')
      )
    ).toBe(true)
  })
}
it('separates complete physical literal faces despite repeated middle labels', () => {
  const f = structuredClone(examples.find((f) => f.kind === 'complete-literal-peer-faces'))
  const result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)
  expect(result.grid).toHaveLength(6)
  expect(result.grid[4][1]).toBe('XXXXX')
  expect(result.grid[5][1]).toBe('XXXXX')
  const characters = (s: string): string => [...s.replace(/\s/gu, '')].sort().join('')
  expect(characters(result.cells.map((c: { text: string }) => c.text).join(''))).toBe(
    characters(f.items.map((i: { text: string }) => i.text).join(''))
  )
})
it('retains every fenced baseline prefix and paired deviation record', () => {
  const f = structuredClone(examples.find((f) => f.kind === 'fenced-deviation-record-prefix'))
  const result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)
  expect(result.grid).toHaveLength(16)
  expect(result.grid.every((r: string[]) => r.length === 10)).toBe(true)
  expect(
    result.cells.filter(
      (c: { column: number; text: string }) => c.column === 1 && c.text === 'XXXX'
    )
  ).toHaveLength(3)
  expect(result.unassigned).toEqual([])
  const characters = (s: string): string => [...s.replace(/\s/gu, '')].sort().join('')
  expect(characters(result.cells.map((c: { text: string }) => c.text).join(''))).toBe(
    characters(f.items.map((i: { text: string }) => i.text).join(''))
  )
})
for (const kind of ['complete-literal-peer-faces', 'fenced-deviation-record-prefix']) {
  it(`refuses unfenced physical faces in ${kind}`, () => {
    const f = structuredClone(examples.find((f) => f.kind === kind))
    f.rules = []
    const result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)
    expect(result.repairs).not.toContain('native-complete-literal-peer-faces-recovered')
    expect(result.repairs).not.toContain('native-repeated-deviation-source-records-recovered')
  })
  it(`preserves ${kind} independently of source enumeration`, () => {
    const f = structuredClone(examples.find((f) => f.kind === kind))
    const expected = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs).grid
    f.items.reverse()
    f.rules.reverse()
    f.runs.reverse()
    expect(refineTable(f.table, f.items, f.captions, [], f.rules, f.runs).grid).toEqual(expected)
  })
}
it('keeps the literal face fallback closed when an independent peer is missing', () => {
  const f = structuredClone(examples.find((f) => f.kind === 'complete-literal-peer-faces'))
  f.items = f.items.filter(
    (i: { text: string; baseline: number }) => !(i.text === 'XXXXX' && i.baseline > 265)
  )
  const result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)
  expect(result.repairs).not.toContain('native-complete-literal-peer-faces-recovered')
})
it('rejects uncertain repeated deviation patterns without assigning a group meaning', () => {
  const f = structuredClone(examples.find((f) => f.kind === 'fenced-deviation-record-prefix'))
  const stub = f.items.find(
    (i: { text: string; baseline: number }) => i.text === 'XX' && i.baseline > 260
  )
  stub.text = 'XY'
  expect(refineTable(f.table, f.items, f.captions, [], f.rules, f.runs).repairs).not.toContain(
    'native-repeated-deviation-source-records-recovered'
  )
})
