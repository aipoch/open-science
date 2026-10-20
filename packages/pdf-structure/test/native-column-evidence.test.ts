import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

type NativeToken = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
  sourceItem?: { pageNumber: number; index: number; text: string }
}
const token = (text: string, x: number, baseline: number, width = 8, height = 15): NativeToken => ({
  text,
  rect: [x, baseline - height, x + width, baseline],
  baseline,
  height,
  horizontal: true
})
const object = (
  label: string,
  rect: number[]
): { label: string; rect: number[]; score: number } => ({ label, rect, score: 0.9 })
const withOrigins = (items: NativeToken[]): NativeToken[] =>
  items.map((item, index) => ({
    ...item,
    sourceItem: { pageNumber: 1, index, text: item.text }
  }))

it('recovers the two native parameter lanes instead of overlapping numeric predictions', () => {
  const table = {
    id: 'compact-parameters',
    cropRect: [0, 0, 110, 70],
    structure: {
      objects: [
        object('table column', [10, 10, 24, 60]),
        object('table column', [68, 10, 84, 60]),
        object('table column', [75, 10, 91, 60]),
        ...[
          [10, 25],
          [21, 37],
          [29, 43],
          [43, 58]
        ].map(([a, b]) => object('table row', [10, a, 92, b]))
      ]
    }
  }
  const source = withOrigins([
    token('q', 43, 22),
    token('s', 51, 24, 7, 10.5),
    token('4', 77, 22),
    token('r', 46, 38),
    token('7', 77, 38),
    token('t', 46, 54),
    token('2', 77, 54)
  ])
  const result = refineTable(
    table,
    source,
    [],
    [],
    [
      [34, 10, 94, 10],
      [34, 60, 94, 60]
    ]
  )
  expect(result.grid).toEqual([
    ['qs', '4'],
    ['r', '7'],
    ['t', '2']
  ])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('native-overlapping-literal-columns-recovered')
  const owners = result.cells.flatMap(
    (cell: { sourceItems?: { index: number }[] }) => cell.sourceItems ?? []
  )
  expect(owners).toHaveLength(source.length)
  expect(new Set(owners.map((item: { index: number }) => item.index)).size).toBe(source.length)
  expect(
    result.cells.find(
      (cell: { row: number; column: number }) => cell.row === 0 && cell.column === 0
    ).textRuns
  ).toContainEqual({ text: 's', position: 'subscript' })
})

it('keeps equal values in distinct mathematical columns despite overlapping model alternatives', () => {
  const xs = [10, 50, 90, 130, 170, 210]
  const table = {
    id: 'symbol-settings',
    cropRect: [0, 0, 240, 50],
    structure: {
      objects: [
        ...[
          [5, 60],
          [45, 100],
          [80, 155],
          [105, 160],
          [135, 200],
          [180, 235]
        ].map(([a, b]) => object('table column', [a, 10, b, 40])),
        object('table row', [5, 10, 235, 25]),
        object('table row', [5, 24, 235, 41])
      ]
    }
  }
  const source = withOrigins(
    xs.flatMap((x, n) => [
      token(n === 1 || n === 2 ? 'q' : ['a', '', '', 'd', 'e', 'f'][n], x, 22),
      ...(n === 1 || n === 2 ? [token(n === 1 ? 'u' : 'v', x + 8, 24, 6, 10.5)] : []),
      token(['8', '12', '12', '32', '6', '4'][n], x, 42, 15)
    ])
  )
  const result = refineTable(
    table,
    source,
    [],
    [],
    [
      [0, 8, 240, 8],
      [0, 28, 240, 28],
      [0, 48, 240, 48]
    ]
  )
  expect(result.grid).toEqual([
    ['a', 'qu', 'qv', 'd', 'e', 'f'],
    ['8', '12', '12', '32', '6', '4']
  ])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('native-overlapping-literal-columns-recovered')
  const owners = result.cells.flatMap(
    (cell: { sourceItems?: { index: number }[] }) => cell.sourceItems ?? []
  )
  expect(owners).toHaveLength(source.length)
  expect(new Set(owners.map((item: { index: number }) => item.index)).size).toBe(source.length)
  expect(
    result.cells.find(
      (cell: { row: number; column: number }) => cell.row === 0 && cell.column === 1
    ).textRuns
  ).toContainEqual({ text: 'u', position: 'subscript' })
  expect(
    result.cells.find(
      (cell: { row: number; column: number }) => cell.row === 0 && cell.column === 2
    ).textRuns
  ).toContainEqual({ text: 'v', position: 'subscript' })
})

