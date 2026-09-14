import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledNarrativeGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-narrative-grid.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/bulleted-criteria.jsonl')
  )
it('keeps one-column criteria sections and every wrapped bullet in its source record', () => {
  const x = load(),
    before = structuredClone(x)
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toHaveLength(24)
  expect(t.grid.every((r: string[]) => r.length === 1)).toBe(true)
  expect(t.grid[0]).toEqual(['Inclusion Criteria'])
  expect(t.grid[8]).toEqual(['Exclusion criteria'])
  expect(t.grid.flat()).toContain('– Patients undergoing a preventive mastectomy')
  expect(t.grid.at(-1)[0]).toContain("doubts about the patient's compliance.")
  expect(t.unassigned).toEqual([])
  expect(x).toEqual(before)
})

it.each(['missing-border', 'broken-indent', 'two-data-columns', 'missing-caption'])(
  'does not collapse an unsupported narrative layout: %s',
  (kind) => {
    const x = load()
    if (kind === 'missing-border') x.rules = []
    if (kind === 'broken-indent')
      x.tokens.find((i: { text: string }) => i.text.startsWith('– Female')).rect[0] += 20
    if (kind === 'two-data-columns')
      x.table.structure.objects.find(
        (o: { label: string }) => o.label === 'table column'
      ).rect[2] += 90
    if (kind === 'missing-caption') x.captions = []
    expect(recoverRuledNarrativeGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
  }
)
