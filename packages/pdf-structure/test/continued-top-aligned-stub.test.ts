import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { resolve } from './paths'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

type WholeSource = { pageNumber: number; index: number; text: string }
type Token = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
  sourceItem: WholeSource
  sourceSegment?: { text: string }
  sourceTokens?: { text: string }[]
}
type Cell = {
  row: number
  column: number
  rowSpan: number
  text: string
  sourceItems?: WholeSource[]
}
type Fixture = {
  headers: string[]
  records: string[][]
  groups: { text: string; sourceRow: number; modelRow: number; modelSpan: number; panel: string }[]
  expectedFirstStub: { row: number; rowSpan: number }
}
type Input = {
  table: {
    id: string
    readingRotation: number
    cropRect: number[]
    detection: { score: number; rect: number[] }
    structure: { objects: { label: string; score: number; rect: number[] }[] }
  }
  tokens: Token[]
  rules: number[][]
}

const fixture = JSON.parse(
  readFileSync(resolve('test/fixtures/continued-top-aligned-stub.json'), 'utf8')
) as Fixture

const makeContinuedInput = (): Input => {
  const height = 8.4
  const baseline = (row: number): number => (row ? 36 + (row - 1) * 9.6 : 20)
  const rowCount = fixture.records.length + 1
  const width = fixture.headers.length * 100
  const rows = Array.from({ length: rowCount }, (_, row) => [
    0,
    baseline(row) - height - 0.2,
    width,
    baseline(row) + 1.2
  ])
  const tokens: Token[] = []
  const addToken = (text: string, row: number, column: number): void => {
    tokens.push({
      text,
      rect: [column * 100 + 10, baseline(row) - height, column * 100 + 70, baseline(row)],
      baseline: baseline(row),
      height,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: tokens.length, text }
    })
  }
  fixture.headers.forEach((text, column) => addToken(text, 0, column))
  fixture.records.forEach((record, index) => {
    record.forEach((text, column) => addToken(text, index + 1, column + 1))
  })
  for (const group of fixture.groups) {
    addToken(group.text, group.sourceRow, 0)
    addToken(group.panel, group.sourceRow, fixture.headers.length - 1)
  }
  const cropRect = [0, 0, width, baseline(rowCount - 1) + 10]
  const objects = [
    ...rows.map((rect) => ({ label: 'table row', score: 0.99, rect })),
    ...fixture.headers.map((_, column) => ({
      label: 'table column',
      score: 0.99,
      rect: [column * 100, 0, (column + 1) * 100, cropRect[3]]
    })),
    ...fixture.groups.map((group) => ({
      label: 'table spanning cell',
      score: 0.99,
      rect: [0, rows[group.modelRow][1], 100, rows[group.modelRow + group.modelSpan - 1][3]]
    })),
    { label: 'table column header', score: 0.99, rect: rows[0] }
  ]
  const table = {
    id: 'anonymous-table',
    readingRotation: 0,
    cropRect,
    detection: { score: 0.99, rect: cropRect },
    structure: { objects }
  }
  const rules = [
    [0, 5, width, 5],
    [0, 23, width, 23],
    [0, baseline(rowCount - 1) + 5, width, baseline(rowCount - 1) + 5]
  ]
  return { table, tokens, rules }
}

const expectWholeSources = (cells: Cell[], tokens: Token[]): void => {
  const sources = cells.flatMap((cell) => cell.sourceItems ?? []).sort((a, b) => a.index - b.index)
  expect(sources).toEqual(tokens.map((token) => token.sourceItem))
  expect(sources).toHaveLength(56)
  expect(new Set(sources.map((source) => source.pageNumber + ':' + source.index)).size).toBe(56)
}

