import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeOrdinalWrappedRecordGrid } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-bounded-text-record-grid.mjs')).href
)
const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-evidence.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/native-ordinal-wrapped-records.jsonl'))
it('repairs native tail ownership even when the model already has the correct row count', () => {
  const x = fixture(),
    r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(5)
  expect(r.grid[2][1]).toContain('Native name tail')
  expect(r.grid[2][2]).toContain('Native value tail')
  expect(r.grid[3][1]).not.toContain('tail')
  expect(r.unassigned).toEqual([])
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((r: number[]) => JSON.stringify(r))
      .sort()
  ).toEqual(x.tokens.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
})
it.each([
  'caption',
  'closing',
  'competing rule',
  'different leading',
  'nonconsecutive anchors',
  'missing value',
  'gutter crossing',
  'foreign source',
  'foreign font',
  'new stub tail'
])('retains existing output without complete ordinal/tail proof: %s', (variant) => {
  const x = fixture()
  if (variant === 'caption') x.captions = []
  if (variant === 'closing') x.rules.pop()
  if (variant === 'competing rule') x.rules.push([10, 140, 330, 140])
  if (variant === 'different leading')
    x.tokens.find((i: { text: string }) => i.text === 'Native name tail').baseline += 3
  if (variant === 'nonconsecutive anchors')
    x.tokens.find((i: { text: string }) => i.text === '2').text = '7'
  if (variant === 'missing value')
    x.tokens = x.tokens.filter((i: { text: string }) => i.text !== 'Literal B')
  if (variant === 'gutter crossing')
    x.tokens.find((i: { text: string }) => i.text === 'Native name tail').rect[2] = 190
  if (variant === 'foreign source')
    x.tokens.push({
      text: 'Foreign',
      rect: [5, 70, 25, 80],
      height: 10,
      baseline: 80,
      horizontal: true
    })
  if (variant === 'foreign font')
    x.tokens.find((i: { text: string }) => i.text === 'Native value tail').height = 12
  if (variant === 'new stub tail')
    x.tokens.push({ text: '4', rect: [20, 68, 26, 78], height: 10, baseline: 78, horizontal: true })
  expect(
    recoverNativeOrdinalWrappedRecordGrid(x.table, x.tokens, x.captions, x.rules)
  ).toBeUndefined()
})

const closedBlankOrdinal = (): ReturnType<typeof JSON.parse> => {
  const tokens: ReturnType<typeof JSON.parse>[] = []
  const add = (text: string, left: number, baseline: number, width: number): void => {
    tokens.push({
      text,
      rect: [left, baseline - 10, left + width, baseline],
      height: 10,
      baseline,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: tokens.length, text }
    })
  }
  add('Upper group', 60, 22, 55)
  add('Lower group', 235, 22, 55)
  const expected: string[][] = [['', 'Upper group', 'Lower group']]
  let baseline = 42
  for (let n = 1; n <= 10; n++) {
    const ordinal = String(n)
    add(ordinal, 30 - ordinal.length * 5, baseline, ordinal.length * 5)
    add(`Native upper description ${n}`, 60, baseline, 125)
    add(`Native lower description ${n}`, 235, baseline, 125)
    add('complete upper tail', 60, baseline + 11, 95)
    if (n % 2) add('complete lower tail', 235, baseline + 11, 95)
    expected.push([
      ordinal,
      `Native upper description ${n} complete upper tail`,
      `Native lower description ${n}${n % 2 ? ' complete lower tail' : ''}`
    ])
    baseline += 22 + (n % 3 === 0 ? 2 : 0)
  }
  const closing = baseline - 22 + 15
  const owned = [...tokens]
  add('Independent explanation below the closed frame.', 10, closing + 12, 385)
  const height = closing - 4
  return {
    tokens,
    owned,
    expected,
    captions: [],
    rules: [
      [10, 10, 410, 10],
      [10, 28, 410, 28],
      [10, closing, 410, closing]
    ],
    table: {
      id: 'page-1-table-1',
      cropRect: [9, 9, 411, closing + 5],
      structure: {
        objects: [
          { label: 'table', score: 1, rect: [0, 0, 402, height] },
          { label: 'table column', score: 1, rect: [0, 0, 220, height] },
          { label: 'table column', score: 1, rect: [180, 0, 402, height] },
          { label: 'table row', score: 1, rect: [0, 0, 402, 20] },
          { label: 'table row', score: 1, rect: [0, 20, 402, height] }
        ]
      }
    }
  }
}

it('recovers whole numbered prose records with a physical blank ordinal header and separate note', () => {
  const x = closedBlankOrdinal(),
    before = structuredClone(x)
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.grid).toEqual(x.expected)
  expect(result.unassigned).toEqual([])
  expect(result.clipped).toEqual([])
  expect(
    result.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((r: number[]) => JSON.stringify(r))
      .sort()
  ).toEqual(x.owned.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
  expect(
    result.cells.flatMap((c: { sourceItems?: unknown[] }) => c.sourceItems ?? [])
  ).toHaveLength(x.owned.length)
  expect(result.cropRect[3]).toBeLessThan(x.tokens.at(-1).rect[1])
  expect(hasTableEvidence(result, undefined, x.tokens, x.rules)).toBe(true)
  expect(x).toEqual(before)
})

