import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverSharedSampleCountHeaderBands } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-source-records.mjs')).href
)
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )

it('retains both follow-up parent populations and their sample-qualified pairs in complete refinement', () => {
  const f = load('three-tier-retention-header-above-native-count-records')
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.unassigned).toEqual([])
  expect(r.grid[0][3]).toBe('Time 2')
  expect(r.grid[0][8]).toBe('Time 3')
  expect(r.grid[1][5]).toBe('Dropped (n = 71)')
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 3, colSpan: 5, text: 'Time 2' })
  )
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 1, column: 5, colSpan: 2, text: 'Dropped (n = 71)' })
  )
})

it('owns a shared summary below two separate cohorts before a falsely predicted body-header record', () => {
  const f = load('shared-summary-heading-before-model-misclassified-first-record')
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.unassigned).toEqual([])
  expect(r.grid[0].slice(1, 3)).toEqual(['Treatment group', 'Comparator group'])
  expect(r.grid[1].slice(1, 3)).toEqual(['Median (IQR)', ''])
  expect(r.grid[2][0]).toBe('Outcome alpha')
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 1, column: 1, colSpan: 2, text: 'Median (IQR)' })
  )
})

it('does not transfer unrelated copy into a shared cohort summary', () => {
  const f = load('shared-summary-heading-before-model-misclassified-first-record')
  f.tokens.find((i: { text: string }) => i.text === 'Median (IQR)').text = 'Unrelated detail'
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(
    r.cells.some(
      (c: { text: string; colSpan: number }) => c.text === 'Unrelated detail' && c.colSpan === 2
    )
  ).toBe(false)
})

it('does not construct follow-up population spans without their native parent underlines', () => {
  const f = load('three-tier-retention-header-above-native-count-records')
  f.rules = f.rules.filter((r: number[]) => r[1] >= 227)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(
    r.cells.some(
      (c: { row: number; column: number; colSpan: number }) =>
        c.row === 0 && c.column === 3 && c.colSpan === 5
    )
  ).toBe(false)
})

it('retains a shared patient-count parent above two treatment headings and complete event rows', () => {
  const f = load('shared-sample-count-header-above-complete-event-records')
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[0]).toEqual([
    'Adverse event',
    'Number of patients (%)',
    '',
    'Odds ratio (95% CI) (treatment A vs treatment B)',
    'p-value'
  ])
  expect(r.grid[1].slice(1, 3)).toEqual(['Treatment A (n=3092)', 'Treatment B (n=3094)'])
  expect(r.cells).toContainEqual(
    expect.objectContaining({
      row: 0,
      column: 1,
      colSpan: 2,
      rowSpan: 1,
      text: 'Number of patients (%)'
    })
  )
  for (const column of [0, 3, 4])
    expect(r.cells).toContainEqual(expect.objectContaining({ row: 0, column, rowSpan: 2 }))
  expect(r.grid[2]).toEqual([
    'Event alpha',
    '1104 (35.7)',
    '1264 (40.9)',
    '0.80 (0.73, 0.89)',
    '<0.0001'
  ])
  expect(r.grid.at(-1)[0]).toBe('Event gamma')
  expect(r.unassigned).toEqual([])
})

it.each(['wide gap', 'missing sample', 'unrelated parent'])(
  'declines shared count ownership with %s',
  (kind) => {
    const f = load('shared-sample-count-header-above-complete-event-records')
    if (kind === 'wide gap') f.rules.find((r: number[]) => r[0] === 444 && r[1] < 600)[0] += 2
    if (kind === 'missing sample')
      f.tokens.find((i: { text: string }) => i.text === 'Treatment B (n=3094)').text = 'Treatment B'
    if (kind === 'unrelated parent')
      f.tokens.find((i: { text: string }) => i.text === 'Number of patients (%)').text =
        'Unrelated detail'
    const columns = f.table.structure.objects
      .filter((o: { label: string }) => o.label === 'table column')
      .sort((a: { rect: number[] }, b: { rect: number[] }) => a.rect[0] - b.rect[0])
    const [left, top, right] = f.table.cropRect
    const cuts = [
      left,
      ...columns
        .slice(1)
        .map((c: { rect: number[] }, n: number) => left + (columns[n].rect[2] + c.rect[0]) / 2),
      right
    ]
    expect(
      recoverSharedSampleCountHeaderBands(
        f.tokens.filter((i: { rect: number[] }) => i.rect[3] < 623.25),
        cuts,
        f.rules,
        top,
        623.25
      )
    ).toBeUndefined()
  }
)
