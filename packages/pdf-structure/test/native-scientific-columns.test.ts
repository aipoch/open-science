import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const { recoverNativeScientificColumns } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-scientific-columns.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

it('removes a phantom numeric column under a two-tier grouped header', () => {
  const x = readPdfFixture('test/fixtures/source-grids/native-scientific-phantom-column.jsonl')
  const result = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(result.grid.every((r: string[]) => r.length === 8)).toBe(true)
  expect(result.grid.slice(2).map((r: string[]) => r.at(-1))).toEqual([
    '1.000',
    '7.33 × 10−4',
    '2.36 × 10−4'
  ])
  expect(result.unassigned).toEqual([])
  for (const cell of result.cells.filter((c: ReturnType<typeof JSON.parse>) =>
    c.text.includes('×')
  )) {
    // Raw refinement supplies exact source tokens; final extraction derives
    // the superscript display from the retained raised native fonts.
    expect(cell.sourceTokens.some((t: ReturnType<typeof JSON.parse>) => t.height < 10)).toBe(true)
  }
})

function groupedScientificFixture(): ReturnType<typeof JSON.parse> {
  const x = readPdfFixture('test/fixtures/source-grids/native-scientific-phantom-column.jsonl')
  const duplicate = x.items
    .filter((i: { rect: number[] }) => i.rect[1] > 153.86)
    .map((i: ReturnType<typeof JSON.parse>, n: number) => {
      const next = structuredClone(i)
      next.rect[1] += 60
      next.rect[3] += 60
      next.baseline += 60
      next.sourceItem.index = 1000 + n
      if (next.text === 'Group') next.text = next.sourceItem.text = 'Other'
      return next
    })
  x.items.push(...duplicate)
  const rows = x.table.structure.objects
    .filter((o: ReturnType<typeof JSON.parse>) => o.label === 'table row' && o.rect[1] > 52)
    .map((o: ReturnType<typeof JSON.parse>) => ({
      ...o,
      rect: [o.rect[0], o.rect[1] + 60, o.rect[2], o.rect[3] + 60]
    }))
  for (const column of x.table.structure.objects.filter(
    (o: ReturnType<typeof JSON.parse>) => o.label === 'table column'
  ))
    column.rect[3] += 60
  x.table.structure.objects.push(
    ...rows,
    { label: 'table spanning cell', score: 1, rect: [12.72, 52.43, 93.64, 111] },
    { label: 'table spanning cell', score: 1, rect: [12.72, 112.43, 93.64, 171] }
  )
  x.table.cropRect[3] += 60
  x.rules.push([182.19, 270, 710.73, 270])
  return x
}

it('retains independently closed shared ancestors when rebuilding scientific leaves', () => {
  const x = groupedScientificFixture()
  const result = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(result.grid).toHaveLength(8)
  expect(
    result.cells
      .filter((c: ReturnType<typeof JSON.parse>) => c.rowSpan > 1 && c.column === 0)
      .map((c: ReturnType<typeof JSON.parse>) => [c.row, c.rowSpan, c.text])
  ).toEqual([
    [2, 3, 'Group'],
    [5, 3, 'Other']
  ])
  expect(result.grid.every((r: string[]) => r.length === 8)).toBe(true)
})

it.each([
  'missing group divider',
  'internal divider',
  'independent stub',
  'crossing boundary font'
])('does not reapply an ancestor without complete closed-record evidence: %s', (variant) => {
  const x = groupedScientificFixture()
  if (variant === 'missing group divider') x.rules = x.rules.filter((r: number[]) => r[1] !== 210)
  if (variant === 'internal divider') x.rules.push([182.19, 190, 710.73, 190])
  if (variant === 'independent stub') {
    const item = structuredClone(
      x.items.find((i: ReturnType<typeof JSON.parse>) => i.text === 'Group')
    )
    item.text = item.sourceItem.text = 'Third'
    item.sourceItem.index = 2000
    item.rect[1] += 16.47
    item.rect[3] += 16.47
    item.baseline += 16.47
    x.items.push(item)
  }
  if (variant === 'crossing boundary font') {
    const item = x.items.find((i: ReturnType<typeof JSON.parse>) => i.text === 'CC')
    item.rect[3] = 211
  }
  const result = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(result.repairs).toContain('native-printed-leaf-records-recovered')
  expect(
    result.cells.some(
      (c: ReturnType<typeof JSON.parse>) => c.column === 0 && c.row === 2 && c.rowSpan === 3
    )
  ).toBe(false)
})

