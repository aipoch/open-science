import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

function reconstruct(name: string): string[][] {
  const source = readPdfFixture(
    resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`)
  )
  return refineTable(source.table, source.tokens, source.captions, [], source.rules).grid
}

it('preserves a source percentage without inventing its missing count', () => {
  const grid = reconstruct('wrapped-threshold-label')
  const section = grid.findIndex((row) => row[0] === 'M staging')
  expect(section).toBeGreaterThan(0)
  expect(grid[section + 3]).toEqual(['Unknown', '2 (3.7)', '(0.0)', '0.208'])
})

it('preserves printed totals and percentages even when they are inconsistent', () => {
  const grid = reconstruct('empty-overlapping-row')
  expect(grid.find((row) => row[0] === 'Other Asian')).toEqual([
    'Other Asian',
    '10/78 (12.8)',
    '20/78 (25.6)',
    '56/156 (35.9)'
  ])
  expect(grid.find((row) => row[0] === 'Europe/United Kingdom')).toEqual([
    'Europe/United Kingdom',
    '6/78 (7.8)',
    '8/78 (10.2)',
    '14/78 (17.9)'
  ])
})

it('keeps values at their printed positions rather than inferring demographic labels', () => {
  const grid = reconstruct('source-displaced-values')
  expect(grid.slice(1, 6)).toEqual([
    ['Demographics', '57.0 ± 9.1', '57.9 ± 8.7', '55.9 ± 9.5'],
    ['Age (yr, mean ± SD)', '162.0 ± 6.4', '162.2 ± 6.3', '162.0 ± 6.6'],
    ['Height (cm, mean ± SD)', '73.3 ± 14.1', '74.4 ± 13.2', '72.0 ± 14.6'],
    ['Weight (kg, mean ± SD)', '27.8 ± 4.8', '28.2 ± 4.8', '27.3 ± 4.7'],
    ['BMI (kg/m2, mean ± SD)', '', '', '']
  ])
})
