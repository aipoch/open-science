import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { recoverNativeRightmostNumericColumn, normalizeNativeRightmostHeader } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

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
})

it('keeps the exact terminal header and returns adjacent prose to diagnostics', () => {
  const exact = { text: 'drop 50%', rect: [430, 20, 475, 28], sourceItem: { text: 'drop 50%' } }
  const prose = { text: '≥ 0 .', rect: [430, 16, 452, 19], sourceItem: { text: '≥ 0 .' } }
  const cells = [{ text: '≥ 0. drop 50%', sourceTokens: [prose, exact] }]
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
  expect(unassigned).toEqual(['≥ 0 .'])
  expect(issues.has('unassigned-source-text')).toBe(true)
})
