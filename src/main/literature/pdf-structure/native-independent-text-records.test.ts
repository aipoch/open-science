import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeTextRecordGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-text-record-grid.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-independent-text-records.jsonl'
    )
  )

const scriptedFixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-scripted-independent-records.jsonl'
    )
  )

it('retains independently measured records when uniquely attached scripts touch the next font box', () => {
  const x = scriptedFixture(),
    r = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(4)
  expect(r.grid.map((row: string[]) => row[0])).toEqual(['Item #', '4', '5', '6'])
  expect(r.unassigned).toEqual([])
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  ).toEqual(x.items.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
})

it.each([
  'missing script',
  'detached script',
  'overlapping normal lines',
  'excessive script overlap',
  'only two peers',
  'non-indexed stub',
  'header/body overlap',
  'foreign footer ink',
  'unmatched double stroke',
  'crossing opening from outside',
  'crossing closing from outside'
])('does not infer scripted record ownership from incomplete evidence: %s', (variant) => {
  const x = scriptedFixture()
  const normals = x.items.filter(
    (i: { height: number; baseline: number }) => i.height > 10 && i.baseline > 180
  )
  const scripts = x.items.filter((i: { height: number }) => i.height < 10)
  if (variant === 'missing script') x.items.splice(x.items.indexOf(scripts[0]), 1)
  if (variant === 'detached script') scripts[0].rect[0] += 2
  if (variant === 'overlapping normal lines')
    normals.find((i: { text: string }) => i.text === '5').rect[1] = 190
  if (variant === 'excessive script overlap') scripts[0].rect[3] += 1
  if (variant === 'only two peers')
    x.items = x.items.filter((i: { baseline: number }) => i.baseline < 220)
  if (variant === 'non-indexed stub')
    normals.find((i: { text: string }) => i.text === '5').text = 'Other'
  if (variant === 'header/body overlap') x.items[0].rect[3] = 180
  if (variant === 'foreign footer ink')
    x.items.push({
      text: 'X',
      rect: [90, 228, 100, 233],
      height: 5,
      baseline: 233,
      horizontal: true
    })
  if (variant === 'unmatched double stroke') {
    x.rules.at(-1)[1] += 0.8
    x.rules.at(-1)[3] += 0.8
  }
  if (variant === 'crossing opening from outside')
    x.items.push({
      text: 'Foreign',
      rect: [90, 150, 120, 160],
      height: 10,
      baseline: 150,
      horizontal: true
    })
  if (variant === 'crossing closing from outside')
    x.items.push({
      text: 'Foreign',
      rect: [90, 230, 120, 245],
      height: 15,
      baseline: 245,
      horizontal: true
    })
  expect(recoverNativeTextRecordGrid(x.table, x.items, x.captions, x.rules)).toBeUndefined()
})

it('recovers an omitted independently printed pair through the full refiner', () => {
  const x = fixture(),
    r = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(r.grid).toEqual([
    ['Entry', 'Description'],
    ['Alpha', 'Source A'],
    ['Beta', 'Source B'],
    ['Gamma', 'Source C'],
    ['Delta', 'Source D']
  ])
  expect(r.unassigned).toEqual([])
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((b: number[]) => JSON.stringify(b))
      .sort()
  ).toEqual(x.items.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
})

it.each([
  'caption',
  'closing',
  'missing pair',
  'crossing source',
  'overlapping font boxes',
  'different font',
  'foreign line',
  'internal separator'
])('requires complete independent source ownership: %s', (variant) => {
  const x = fixture()
  if (variant === 'caption') x.captions = []
  if (variant === 'closing') x.rules.pop()
  if (variant === 'missing pair') x.items.splice(5, 1)
  if (variant === 'crossing source') x.items[4].rect[2] = 140
  if (variant === 'overlapping font boxes') x.items[4].rect[1] = 45
  if (variant === 'different font') x.items[4].height = 20
  if (variant === 'foreign line')
    x.items.push({
      text: 'Independent paragraph',
      rect: [60, 76, 200, 86],
      height: 10,
      baseline: 86,
      horizontal: true
    })
  if (variant === 'internal separator') x.rules.push([0, 67, 260, 67])
  expect(
    recoverNativeTextRecordGrid(x.table, x.items, x.captions, x.rules),
    variant
  ).toBeUndefined()
})