it('rejects duplicate projections of one native source item', () => {
  const table = {
    id: 'duplicate-source-parameters',
    cropRect: [0, 0, 110, 70],
    structure: {
      objects: [
        object('table column', [10, 10, 24, 60]),
        object('table column', [68, 10, 84, 60]),
        object('table column', [75, 10, 91, 60])
      ]
    }
  }
  const source = withOrigins([
    token('q', 43, 22),
    token('s', 51, 24, 7, 10.5),
    token('4', 77, 22),
    token('r', 46, 38),
    token('7', 77, 38),
    token('t', 46, 54),
    token('2', 77, 54)
  ])
  source.push({ ...source[0] })
  const result = refineTable(
    table,
    source,
    [],
    [],
    [
      [34, 10, 94, 10],
      [34, 60, 94, 60]
    ]
  )
  expect(result.repairs).not.toContain('native-overlapping-literal-columns-recovered')
  expect(result.issues).toContain('overlapping-predicted-columns')
})

it('keeps overlapping model columns when native scalar ownership is incomplete', () => {
  const table = {
    id: 'incomplete-parameters',
    cropRect: [0, 0, 110, 70],
    structure: {
      objects: [
        object('table column', [10, 10, 24, 60]),
        object('table column', [68, 10, 84, 60]),
        object('table column', [75, 10, 91, 60]),
        ...[
          [10, 25],
          [21, 37],
          [29, 43],
          [43, 58]
        ].map(([a, b]) => object('table row', [10, a, 92, b]))
      ]
    }
  }
  const source = [
    token('q', 43, 22),
    token('s', 51, 24, 7, 10.5),
    token('4', 77, 22),
    token('r', 46, 38),
    token('t', 46, 54),
    token('2', 77, 54)
  ]
  const result = refineTable(
    table,
    source,
    [],
    [],
    [
      [34, 10, 94, 10],
      [34, 60, 94, 60]
    ]
  )
  expect(result.repairs).not.toContain('native-overlapping-literal-columns-recovered')
  expect(result.issues).toContain('overlapping-predicted-columns')
})

const packedFixture = (): {
  table: { id: string; cropRect: number[]; structure: { objects: ReturnType<typeof object>[] } }
  source: NativeToken[]
  rules: number[][]
  runs: (NativeToken & {
    gaps: { left: number; right: number; index: number }[]
    literalGlyphs: string[]
    glyphRuns: number[]
  })[]
} => {
  const table = {
    id: 'fenced-values',
    cropRect: [0, 0, 180, 100],
    structure: {
      objects: [
        ...[0, 60, 120].map((x) => object('table column', [x, 0, x + 60, 100])),
        ...[0, 25, 50, 75].map((y) => object('table row', [0, y, 180, y + 25])),
        object('table column header', [0, 0, 180, 25])
      ]
    }
  }
  const source = [
    token('Item', 5, 20, 25, 10),
    token('Left', 65, 20, 25, 10),
    token('Right', 125, 20, 25, 10)
  ]
  const runs = []
  for (let n = 0; n < 3; n++) {
    source.push(token(String.fromCharCode(65 + n), 5, 45 + n * 25, 10, 10))
    const packed = {
      ...token('12.3% 45.6%', 75, 45 + n * 25, 75, 10),
      sourceItem: { pageNumber: 1, index: n, text: '12.3% 45.6%' }
    }
    source.push(packed)
    runs.push({
      ...packed,
      gaps: [{ left: 105, right: 125, index: 5 }],
      literalGlyphs: [...'12.3%45.6%'],
      glyphRuns: [...Array(5).fill(1), ...Array(5).fill(2)]
    })
  }
  const rules = [
    [0, 0, 180, 0],
    [0, 25, 180, 25],
    [0, 100, 180, 100],
    ...[60, 120].map((x) => [x, 0, x, 100])
  ]
  return { table, source, rules, runs }
}

it('splits packed percentage runs only at a measured glyph gap crossed by a native fence', () => {
  const { table, source, rules, runs } = packedFixture()
  const result = refineTable(table, source, [], [], rules, runs)
  expect(result.grid.slice(1)).toEqual([
    ['A', '12.3%', '45.6%'],
    ['B', '12.3%', '45.6%'],
    ['C', '12.3%', '45.6%']
  ])
  expect(result.unassigned).toEqual([])
  expect(
    result.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 1)
      .sourceRects
  ).toEqual([[75, 35, 105, 45]])
  expect(
    result.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 2)
      .sourceRects
  ).toEqual([[125, 35, 150, 45]])
  for (const column of [1, 2])
    expect(
      result.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === column)
        .sourceItems
    ).toEqual([{ pageNumber: 1, index: 0, text: '12.3% 45.6%' }])
})

it.each(['missing-fence', 'wrong-glyphs', 'duplicate-program', 'wrong-gap-index'])(
  'rejects an unproved packed split: %s',
  (failure) => {
    const { table, source, rules, runs } = packedFixture()
    if (failure === 'missing-fence') rules.splice(4, 1)
    if (failure === 'wrong-glyphs') runs[0].literalGlyphs[0] = '9'
    if (failure === 'duplicate-program') runs.push({ ...runs[0] })
    if (failure === 'wrong-gap-index') runs[0].gaps[0].index = 4
    const result = refineTable(table, source, [], [], rules, runs)
    expect(
      result.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 1)
        .sourceRects
    ).not.toEqual([[75, 35, 105, 45]])
  }
)
