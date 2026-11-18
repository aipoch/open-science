/* eslint-disable @typescript-eslint/explicit-function-return-type -- test fixtures */
import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const {
  recoverNativeRightmostNumericColumn,
  normalizeNativeRightmostHeader,
  recoverNativeUnassignedNumericCell
} = await import(pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href)

it('recovers a proved rightmost numeric lane beyond the detector crop', () => {
  let index = 0
  const item = (text: string, x: number, y: number, width = 24) => ({
    text,
    rect: [x, y, x + width, y + 8],
    baseline: y + 8,
    height: 8,
    horizontal: true,
    pageNumber: 1,
    index: index++
  })
  const header = [
    item('Dataset (type)', 10, 20, 70),
    item('OmniST', 120, 20),
    item('NN', 190, 20),
    item('drop 30%', 250, 20, 45),
    item('drop 50%', 430, 20, 45)
  ]
  const body = ['Delhi AQ', 'Beijing AQ', 'Weather', 'Traffic'].flatMap((label, row) => {
    const y = 35 + row * 12
    return [
      item(label, 10, y, 55),
      item(`0.91${row}`, 120, y),
      item(`0.92${row}`, 190, y),
      item(`0.93${row}`, 250, y),
      item(`0.94${row}`, 430, y)
    ]
  })
  const table = {
    id: 'page-1-table-1',
    rowCount: 5,
    columnCount: 4,
    cropRect: [0, 0, 400, 100],
    structure: {
      objects: Array.from({ length: 4 }, (_, column) => ({
        label: 'table column',
        rect: [column * 100, 0, (column + 1) * 100, 100]
      }))
    }
  }
  const result = recoverNativeRightmostNumericColumn(
    table,
    [...header, ...body],
    [
      [0, 15, 500, 15],
      [0, 90, 500, 90]
    ],
    [{ page: 1, lines: ['Table 1. Evaluation results.'], rect: [0, -15, 500, -5] }]
  )
  expect(result).toMatchObject({
    repair: 'native-rightmost-numeric-column-recovered',
    cropRect: [0, 0, expect.any(Number), 100]
  })
  expect(result.cropRect[2]).toBeGreaterThan(400)
  expect(
    recoverNativeRightmostNumericColumn(
      table,
      [...header, ...body],
      [
        [0, 15, 500, 15],
        [0, 90, 500, 90]
      ],
      [{ page: 1, lines: ['Table 1. Evaluation results.'], rect: [0, -15, 500, -5] }],
      { columns: [] }
    )
  ).toBeUndefined()
})

it('keeps the exact terminal header and returns adjacent prose to diagnostics', () => {
  const exact = { text: 'drop 50%', rect: [430, 20, 475, 28], sourceItem: { text: 'drop 50%' } }
  const prose = { text: '≥ 0 .', rect: [430, 16, 452, 19], sourceItem: { text: '≥ 0 .' } }
  const cells = [
    {
      text: '≥ 0. drop 50%',
      sourceItems: [prose, exact],
      sourceTokens: [prose, exact]
    }
  ]
  const unassigned: string[] = []
  const issues = new Set<string>()
  expect(
    normalizeNativeRightmostHeader({
      cells,
      items: [exact, prose],
      repairs: ['native-rightmost-numeric-column-recovered'],
      unassigned,
      issues
    })
  ).toBe(true)
  expect(cells[0].text).toBe('drop 50%')
  expect(cells[0].sourceItems).toEqual([exact])
  expect(cells[0].sourceTokens).toEqual([exact])
  expect(unassigned).toEqual(['≥ 0 .'])
  expect(issues.has('unassigned-source-text')).toBe(true)
})

it('does not move an unassigned numeric value across row boundaries', () => {
  const columnRects = Array.from({ length: 9 }, (_, column) => [
    column * 10,
    0,
    column * 10 + 10,
    100
  ])
  const item = {
    text: '399 (6.1%)',
    rect: [81, 80, 89, 88],
    baseline: 88,
    height: 8,
    horizontal: true
  }
  const cells = Array.from({ length: 5 }, (_, row) =>
    Array.from({ length: 9 }, (_, column) => ({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      text: row === 2 && column === 8 ? '' : `${row}${column} (1.0%)`,
      rect: [column * 10, row * 20 + 10, column * 10 + 10, row * 20 + 18],
      sourceItems: row === 2 && column === 8 ? [] : [{ baseline: row * 20 + 18 }],
      sourceTokens: row === 2 && column === 8 ? [] : [{ baseline: row * 20 + 18 }]
    }))
  ).flat()
  const unassigned = ['399 (6.1%)'] as string[] & { reconciliationItems?: unknown[] }
  Object.defineProperty(unassigned, 'reconciliationItems', { value: [item] })
  const repairs: string[] = []
  const issues = new Set(['unassigned-source-text'])
  expect(
    recoverNativeUnassignedNumericCell({
      table: { cropRect: [0, 0, 90, 110] },
      cells,
      rows: Array.from({ length: 5 }, (_, row) => ({ rect: [0, row * 20, 90, row * 20 + 20] })),
      columnRects,
      unassigned,
      issues,
      repairs
    })
  ).toBe(false)
  expect(unassigned).toEqual(['399 (6.1%)'])
  expect(repairs).toEqual([])
})
