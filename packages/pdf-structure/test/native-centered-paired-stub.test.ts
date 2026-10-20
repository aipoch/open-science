import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { recoverUnassignedStubSpans } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-cell-text.mjs')).href
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  const rows = [{ rect: [0, 0, 300, 10] }, { rect: [0, 10, 300, 20] }]
  const stubs = [
    { row: 0, column: 0, rowSpan: 1, colSpan: 1, rect: [0, 0, 80, 10], items: [] },
    { row: 1, column: 0, rowSpan: 1, colSpan: 1, rect: [0, 10, 80, 20], items: [] }
  ]
  const metrics = [
    { row: 0, column: 1, rowSpan: 1, colSpan: 1, rect: [80, 0, 120, 10], items: [] },
    { row: 1, column: 1, rowSpan: 1, colSpan: 1, rect: [80, 10, 120, 20], items: [] }
  ]
  const values = [0, 1].flatMap((row) =>
    [2, 3].map((column) => ({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      text: '75',
      rect: [column * 40, row * 10, column * 40 + 20, row * 10 + 10],
      items: []
    }))
  )
  const metricSources = [
    { text: 'Acc%', rect: [90, 1, 110, 8], baseline: 7, height: 7, horizontal: true },
    { text: 'Pct', rect: [90, 11, 110, 18], baseline: 17, height: 7, horizontal: true }
  ]
  const model = {
    text: 'Model Label',
    rect: [10, 6, 70, 14],
    baseline: 12,
    height: 8,
    horizontal: true
  }
  const valueSources = values.map((cell, index) => ({
    text: String(70 + index),
    rect: [cell.rect[0] + 2, cell.rect[1] + 1, cell.rect[0] + 12, cell.rect[1] + 8],
    baseline: cell.rect[1] + 8,
    height: 7,
    horizontal: true
  }))
  const cells = [...stubs, ...metrics, ...values]
  const items = [model, ...metricSources, ...valueSources]
  const assignments = new Map([
    [model, stubs[1]],
    [metricSources[0], metrics[0]],
    [metricSources[1], metrics[1]],
    ...valueSources.map((source, index) => [source, values[index]])
  ])
  const repairs: string[] = []
  return { rows, cells, items, assignments, repairs, model, stubs, values, valueSources }
}

it('reanchors a model label to the pair proved by its metric baseline midpoint', () => {
  const { rows, cells, items, assignments, repairs, model, stubs } = fixture()

  recoverUnassignedStubSpans({ items, cells, rows, headerRows: [], assignments, repairs })

  const owner = assignments.get(model)
  expect(owner).toMatchObject({ row: 0, rowSpan: 2, origin: 'source-centered-paired-stub' })
  expect(cells).not.toContain(stubs[0])
  expect(cells).not.toContain(stubs[1])
  expect(repairs).toContain('centered-paired-stub-reanchored')
})

it('does not reanchor when either record has an incomplete numeric lane', () => {
  const { rows, cells, items, assignments, repairs, model, valueSources } = fixture()
  assignments.delete(valueSources[0])

  recoverUnassignedStubSpans({ items, cells, rows, headerRows: [], assignments, repairs })

  expect(assignments.get(model)?.rowSpan).toBe(1)
  expect(repairs).not.toContain('centered-paired-stub-reanchored')
})