it('starts a continued table group at its complete current-page record and leaves preceding stubs empty', () => {
  const { table, tokens, rules } = makeContinuedInput()
  const result = refineTable(table, tokens, [], [], rules, [])
  const owner = result.cells.find((cell: Cell) => cell.text === fixture.groups[0].text)
  expect(owner).toMatchObject(fixture.expectedFirstStub)
  expect(
    result.cells.filter((cell: Cell) => cell.column === 0 && cell.row > 0 && cell.row < 3)
  ).toEqual([
    expect.objectContaining({ row: 1, rowSpan: 1, text: '', sourceTokens: [], sourceRects: [] }),
    expect.objectContaining({ row: 2, rowSpan: 1, text: '', sourceTokens: [], sourceRects: [] })
  ])
  expectWholeSources(result.cells, tokens)
})

it.each([
  'centered label',
  'missing Control',
  'broken cadence',
  'singular partial metadata',
  'plural partial metadata',
  'duplicate Source',
  'foreign below model',
  'foreign vertical',
  'missing last record',
  'interior rule',
  'too few labels'
])('leaves an unproved continued group at its original model span: %s', (fault) => {
  const input = makeContinuedInput()
  const label = input.tokens.find((token) => token.text === 'Category A')!
  const metric = input.tokens.find(
    (token) => token.rect[0] === 210 && Math.abs(token.baseline - 36) < 0.01
  )!
  if (fault === 'centered label') {
    label.baseline += 9.6
    label.rect[1] += 9.6
    label.rect[3] += 9.6
  }
  if (fault === 'missing Control') {
    const control = input.tokens.find((token) => token.text === 'Control')!
    control.text = control.sourceItem.text = 'Case'
  }
  if (fault === 'broken cadence')
    for (const token of input.tokens.filter((token) => Math.abs(token.baseline - 64.8) < 0.01)) {
      token.baseline += 2
      token.rect[1] += 2
      token.rect[3] += 2
    }
  if (fault === 'singular partial metadata') metric.sourceSegment = { text: metric.text }
  if (fault === 'plural partial metadata') metric.sourceTokens = [{ text: metric.text }]
  if (fault === 'duplicate Source') input.tokens.push(structuredClone(metric))
  if (fault === 'foreign below model' || fault === 'foreign vertical')
    input.tokens.push({
      text: 'Unowned',
      rect: fault === 'foreign below model' ? [310, 134, 370, 140] : [410, 55, 470, 63.4],
      baseline: fault === 'foreign below model' ? 140 : 63.4,
      height: fault === 'foreign below model' ? 6 : 8.4,
      horizontal: fault !== 'foreign vertical',
      sourceItem: { pageNumber: 1, index: 56, text: 'Unowned' }
    })
  if (fault === 'missing last record')
    input.tokens = input.tokens.filter((token) => Math.abs(token.baseline - 74.4) > 0.01)
  if (fault === 'interior rule') input.rules.push([0, 58, 100, 58])
  if (fault === 'too few labels')
    input.tokens = input.tokens.filter((token) => token.text !== 'Category C')
  const result = refineTable(input.table, input.tokens, [], [], input.rules, [])
  const owner = result.cells.find((cell: Cell) => cell.text === fixture.groups[0].text)
  expect(owner).toMatchObject({ row: 1, rowSpan: 4, sourceItems: [label.sourceItem] })
})

it('keeps an already correct model group and its empty leading stubs unchanged', () => {
  const { table, tokens, rules } = makeContinuedInput()
  const span = table.structure.objects.find(
    (object) => object.label === 'table spanning cell' && object.rect[1] < 30
  )!
  span.rect = [0, 46.6, 100, 75.6]
  const result = refineTable(table, tokens, [], [], rules, [])
  expect(result.cells.find((cell: Cell) => cell.text === 'Category A')).toMatchObject({
    row: 3,
    rowSpan: 3
  })
  for (const row of [1, 2])
    expect(result.cells.find((cell: Cell) => cell.row === row && cell.column === 0)).toMatchObject({
      rowSpan: 1,
      text: '',
      sourceTokens: [],
      sourceRects: []
    })
  expectWholeSources(result.cells, tokens)
})
