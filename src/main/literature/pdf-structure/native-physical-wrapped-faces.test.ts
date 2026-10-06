import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const examples = readFileSync(
  resolve('src/main/literature/pdf-structure/fixtures/native-physical-wrapped-faces.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const fixture = (kind: string): ReturnType<typeof JSON.parse> =>
  structuredClone(examples.find((f) => f.kind === kind))
const run = (f: ReturnType<typeof fixture>): ReturnType<typeof refineTable> =>
  refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)
const chars = (text: string): string => [...text.replace(/\s/gu, '')].sort().join('')
const closedLiteralFrame = (): ReturnType<typeof JSON.parse> => {
  const xs = Array.from({ length: 22 }, (_, c) => 100 + c * 40),
    ys = [100, 120, 136, 152, 168, 184]
  const items = xs.slice(1).map((_, c) => ({
    text: `Head${c}`,
    rect: [xs[c] + 4, 99.3, xs[c] + 24, 107.3],
    baseline: 107.3,
    height: 8,
    horizontal: true
  }))
  for (let r = 1; r < 5; r++)
    for (let c = 0; c < 4; c++)
      items.push({
        text: c ? String(r + c) : `R${r}`,
        rect: [xs[c] + 4, ys[r] + 3, xs[c] + 18, ys[r] + 11],
        baseline: ys[r] + 11,
        height: 8,
        horizontal: true
      })
  const right = xs.at(-1)!,
    crop = [99, 99, right + 1, 185],
    rules = [...xs.map((x) => [x, 100, x, 184]), ...ys.map((y) => [100, y, right, y])]
  return {
    table: {
      id: 'native-table-1',
      cropRect: crop,
      structure: {
        objects: [
          ...xs
            .slice(1)
            .map((x, c) => ({ label: 'table column', rect: [xs[c] - 99, 1, x - 99, 85] })),
          ...ys
            .slice(1)
            .map((y, r) => ({ label: 'table row', rect: [1, ys[r] - 99, right - 99, y - 99] }))
        ]
      }
    },
    items,
    rules,
    captions: [{ lines: ['Table 1. Literal faces.'], rect: [100, 82, 180, 92] }],
    runs: []
  }
}
it('retains the bounded source advance margin only for a completely owned native frame', () => {
  const f = closedLiteralFrame(),
    r = run(f)
  expect(r.cropRect[1]).toBeCloseTo(99.3)
  expect(r.grid).toHaveLength(5)
  expect(chars(r.cells.map((c: { text: string }) => c.text).join(''))).toBe(
    chars(f.items.map((i: { text: string }) => i.text).join(''))
  )
})
it('does not widen that native frame into neighboring prose', () => {
  const f = closedLiteralFrame()
  f.items.push({
    text: 'Neighbor',
    rect: [182, 99.5, 200, 99.9],
    baseline: 99.9,
    height: 0.4,
    horizontal: true
  })
  expect(run(f).cropRect[1]).toBe(100)
})
it('ends the native stub enclosure before the two physically shared footer faces', () => {
  const f = fixture('physical-footer-and-stub-faces'),
    before = structuredClone(f),
    r = run(f)
  expect(
    r.cells.find((c: { row: number; column: number }) => c.row === 5 && c.column === 0)?.rowSpan
  ).toBe(7)
  for (const row of [4, 12])
    expect(
      r.cells.find((c: { row: number; column: number }) => c.row === row && c.column === 0)?.colSpan
    ).toBe(2)
  expect(chars(r.cells.map((c: { text: string }) => c.text).join(''))).toBe(
    chars(f.items.map((i: { text: string }) => i.text).join(''))
  )
  expect(r.unassigned).toEqual([])
  expect(f).toEqual(before)
})
it('owns a direction glyph with its metric stub at the common source gutter', () => {
  const f = fixture('metric-direction-common-gutter'),
    before = structuredClone(f),
    r = run(f)
  expect(r.grid[2][0]).toMatch(/↑$/u)
  expect(r.grid[2][1]).toBe('∞')
  expect(chars(r.cells.map((c: { text: string }) => c.text).join(''))).toBe(
    chars(f.items.map((i: { text: string }) => i.text).join(''))
  )
  expect(r.unassigned).toEqual([])
  expect(f).toEqual(before)
})
it('retains a complete scalar record that the model represented as blank rows', () => {
  const f = fixture('complete-section-scalar-records'),
    before = structuredClone(f),
    r = run(f)
  expect(r.grid.some((row: string[]) => row.join('|') === '1|4.932|1.279|36.027|2.280|35')).toBe(
    true
  )
  expect(r.grid[0]).toHaveLength(6)
  expect(chars(r.cells.map((c: { text: string }) => c.text).join(''))).toBe(
    chars(f.items.map((i: { text: string }) => i.text).join(''))
  )
  expect(r.unassigned).toEqual([])
  expect(f).toEqual(before)
})
it('does not rebuild ordinary three-column prose as a scalar comparison', () => {
  const f = fixture('wrapped-comparison-source-records')
  for (const item of f.items) item.text = item.text.replace(/\d/gu, 'a')
  const before = structuredClone(f),
    r = run(f)
  expect(r.repairs).not.toContain('native-wrapped-stub-scalar-records-recovered')
  expect(f).toEqual(before)
})
it('does not infer a missing scalar in an incomplete section peer row', () => {
  const f = fixture('complete-section-scalar-records')
  f.items = f.items.filter(
    (i: { text: string; baseline: number }) =>
      !(i.text === '1.279' && Math.abs(i.baseline - 410.23) < 1)
  )
  expect(run(f).repairs).not.toContain('native-section-scalar-peer-records-recovered')
})
it('keeps each complete shared decimal in its closed lower-panel face', () => {
  const f = fixture('physical-shared-decimal-faces'),
    before = structuredClone(f),
    r = run(f)
  expect(
    r.cells.some((c: { text: string; colSpan: number }) => c.text === '1.116' && c.colSpan === 2)
  ).toBe(true)
  expect(
    r.cells.some((c: { text: string; colSpan: number }) => c.text === '1.3 X' && c.colSpan === 2)
  ).toBe(true)
  expect(chars(r.cells.map((c: { text: string }) => c.text).join(''))).toBe(
    chars(f.items.map((i: { text: string }) => i.text).join(''))
  )
  expect(f).toEqual(before)
})
for (const [kind, count] of [
  ['wrapped-comparison-source-records', 19],
  ['wrapped-scalar-stub-records', 3]
] as const) {
  it(`keeps wrapped fields in their complete physical record: ${kind}`, () => {
    const f = fixture(kind),
      before = structuredClone(f),
      r = run(f)
    expect(r.grid).toHaveLength(count)
    expect(r.grid.slice(1).every((row: string[]) => row[0].trim().length > 0)).toBe(true)
    expect(chars(r.cells.map((c: { text: string }) => c.text).join(''))).toBe(
      chars(f.items.map((i: { text: string }) => i.text).join(''))
    )
    expect(r.unassigned).toEqual([])
    expect(f).toEqual(before)
  })
}
for (const kind of [
  'physical-shared-decimal-faces',
  'wrapped-comparison-source-records',
  'wrapped-scalar-stub-records'
]) {
  it(`does not reconstruct ${kind} without its native rules`, () => {
    const f = fixture(kind)
    f.rules = []
    expect(
      run(f).repairs.some((s: string) =>
        /^native-(?:physical-rule-faces|wrapped-stub-scalar)/u.test(s)
      )
    ).toBe(false)
  })
  it(`rejects nonpositive source geometry in ${kind}`, () => {
    const f = fixture(kind),
      i = f.items.at(-1)
    i.rect[2] = i.rect[0]
    expect(
      run(f).repairs.some((s: string) =>
        /^native-(?:physical-rule-faces|wrapped-stub-scalar)/u.test(s)
      )
    ).toBe(false)
  })
}
it('refuses a partial restored divider instead of guessing a shared value face', () => {
  const f = fixture('physical-shared-decimal-faces')
  f.rules.push([737.6115, 539.5, 737.6115, 548])
  expect(run(f).repairs).not.toContain('native-physical-rule-faces-recovered')
})
it('retains ambiguous ink across a independently witnessed wrapped-record gutter', () => {
  const f = fixture('wrapped-scalar-stub-records'),
    i = f.items.find((i: { text: string }) => i.text === '9.776')
  i.rect[0] = 500
  expect(run(f).repairs).not.toContain('native-wrapped-stub-scalar-records-recovered')
})
it('does not inherit a centered empty group into either scalar record', () => {
  const f = fixture('wrapped-scalar-stub-records'),
    i = structuredClone(f.items[0])
  i.text = 'Group'
  i.rect = [500, 630, 650, 645]
  i.baseline = 645
  f.items.push(i)
  expect(run(f).repairs).not.toContain('native-wrapped-stub-scalar-records-recovered')
})
it('refuses an unattached small scientific glyph between complete records', () => {
  const f = fixture('wrapped-comparison-source-records'),
    i = structuredClone(f.items[0])
  i.text = '7'
  i.height = 5
  i.rect = [216, 130, 220, 135]
  i.baseline = 135
  f.items.push(i)
  expect(run(f).repairs).not.toContain('native-wrapped-stub-scalar-records-recovered')
})
it('leaves neighboring source prose outside the closing rule unconsumed', () => {
  const f = fixture('wrapped-scalar-stub-records'),
    i = structuredClone(f.items[0])
  i.text = 'Unrelated neighboring prose'
  i.rect = [177, 684, 440, 690]
  i.baseline = 690
  f.items.push(i)
  const r = run(f)
  expect(r.grid).toHaveLength(3)
  expect(r.cells.some((c: { text: string }) => c.text.includes('Unrelated'))).toBe(false)
})
it('keeps the literal source script attached to its proved comparison record', () => {
  const f = fixture('wrapped-comparison-source-records'),
    r = run(f)
  const marker = f.items.find((i: { text: string }) => i.text === '*')
  const cell = r.cells.find((c: { sourceTokens?: unknown[] }) => c.sourceTokens?.includes(marker))
  expect(cell.row).toBe(9)
  expect(cell.column).toBe(0)
})

it.each(['wrapped-scalar-stub-records', 'wrapped-comparison-source-records'])(
  'requires a literal numeric sign for complete scalar peers in %s',
  (kind) => {
    for (const prefix of ['A', '=', ':', '×']) {
      const input = fixture(kind)
      for (const item of input.items)
        if (/^\d+(?:\.\d+)?$/.test(item.text)) item.text = prefix + item.text
      const before = structuredClone(input)
      expect(run(input).repairs).not.toContain('native-wrapped-stub-scalar-records-recovered')
      expect(input).toEqual(before)
    }
  }
)

it.each(['wrapped-scalar-stub-records', 'wrapped-comparison-source-records'])(
  'retains printed positive and negative scalar peers in %s',
  (kind) => {
    for (const prefix of ['+', '-', '−']) {
      const input = fixture(kind)
      for (const item of input.items)
        if (/^\d+(?:\.\d+)?$/.test(item.text)) item.text = prefix + item.text
      expect(run(input).repairs).toContain('native-wrapped-stub-scalar-records-recovered')
    }
  }
)
