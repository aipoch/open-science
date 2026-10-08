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

const { populateTableCellText } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-text.mjs')).href
)

it.each(['complete', 'missing', 'conflicting'])(
  'retains exact item identities only for completely mapped cells (%s)',
  (kind) => {
    const items = [10, 30, 70].map((x, n) => ({
      text: n === 1 ? '=' : '10',
      rect: [x, 10, x + 10, 20],
      baseline: 20,
      height: 10,
      horizontal: true,
      sourceItem: { pageNumber: 3, index: [21, 3, 7][n], text: n === 1 ? '¼' : '10' }
    }))
    if (kind === 'missing') Object.assign(items[1], { sourceItem: undefined })
    if (kind === 'conflicting') items[1].sourceItem.index = 21
    const cells = [0, 1].map((column) => ({
      row: 0,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [column * 50, 0, column * 50 + 50, 30],
      items: []
    }))
    populateTableCellText({
      cells,
      items,
      pageItems: items,
      rows: [{ rect: [0, 0, 100, 30] }],
      columnRects: cells.map((c) => c.rect),
      headerRows: [],
      rules: [],
      bottom: 30,
      issues: new Set(),
      repairs: []
    })
    expect(cells[0]).toMatchObject({ text: '10 =' })
    expect(cells[1]).toMatchObject({
      text: '10',
      sourceItems: [{ pageNumber: 3, index: 7, text: '10' }]
    })
    if (kind === 'complete') {
      expect(cells[0]).toMatchObject({
        sourceItems: [
          { pageNumber: 3, index: 3, text: '¼' },
          { pageNumber: 3, index: 21, text: '10' }
        ]
      })
      items[1].sourceItem.text = 'changed after construction'
      expect(cells[0]).toMatchObject({
        sourceItems: [
          { pageNumber: 3, index: 3, text: '¼' },
          { pageNumber: 3, index: 21, text: '10' }
        ]
      })
    } else expect(cells[0]).not.toHaveProperty('sourceItems')
  }
)

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
