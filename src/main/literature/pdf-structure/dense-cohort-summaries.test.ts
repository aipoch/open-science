import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/dense-summary-and-count-records-with-unassigned-section.jsonl'
    )
  )

it('restores every dense summary and count record without losing a later native section', () => {
  const f = fixture()
  const table = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(table.unassigned).toEqual([])
  expect(table.grid).toContainEqual([
    'Mean dose in Gy, mean; SD (range)',
    '14.8; 8.2 (1.3 – 51.0)',
    '15.9; 8.1 (1.3 – 51.0)',
    '13.9; 8.2 (1.4 – 36.0)',
    '0.075'
  ])
  expect(table.grid).toHaveLength(15)
  expect(table.cells).toContainEqual(expect.objectContaining({ text: 'Region B', colSpan: 5 }))
})

it('does not override the model when a cohort gutter contains overlapping native values', () => {
  const f = fixture()
  const measured = f.tokens.find((i: { text: string }) => i.text.includes('14.8;'))
  measured.rect[2] += 100
  const table = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(table.issues.length).toBeGreaterThan(0)
})