function fixture(): ReturnType<typeof JSON.parse> {
  const items: ReturnType<typeof JSON.parse>[] = []
  const token = (
    text: string,
    left: number,
    right: number,
    baseline: number,
    height = 10
  ): void => {
    items.push({
      text,
      rect: [left, baseline - height, right, baseline],
      baseline,
      height,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: items.length, text }
    })
  }
  token('Case', 5, 35, 20)
  token('Mean', 65, 90, 20)
  token('P', 160, 166, 20)
  for (const [n, baseline] of [40, 60, 80].entries()) {
    token(['Alpha', 'Beta', 'Gamma'][n], 5, 40, baseline)
    token(String(n + 2), 65, 73, baseline)
    if (n === 2) token('0.125', 150, 175, baseline)
    else {
      token('2.3', 110, 123, baseline)
      token('×', 126, 134, baseline)
      token('10', 137, 147, baseline)
      token('−', 147, 152, baseline - 4, 6)
      token('4', 152, 156, baseline - 4, 6)
    }
  }
  const cuts = [0, 60, 100, 125, 180],
    bands = [0, 25, 50, 70, 110]
  return {
    table: {
      id: 'synthetic-probabilities',
      cropRect: [0, 0, 180, 110],
      structure: {
        objects: [
          ...cuts.slice(1).map((right, n) => ({
            label: 'table column',
            score: 1,
            rect: [cuts[n], 0, right, 110]
          })),
          ...bands.slice(1).map((bottom, n) => ({
            label: 'table row',
            score: 1,
            rect: [0, bands[n], 180, bottom]
          })),
          { label: 'table column header', score: 1, rect: [0, 0, 180, 25] }
        ]
      }
    },
    items,
    rules: [
      [0, 5, 180, 5],
      [0, 25, 180, 25],
      [0, 105, 180, 105]
    ],
    captions: [{ page: 1, lines: ['Table 1: Measurements'], rect: [0, -20, 180, -5] }]
  }
}

it('keeps complete raised scientific values in a single native field', () => {
  const x = fixture(),
    before = JSON.stringify(x)
  const result = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(result.grid).toEqual([
    ['Case', 'Mean', 'P'],
    ['Alpha', '2', '2.3 × 10−4'],
    ['Beta', '3', '2.3 × 10−4'],
    ['Gamma', '4', '0.125']
  ])
  expect(result.unassigned).toEqual([])
  expect(JSON.stringify(x)).toBe(before)
})

it.each([
  'separate coefficient heading',
  'spanning leaf heading',
  'independent neighbor value',
  'partial vertical rule',
  'ordinary exponent',
  'missing exponent',
  'unknown glyph',
  'source alias',
  'source literal mismatch',
  'missing closure'
])('declines unsupported column collapse: %s', (variant) => {
  const x = fixture()
  const coefficient = x.items[5]
  const extra = (text: string, rect: number[]): void => {
    x.items.push({
      text,
      rect,
      horizontal: true,
      baseline: rect[3],
      height: 10,
      sourceItem: { pageNumber: 1, index: 100, text }
    })
  }
  if (variant === 'separate coefficient heading') extra('Factor', [102, 10, 122, 20])
  if (variant === 'spanning leaf heading') x.items[2].rect[0] = 115
  if (variant === 'independent neighbor value') extra('7', [110, 70, 119, 80])
  if (variant === 'partial vertical rule') x.rules.push([125, 55, 125, 65])
  if (variant === 'ordinary exponent') {
    x.items[8].height = 10
    x.items[8].baseline = 40
    x.items[8].rect = [147, 30, 152, 40]
  }
  if (variant === 'missing exponent') x.items.splice(8, 2)
  if (variant === 'unknown glyph') {
    coefficient.text = '□'
    coefficient.sourceItem.text = '□'
  }
  if (variant === 'source alias')
    x.items.push({ sourceItems: [coefficient.sourceItem], text: '', rect: [200, 0, 201, 1] })
  if (variant === 'source literal mismatch') coefficient.sourceItem.text = '9.9'
  if (variant === 'missing closure') x.rules.pop()
  const before = JSON.stringify(x)
  expect(recoverNativeScientificColumns(x.table, x.items, x.rules)).toBeUndefined()
  expect(JSON.stringify(x)).toBe(before)
})
