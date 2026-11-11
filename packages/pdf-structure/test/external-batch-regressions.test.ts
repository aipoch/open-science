import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

type Token = {
  text: string
  rect: [number, number, number, number]
  baseline: number
  height: number
  horizontal: boolean
}

const token = (text: string, x: number, y: number, width = 70, height = 10): Token => ({
  text,
  rect: [x, y, x + width, y + height],
  baseline: y + height,
  height,
  horizontal: true
})

it('recovers a missing lane in a repeated mathematical interval table', () => {
  const table = {
    id: 'wide-math-table',
    cropRect: [0, 0, 800, 160],
    structure: {
      objects: [
        ...[
          [0, 0, 100, 160],
          [100, 0, 240, 160],
          [210, 0, 300, 160],
          [300, 0, 400, 160],
          [400, 0, 500, 160],
          [500, 0, 600, 160],
          [600, 0, 800, 160]
        ].map((rect) => ({ label: 'table column', rect })),
        ...[
          [0, 30, 800, 50],
          [0, 50, 800, 70],
          [0, 70, 800, 90],
          [0, 90, 800, 110]
        ].map((rect) => ({ label: 'table row', rect })),
        { label: 'table column header', rect: [0, 0, 800, 30] }
      ]
    }
  }
  const headers = [
    ['Cases', 10],
    ['Mwd', 130],
    ['Md', 230],
    ['Pgr', 330],
    ['Pml', 430],
    ['Psmb', 530],
    ['Pcarb', 630],
    ['Pamb', 730]
  ].map(([text, x]) => token(String(text), Number(x), 5, 40))
  const records = [
    ['A', '0.7', '0.41 - 0.44', '0.9 - 1.0', '5.9 - 6.2', '2.6 - 2.9', '12.1 - 12.4', '6.3 - 6.4'],
    ['B', '0.9', '0.47 - 0.50', '1.3 - 1.4', '4.3 - 4.5', '2.5 - 2.8', '10.1 - 10.3', '5.1 - 5.2'],
    ['C', '1.2', '0.55 - 0.59', '1.9 - 2.0', '2.9 - 3.1', '2.5 - 2.8', '8.3 - 8.4', '4.0 - 4.1']
  ].flatMap((record, row) =>
    record.map((text, column) =>
      token(
        text,
        [10, 130, 230, 330, 430, 530, 630, 730][column],
        40 + row * 25,
        column < 2 ? 40 : 70
      )
    )
  )
  const result = refineTable(
    table,
    [...headers, ...records],
    [{ lines: ['Table 1. Constrained masses.'], rect: [0, -20, 300, -10] }]
  )
  expect(result.grid).toHaveLength(4)
  expect(result.grid[0]).toHaveLength(8)
  expect(result.grid[2]).toEqual([
    'B',
    '0.9',
    '0.47 - 0.50',
    '1.3 - 1.4',
    '4.3 - 4.5',
    '2.5 - 2.8',
    '10.1 - 10.3',
    '5.1 - 5.2'
  ])
  expect(result.repairs).toContain('source-wide-math-columns-recovered')
})

it('keeps an open grouped header and its first boolean record in the grid', () => {
  const table = {
    id: 'grouped-header-table',
    cropRect: [0, 0, 600, 140],
    structure: {
      objects: [
        ...Array.from({ length: 6 }, (_, column) => ({
          label: 'table column',
          rect: [column * 100, 0, (column + 1) * 100, 140]
        })),
        ...[
          [0, 0, 600, 30],
          [0, 30, 600, 50],
          [0, 50, 600, 70],
          [0, 70, 600, 90],
          [0, 90, 600, 110]
        ].map((rect) => ({ label: 'table row', rect })),
        { label: 'table column header', rect: [0, 0, 600, 30] },
        { label: 'table spanning cell', rect: [0, 0, 200, 18] }
      ]
    }
  }
  const headers = [
    token('Objective Guidance', 55, 3, 90),
    token('|λ−488| (↓)', 220, 3, 90),
    token('Brightness', 320, 3),
    token('Length', 420, 3),
    token('Validity Rate', 510, 3, 80),
    token('|λ−488|', 20, 18),
    token('Brightness', 120, 18)
  ]
  const records = [
    ['✓', '✓', '3.7557', '54.0159', '214', '1.0'],
    ['✓', '×', '2.9810', '31.2600', '213', '1.0'],
    ['×', '✓', '12.9500', '62.1200', '214', '1.0'],
    ['×', '×', '32.8200', '25.0200', '213', '1.0']
  ].flatMap((record, row) =>
    record.map((text, column) =>
      token(text, column * 100 + 20, 38 + row * 20, column < 2 ? 15 : 45)
    )
  )
  const result = refineTable(
    table,
    [...headers, ...records],
    [{ lines: ['Table 1. Objective guidance.'], rect: [0, -20, 300, -10] }]
  )
  expect(result.grid.slice(0, 2)).toEqual([
    ['Objective Guidance', '', '|λ−488| (↓)', 'Brightness', 'Length', 'Validity Rate'],
    ['|λ−488|', 'Brightness', '', '', '', '']
  ])
  expect(result.grid[2]).toEqual(['✓', '✓', '3.7557', '54.0159', '214', '1.0'])
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 0, colSpan: 2, text: 'Objective Guidance' })
  )
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 4, rowSpan: 2, text: 'Length' })
  )
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('native-open-grouped-header-recovered')
})

it('keeps a wrapped comparison heading in one complete native header band', async () => {
  const { recoverWrappedComparisonHeader } = await import(
    pathToFileURL(resolve('resources/literature-pdf-native-header-grid.mjs')).href
  )
  const items = [
    token('Measure', 10, 20, 50),
    token('Response analy-', 110, 20, 80),
    token('sis', 110, 40, 20),
    token('Control', 210, 20, 60),
    token('estimate', 210, 40, 60),
    ...['Accuracy', 'Recall', 'Score'].flatMap((text, n) => [
      token(text, 10, 80 + n * 20, 50),
      token('0.82', 110, 80 + n * 20, 30),
      token('0.71', 210, 80 + n * 20, 30)
    ])
  ]
  const table = { cropRect: [0, 0, 300, 150] }
  const captions = [{ lines: ['Table 1: Model comparison.'] }]
  const rules = [10, 60, 145].map((y) => [0, y, 300, y])
  const result = recoverWrappedComparisonHeader(table, items, captions, rules)
  expect(result?.rows).toHaveLength(4)
  expect(result?.rows[0]).toEqual([0, 10, 300, 60])
  expect(result?.ownedTokens.size).toBe(items.length)
  expect(recoverWrappedComparisonHeader(table, items, captions, rules.slice(1))).toBeUndefined()
  expect(
    recoverWrappedComparisonHeader(
      table,
      [...items, token('Foreign heading', 170, 40, 70)],
      captions,
      rules
    )
  ).toBeUndefined()
})