it('keeps a uniquely owned script with its normal baseline record', () => {
  const x = fixture()
  x.items.push({ text: 'x', rect: [175, 61, 180, 68], height: 7, baseline: 68, horizontal: true })
  const r = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(5)
  expect(
    r.cells.find((c: { row: number; column: number }) => c.row === 2 && c.column === 1)?.sourceRects
  ).toContainEqual([175, 61, 180, 68])
})

const fourLeafFixture = (): ReturnType<typeof JSON.parse> => {
  const x = fixture()
  for (const i of x.items) if (i.rect[0] > 75) i.rect = [180, i.rect[1], 245, i.rect[3]]
  for (const [y, a, b] of [
    [25, 'Count', 'Total'],
    [50, '11', '31'],
    [70, '12', '32'],
    [90, '13', '33'],
    [110, '14', '34']
  ] as const) {
    x.items.push(
      { text: a, rect: [70, y - 10, 100, y], height: 10, baseline: y, horizontal: true },
      { text: b, rect: [120, y - 10, 150, y], height: 10, baseline: y, horizontal: true }
    )
  }
  return x
}

const groupedParameterFixture = (): ReturnType<typeof JSON.parse> => {
  const x = fixture()
  x.items[0].text = 'Parameter'
  x.items[1].text = 'Value'
  for (let n = 3; n < x.items.length; n += 2) x.items[n].text = String(n + 20)
  x.rules.push([0, 75, 260, 75])
  return x
}

it('preserves complete parameter records on both sides of a native group divider', () => {
  const x = groupedParameterFixture(),
    r = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(recoverNativeTextRecordGrid(x.table, x.items, x.captions, x.rules)?.rows).toHaveLength(5)
  expect(r.grid).toHaveLength(5)
  expect(r.grid.slice(1).map((row: string[]) => row[0])).toEqual([
    'Alpha',
    'Beta',
    'Gamma',
    'Delta'
  ])
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  ).toEqual(x.items.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
})

it.each(['crossing divider', 'single record band', 'prose values', 'different header'])(
  'rejects incomplete independent parameter group evidence: %s',
  (variant) => {
    const x = groupedParameterFixture()
    if (variant === 'crossing divider') x.rules.at(-1)[1] = x.rules.at(-1)[3] = 65
    if (variant === 'single record band') x.rules.at(-1)[1] = x.rules.at(-1)[3] = 55
    if (variant === 'prose values')
      for (let n = 3; n < x.items.length; n += 2) x.items[n].text = 'Another paragraph'
    if (variant === 'different header') x.items[0].text = 'Entry'
    expect(recoverNativeTextRecordGrid(x.table, x.items, x.captions, x.rules)).toBeUndefined()
  }
)

it('proves four complete source lanes when prose generated phantom model columns', () => {
  const x = fourLeafFixture(),
    r = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(r.grid).toEqual([
    ['Entry', 'Count', 'Total', 'Description'],
    ['Alpha', '11', '31', 'Source A'],
    ['Beta', '12', '32', 'Source B'],
    ['Gamma', '13', '33', 'Source C'],
    ['Delta', '14', '34', 'Source D']
  ])
  expect(r.unassigned).toEqual([])
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((b: number[]) => JSON.stringify(b))
      .sort()
  ).toEqual(x.items.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
})

it.each(['missing header', 'missing value', 'overlapping lanes'])(
  'rejects incomplete four-lane proof: %s',
  (variant) => {
    const x = fourLeafFixture()
    if (variant === 'missing header') x.items.splice(10, 1)
    if (variant === 'missing value') x.items.splice(12, 1)
    if (variant === 'overlapping lanes') x.items[12].rect[2] = 135
    expect(recoverNativeTextRecordGrid(x.table, x.items, x.captions, x.rules)).toBeUndefined()
  }
)
