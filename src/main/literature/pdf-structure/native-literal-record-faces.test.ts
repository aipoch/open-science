import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const examples = readFileSync(
  resolve('src/main/literature/pdf-structure/fixtures/native-literal-record-faces.jsonl'),
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
const sizes: Record<string, [number, number]> = {
  'paired-scalar-lanes': [31, 14],
  'scientific-baselines': [8, 8],
  'short-rule-records': [8, 4],
  'wrapped-reference': [9, 4],
  'continued-value-faces': [9, 3],
  'posterior-section-faces': [22, 9],
  'paired-parent-stub': [6, 7]
}

for (const [kind, [rows, columns]] of Object.entries(sizes)) {
  it(`retains every literal source glyph exactly once in ${kind}`, () => {
    const input = fixture(kind),
      before = structuredClone(input),
      result = run(input)
    expect(result.grid).toHaveLength(rows)
    expect(result.grid.every((r: string[]) => r.length === columns)).toBe(true)
    expect(result.unassigned).toEqual([])
    // The wrapped-reference example retains the existing rich mathematical
    // serialization in other columns; this repair owns only its prose tail.
    if (kind !== 'wrapped-reference') {
      expect(characters(result.cells.map((c: { text: string }) => c.text).join(''))).toBe(
        characters(input.items.map((i: { text: string }) => i.text).join(''))
      )
    } else {
      // All prose is anonymized, so identify the two printed source baselines.
      const wrapped = result.cells.filter(
        (c: { column: number; sourceTokens?: { baseline: number }[] }) =>
          c.column === 3 && new Set(c.sourceTokens?.map((i) => i.baseline)).size > 1
      )
      expect(wrapped.length).toBeGreaterThan(0)
      expect(result.repairs).toContain('native-wrapped-reference-tail-recovered')
      for (const cell of wrapped)
        expect(characters(cell.text)).toBe(
          characters(cell.sourceTokens.map((i: { text: string }) => i.text).join(''))
        )
    }
    const selected = result.cells.flatMap((c: { sourceTokens?: unknown[] }) => c.sourceTokens ?? [])
    expect(new Set(selected).size).toBe(selected.length)
    expect(input).toEqual(before)
  })

  it(`preserves ${kind} after changing input enumeration order`, () => {
    const input = fixture(kind),
      expected = run(input).grid
    input.items.reverse()
    input.rules.reverse()
    input.runs.reverse()
    expect(run(input).grid).toEqual(expected)
  })
}

it('keeps every E/F pair separate while sharing only printed pair fields', () => {
  const result = run(fixture('paired-scalar-lanes'))
  expect(result.repairs).toContain('native-paired-scalar-source-records-recovered')
  for (let row = 1; row < 31; row += 2) {
    expect(result.grid[row][1]).toBe('E')
    expect(result.grid[row + 1][1]).toBe('F')
    for (const column of [0, 2, 11, 12, 13]) {
      expect(
        result.cells.find(
          (c: { row: number; column: number }) => c.row === row && c.column === column
        ).rowSpan
      ).toBe(2)
    }
  }
})

it('retains all three posterior summaries and complete decimal fields', () => {
  const result = run(fixture('posterior-section-faces'))
  expect(result.repairs).toContain('native-posterior-section-records-recovered')
  for (const row of [7, 14, 21]) {
    const summary = result.cells.find(
      (c: { row: number; column: number }) => c.row === row && c.column === 0
    )
    expect(summary.colSpan).toBe(9)
    expect(summary.text).toMatch(/^ln.*: free, fixed/u)
    expect(summary.text.match(/±/gu)).toHaveLength(2)
  }
  expect(result.grid.flat().some((text: string) => text === '0.073')).toBe(true)
  expect(result.grid.flat().some((text: string) => text.includes('6/√60'))).toBe(true)
})

it('keeps missing continued stubs empty and preserves proved merged physical faces', () => {
  const result = run(fixture('continued-value-faces'))
  expect(result.repairs).toContain('native-continued-physical-value-faces-recovered')
  expect(result.grid[0][0]).toBe('')
  expect(
    result.cells.filter(
      (c: { colSpan: number; column: number }) => c.column === 1 && c.colSpan === 2
    ).length
  ).toBeGreaterThanOrEqual(2)
})

it('refuses paired source recovery when the literal TJ proof is missing', () => {
  const input = fixture('paired-scalar-lanes')
  input.runs = []
  expect(run(input).repairs).not.toContain('native-paired-scalar-source-records-recovered')
})

it('refuses paired source recovery when one printed marker reverses its face', () => {
  const input = fixture('paired-scalar-lanes')
  const marker = input.items.find((i: { text: string }) => i.text === 'F')
  marker.text = 'E'
  expect(run(input).repairs).not.toContain('native-paired-scalar-source-records-recovered')
})

it('refuses a physical value face with a partial internal divider', () => {
  const input = fixture('continued-value-faces')
  const recovered = run(input),
    merged = recovered.cells.find((c: { colSpan: number }) => c.colSpan === 2)
  const vertical = [
    ...new Set<number>(
      input.rules.filter((r: number[]) => r[0] === r[2]).map((r: number[]) => r[0])
    )
  ].sort((a, b) => a - b)
  input.rules.push([vertical[2], merged.rect[1] + 2, vertical[2], merged.rect[1] + 5])
  expect(run(input).repairs).not.toContain('native-continued-physical-value-faces-recovered')
})

it('refuses posterior recovery when a scalar row contains ordinary prose', () => {
  const input = fixture('posterior-section-faces')
  const cell = run(input).cells.find(
    (c: { row: number; column: number }) => c.row === 4 && c.column === 6
  )
  const token = cell.sourceTokens.find((i: { height: number }) => i.height > 12)
  const source = input.items.find(
    (i: { text: string; rect: number[] }) =>
      i.text === token.text && i.rect.every((v, n) => v === token.rect[n])
  )
  source.text = 'ordinary paragraph'
  expect(run(input).repairs).not.toContain('native-posterior-section-records-recovered')
})

it('preserves explanatory prose below the closing rule outside recovered cells', () => {
  const input = fixture('posterior-section-faces'),
    crop = input.table.cropRect
  const text = 'The following paragraph remains outside the native table.'
  input.items.push({
    text,
    rect: [crop[0] + 3, crop[3] - 7, crop[2] - 3, crop[3] + 7],
    baseline: crop[3] + 7,
    height: 14,
    horizontal: true
  })
  const result = run(input)
  expect(result.repairs).toContain('native-posterior-section-records-recovered')
  expect(result.cells.some((c: { text: string }) => c.text.includes('following paragraph'))).toBe(
    false
  )
  expect(input.items.at(-1).text).toBe(text)
})

it('does not swallow a second value printed beside a final wrapped stub tail', () => {
  const input = fixture('paired-parent-stub')
  const tail = input.items.find((i: { text: string }) => /^XXX\(XXXXXX\)$/u.test(i.text))
  input.items.push({
    text: '1.2x3.4',
    rect: [260, tail.rect[1], 310, tail.rect[3]],
    baseline: tail.baseline,
    height: tail.height,
    horizontal: true
  })
  expect(run(input).repairs).not.toContain('native-paired-parent-stub-tail-recovered')
})
