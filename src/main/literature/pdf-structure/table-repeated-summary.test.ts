import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )
const refine = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  refineTable(f.table, f.tokens, f.captions, [], f.rules)

it('keeps a short repeated measurement heading across the full section row', () => {
  const t = refine(fixture('repeated-section-heading'))
  for (const text of ['Age (yr)', 'Weight (kg)', 'Height (cm)']) {
    expect(t.cells.find((c: { text: string }) => c.text === text)).toMatchObject({
      column: 0,
      colSpan: 7,
      rowSpan: 1
    })
  }
  expect(t.grid).toHaveLength(21)
  expect(t.grid[11]).toEqual([
    'Median (range)',
    '156.5 (148.7-164.0)',
    '154.65 (146.8-163.8)',
    '156.0 (145.0-170.2)',
    '154.6 (146.8-167.0)',
    '162.0 (124.5-196.0)',
    '162.5 (142.2-179.7)'
  ])
  expect(t.unassigned).toEqual([])
})

it('shares repeated two-arm t statistics while retaining separate means, errors and sample sizes', () => {
  const t = refine(fixture('paired-lipid-statistics'))
  expect(t.grid).toHaveLength(6)
  for (const row of [2, 4])
    for (const column of [0, 5, 8, 11, 14]) {
      expect(
        t.cells.find((c: { row: number; column: number }) => c.row === row && c.column === column)
      ).toMatchObject({ rowSpan: 2, colSpan: 1 })
    }
  for (const c of t.cells.filter(
    (c: { row: number; column: number }) =>
      c.row >= 2 && [1, 2, 3, 4, 6, 7, 9, 10, 12, 13].includes(c.column)
  ))
    expect(c.rowSpan).toBe(1)
  expect(t.grid[3].slice(1, 6)).toEqual(['C', '365', '5.32', '0.046', ''])
  expect(t.unassigned).toEqual([])
})

it.each([
  'missing-header',
  'inconsistent-summary',
  'unindented-summary',
  'incomplete-summary',
  'independent-value'
])('does not infer a short section from %s', (variant) => {
  const f = fixture('repeated-section-heading')
  if (variant === 'missing-header')
    f.table.structure.objects = f.table.structure.objects.filter(
      (o: { label: string }) => o.label !== 'table projected row header'
    )
  if (variant === 'inconsistent-summary')
    f.tokens.find((i: { text: string }) => i.text === 'Median (range)').text = 'Description'
  if (variant === 'incomplete-summary')
    f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '156.5')
  if (variant === 'unindented-summary') {
    const heading = f.tokens.find((i: { text: string }) => i.text === 'Height (cm)')
    const next = f.tokens.find(
      (i: { text: string; baseline: number }) =>
        i.text === 'Median (range)' && i.baseline > heading.baseline
    )
    next.rect[2] -= next.rect[0] - heading.rect[0]
    next.rect[0] = heading.rect[0]
  }
  if (variant === 'independent-value') {
    const heading = f.tokens.find((i: { text: string }) => i.text === 'Height (cm)')
    f.tokens.push({ ...heading, text: '42', rect: [400, heading.rect[1], 412, heading.rect[3]] })
  }
  const t = refine(f)
  expect(t.cells.find((c: { text: string }) => c.text === 'Height (cm)').colSpan).not.toBe(7)
})

it.each([
  'wrong-statistic',
  'missing-footer',
  'partial-footer',
  'interior-rule',
  'different-arms',
  'missing-value',
  'own-statistic'
])('does not merge paired records with %s', (variant) => {
  const f = fixture('paired-lipid-statistics')
  if (variant === 'wrong-statistic') for (const i of f.tokens) if (i.text === 't') i.text = 'z'
  if (variant === 'missing-footer')
    f.rules = f.rules.filter((r: number[]) => Math.abs(r[1] - 286.72) > 1)
  if (variant === 'partial-footer')
    f.rules = f.rules.map((r: number[]) =>
      Math.abs(r[1] - 286.72) < 1 ? [r[0], r[1], 900, r[3]] : r
    )
  if (variant === 'interior-rule') f.rules.push([124, 231, 1049, 231])
  if (variant === 'different-arms')
    f.tokens.find(
      (i: { text: string; baseline: number }) => i.text === 'C' && i.baseline > 270
    ).text = 'D'
  if (variant === 'missing-value')
    f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '5.32')
  if (variant === 'own-statistic') {
    const anchor = f.tokens.find((i: { text: string }) => i.text === '5.32')
    f.tokens.push({ ...anchor, text: '0.31', rect: [477, anchor.rect[1], 500, anchor.rect[3]] })
  }
  const t = refine(f)
  expect(t.repairs).not.toContain('text-supported-comparison-rows-recovered')
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 2 && c.column === 0).rowSpan
  ).toBe(1)
})

it.each([
  ['repeated-section-heading', 132],
  ['paired-lipid-statistics', 84]
] as const)('retains every source token exactly once in %s', (name, count) => {
  const f = fixture(name),
    original = structuredClone(f),
    t = refine(f)
  const owned = t.cells.flatMap(
    (c: { sourceTokens: { text: string; rect: number[] }[] }) => c.sourceTokens
  )
  expect(owned).toHaveLength(count)
  expect(
    new Set(owned.map((i: { text: string; rect: number[] }) => JSON.stringify([i.text, i.rect])))
      .size
  ).toBe(count)
  expect(f).toEqual(original)
})
