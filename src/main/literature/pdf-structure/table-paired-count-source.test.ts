import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )
const process = (x: ReturnType<typeof load>): ReturnType<typeof JSON.parse> => {
  const first = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  const n = associateTableNotes(
    x.page,
    [
      {
        rect: [
          first.cropRect[0],
          Math.min(...first.rows.map((r: { rect: number[] }) => r.rect[1])),
          first.cropRect[2],
          Math.max(...first.rows.map((r: { rect: number[] }) => r.rect[3]))
        ].map((v) => v / 1.5)
      }
    ],
    x.rules.map((r: number[]) => r.map((v) => v / 1.5))
  )[0]
  return {
    ...refineTable(
      x.table,
      x.tokens,
      x.captions,
      n.map((p: { rect: number[] }) => ({ ...p, rect: p.rect.map((v) => v * 1.5) })),
      x.rules
    ),
    notes: n
  }
}
it.each([
  [
    'paired-cohort-counts-with-omitted-terminal-category',
    'Negative',
    '16',
    '(80%)',
    '16',
    '(72.7%)'
  ],
  ['paired-cohort-counts-with-shifted-group-stub', 'B', '12', '(54.4%)', '10', '(45.5%)']
])('recovers the full final count record and source header in %s', (name, ...last) => {
  const x = load(name),
    original = structuredClone(x),
    t = process(x)
  expect(t.grid.at(-1).slice(1, 6)).toEqual(last)
  expect(t.grid[0][3]).toBe('')
  expect(t.cells).toContainEqual(expect.objectContaining({ row: 0, column: 2, colSpan: 2 }))
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
  expect(t.notes[0].text).toMatch(/^BI‐RADS,/)
  expect(x).toEqual(original)
  if (name.includes('shifted')) {
    expect(t.grid[2][0]).toBe('')
    expect(t.grid[3][0]).toBe('Biopsy')
  }
})
it('keeps a mean/standard-error note and its wrapped glossary', () => {
  const t = process(load('mean-standard-error-note-with-wrapped-glossary'))
  expect(t.notes[0]?.text).toMatch(/^Data reported as mean ± standard error \(SEM\)/)
})
