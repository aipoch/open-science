import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

type TestToken = {
  text: string
  rect: [number, number, number, number]
  baseline: number
  height: number
  horizontal: boolean
  sourceItem: { pageNumber: number; index: number; text: string }
}

type TestRule = [number, number, number, number]

type Fixture = {
  source: TestToken[]
  rules: TestRule[]
  table: {
    id: string
    rowCount: number
    columnCount: number
    cropRect: [number, number, number, number]
    structure: {
      objects: Array<{
        label: string
        rect: [number, number, number, number]
      }>
    }
  }
}

const fixture = (): Fixture => {
  let index = 0
  const token = (text: string, x: number, y: number, width = 30): TestToken => ({
    text,
    rect: [x, y, x + width, y + 10],
    baseline: y + 10,
    height: 10,
    horizontal: true,
    sourceItem: { pageNumber: 3, index: index++, text }
  })
  const edges = [
    102.32, 116.37, 143.54, 174.01, 201.18, 228.35, 255.53, 282.7, 309.87, 337.04, 367.51, 397.98,
    425.15, 455.61, 486.08, 516.55, 543.72, 570.89, 601.36, 628.53, 655.7
  ]
  const rules = edges.map((y) => [81, y, 455.48, y])
  for (const x of [81.3, 223.14, 268.24, 410.08, 455.18])
    for (let row = 0; row < edges.length - 1; row++)
      rules.push([x, edges[row] + 0.3, x, edges[row + 1] - 0.3])
  const source = [
    token('Service Key', 121, 104, 62),
    token('Icon', 232, 104, 23),
    token('Service Key', 308, 104, 62),
    token('Icon', 419, 104, 23),
    ...Array.from({ length: 19 }, (_, row) => {
      const top = edges[row + 1] + 3
      return [
        token(`Label ${row + 1}`, 100 + (row % 3) * 4, top, 85),
        token(`Value ${row + 1}`, 287 + (row % 3) * 4, top, 90)
      ]
    }).flat()
  ]
  return {
    source,
    rules,
    table: {
      id: 'page-3-table-1',
      rowCount: 19,
      columnCount: 3,
      cropRect: [83, 89, 451, 657],
      structure: {
        objects: [
          ...[
            [11, 27, 138, 566],
            [137, 27, 186, 566],
            [187, 27, 315, 566]
          ].map((rect) => ({ label: 'table column', rect })),
          ...edges.slice(0, -1).map((y, n) => ({
            label: 'table row',
            rect: [0, y - 89, 368, edges[n + 1] - 89]
          }))
        ]
      }
    }
  }
}

it('restores empty icon lanes from a complete four-column ruled grid', () => {
  const f = fixture()
  const result = refineTable(
    f.table,
    f.source,
    [{ page: 3, lines: ['Table I: Paired service keys and icons.'], rect: [0, 0, 240, 15] }],
    [],
    f.rules
  )

  expect(result.grid[0]).toEqual(['Service Key', 'Icon', 'Service Key', 'Icon'])
  expect(result.grid).toHaveLength(20)
  expect(
    result.grid.slice(1).every((row: string[]) => row.length === 4 && !row[1] && !row[3])
  ).toBe(true)
  expect(result.grid.slice(1).map((row: string[]) => [row[0], row[2]])).toEqual(
    Array.from({ length: 19 }, (_, row) => [`Label ${row + 1}`, `Value ${row + 1}`])
  )
  expect(result.cropRect[0]).toBeLessThanOrEqual(81)
  expect(result.cropRect[2]).toBeGreaterThanOrEqual(455.48)
  const owners = result.cells.flatMap((cell: { sourceItems?: Array<{ index: number }> }) =>
    (cell.sourceItems ?? []).map((item) => item.index)
  )
  expect(owners.sort((a, b) => a - b)).toEqual(
    f.source.map((item) => item.sourceItem.index).sort((a, b) => a - b)
  )
})

it.each(['broken vertical fence', 'different repeated header', 'text in an icon lane'])(
  'declines sparse-column recovery with %s',
  (variant) => {
    const f = fixture()
    if (variant === 'broken vertical fence') {
      f.rules.splice(
        f.rules.findIndex((rule) => rule[0] === 223.1355 && rule[1] === 116.67),
        1
      )
    } else if (variant === 'different repeated header') {
      f.source[2].text = 'Other heading'
      f.source[2].sourceItem.text = 'Other heading'
    } else {
      const item: TestToken = {
        text: 'unrelated label',
        rect: [225, 120, 260, 130],
        baseline: 130,
        height: 10,
        horizontal: true,
        sourceItem: { pageNumber: 3, index: 1000, text: 'unrelated label' }
      }
      f.source.push(item)
    }
    const result = refineTable(
      f.table,
      f.source,
      [{ page: 3, lines: ['Table I: Paired service keys and icons.'], rect: [0, 0, 240, 15] }],
      [],
      f.rules
    )
    expect(result.repairs).not.toContain('native-sparse-paired-ruled-columns-recovered')
  }
)
