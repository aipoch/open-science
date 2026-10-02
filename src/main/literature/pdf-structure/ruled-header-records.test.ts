import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('src/main/literature/pdf-structure/fixtures', name + '.jsonl'))

it('uses segmented native header faces to retain a sample-size tail with its own cohort', () => {
  const f = fixture('segmented-header-over-deviation-records')
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid[0]).toEqual([
    '',
    'Control group (n = 55)',
    'Group A (n = 58)',
    'Group B (n = 59)'
  ])
  expect(result.grid.slice(1, 4).map((r: string[]) => r.slice(1))).toEqual([
    ['9.1 ± 6.6', '9.2 ± 6.5', '9.1 ± 6.3'],
    ['0.44 ± 0.3', '0.45 ± 0.3', '0.48 ± 0.31'],
    ['4.1 ± 3.1', '4.6 ± 3.5', '5.3 ± 3.8']
  ])
  expect(result.unassigned).toEqual([])
})

it('retains native location headers of an embedded questionnaire without consuming surrounding questions', () => {
  const f = fixture('embedded-questionnaire-grid-with-unpredicted-header')
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid[0]).toEqual(['', 'Chest Wall', 'Axilla', 'Arm'])
  expect(result.grid).toHaveLength(3)
  expect(
    result.grid.slice(1).every((r: string[]) => r.slice(1).every((s) => s === 'Yes □ No □'))
  ).toBe(true)
  expect(result.unassigned).toEqual([])
})
const { recoverQuestionnaireGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-narrative-grid.mjs')).href
)
it('does not recover an unbounded or incomplete embedded response matrix', () => {
  for (const mutation of ['border', 'response', 'header']) {
    const f = fixture('embedded-questionnaire-grid-with-unpredicted-header')
    if (mutation === 'border') f.rules = f.rules.slice(0, -1)
    if (mutation === 'response')
      f.tokens.find((i: { text: string }) => i.text === 'Yes').text = 'Maybe'
    if (mutation === 'header')
      f.tokens.find((i: { text: string }) => i.text === 'Arm').text =
        'A long narrative paragraph describes this location'
    expect(recoverQuestionnaireGrid(f.table, f.tokens, [], f.rules)).toBeUndefined()
  }
})