it('keeps complete font envelopes at the native rule edge within the existing frame tolerance', () => {
  const x = closedBlankOrdinal()
  for (const item of x.tokens.filter((i: { text: string }) => /^\d+$/.test(i.text))) {
    item.rect[0] -= 10.004
    item.rect[2] -= 10.004
  }
  x.tokens.find((i: { text: string }) => i.text === 'Native lower description 1').rect[2] =
    410 + 0.004
  const before = structuredClone(x)
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.grid).toEqual(x.expected)
  expect(result.unassigned).toEqual([])
  expect(result.clipped).toEqual([])
  expect(
    result.cells.flatMap((c: { sourceItems?: unknown[] }) => c.sourceItems ?? [])
  ).toHaveLength(x.owned.length)
  expect(hasTableEvidence(result, undefined, x.tokens, x.rules)).toBe(true)
  expect(x).toEqual(before)
})

it.each([
  'closing',
  'competing rule',
  'crossing source',
  'gutter crossing',
  'missing peer',
  'nonconsecutive ordinal',
  'duplicate ordinal',
  'shifted ordinal',
  'ordinal tail',
  'source literal',
  'source page',
  'missing source',
  'duplicate origin',
  'partial font',
  'crossing note',
  'padding note',
  'header stub',
  'foreign caption',
  'unowned continuation',
  'overlapping records',
  'single prose lane',
  'malformed present font',
  'missing present font box',
  'absent present font box',
  'font past frame tolerance'
])('requires whole closed blank-ordinal source ownership: %s', (variant) => {
  const x = closedBlankOrdinal()
  const find = (text: string): ReturnType<typeof JSON.parse> =>
    x.tokens.find((i: { text: string }) => i.text === text)
  const text = (item: ReturnType<typeof JSON.parse>, value: string): void => {
    item.text = value
    item.sourceItem.text = value
  }
  if (variant === 'closing') x.rules.pop()
  if (variant === 'competing rule') x.rules.push([10, 80, 410, 80])
  if (variant === 'crossing source') find('Native upper description 2').rect[0] = 5
  if (variant === 'gutter crossing') find('complete upper tail').rect[2] = 240
  if (variant === 'missing peer')
    x.tokens = x.tokens.filter((i: { text: string }) => i.text !== 'Native lower description 3')
  if (variant === 'nonconsecutive ordinal') text(find('3'), '7')
  if (variant === 'duplicate ordinal') text(find('3'), '2')
  if (variant === 'shifted ordinal') {
    find('4').rect[0] += 1
    find('4').rect[2] += 1
  }
  if (variant === 'ordinal tail') {
    const tail = find('complete upper tail')
    x.tokens.push({
      ...structuredClone(tail),
      text: '2',
      rect: [25, tail.rect[1], 30, tail.rect[3]],
      sourceItem: { pageNumber: 1, index: 1000, text: '2' }
    })
  }
  if (variant === 'source literal')
    find('Native upper description 2').sourceItem.text = 'Other words'
  if (variant === 'source page') find('Native upper description 2').sourceItem.pageNumber = 2
  if (variant === 'missing source') delete find('Native upper description 2').sourceItem
  if (variant === 'duplicate origin')
    find('Native upper description 2').sourceItem.index = find(
      'Native upper description 1'
    ).sourceItem.index
  if (variant === 'partial font') find('Native upper description 2').rect[1] += 1
  if (variant === 'malformed present font') find('complete upper tail').rect[0] = NaN
  if (variant === 'missing present font box') find('complete upper tail').rect = []
  if (variant === 'absent present font box') delete find('complete upper tail').rect
  if (variant === 'font past frame tolerance')
    find('Native lower description 1').rect[2] = 410 + 0.02
  if (variant === 'crossing note' || variant === 'padding note') {
    const note = x.tokens.at(-1),
      closing = x.rules.at(-1)[1]
    note.rect[1] = closing + (variant === 'crossing note' ? -1 : 0.25)
    note.rect[3] = note.rect[1] + 10
    note.baseline = note.rect[3]
  }
  if (variant === 'header stub')
    x.tokens.push({
      text: 'Index',
      rect: [20, 12, 45, 22],
      height: 10,
      baseline: 22,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: 1000, text: 'Index' }
    })
  if (variant === 'foreign caption')
    x.captions.push({ page: 1, lines: ['Figure 2. Foreign figure.'], rect: [10, 70, 410, 80] })
  if (variant === 'unowned continuation') {
    find('complete upper tail').rect[0] += 1
    find('complete upper tail').rect[2] += 1
  }
  if (variant === 'overlapping records') {
    const next = find('Native upper description 2')
    next.rect[1] -= 2
    next.rect[3] -= 2
    next.baseline -= 2
  }
  if (variant === 'single prose lane')
    x.tokens = x.tokens.filter((i: { rect: number[] }) => i.rect[0] < 230)
  const before = structuredClone(x)
  expect(
    recoverNativeOrdinalWrappedRecordGrid(x.table, x.tokens, x.captions, x.rules)
  ).toBeUndefined()
  expect(x).toEqual(before)
})

it('keeps closed numbered bibliography rows rejected by the current evidence consumer', () => {
  const x = closedBlankOrdinal()
  x.tokens.push({
    text: 'References',
    rect: [10, 0, 80, 8],
    height: 8,
    baseline: 8,
    horizontal: true
  })
  for (let n = 1; n <= 10; n++) {
    const item = x.tokens.find((i: { text: string }) => i.text === `Native lower description ${n}`)
    item.text = `Journal citation ${2020 + n}`
    item.sourceItem.text = item.text
  }
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(hasTableEvidence(result, undefined, x.tokens, x.rules)).toBe(false)
})
