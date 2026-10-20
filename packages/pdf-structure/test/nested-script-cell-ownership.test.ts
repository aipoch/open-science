import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const { populateTableCellText } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-cell-text.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

const angularMark = (): ReturnType<typeof JSON.parse> => {
  const rects = [
    [5.334, 4.604, 17.607, 20.968],
    [13.673, 2.571, 20.823, 15.028],
    [21.731, 4.604, 54.458, 20.968]
  ]
  const items = ['0.', '′′', '0130'].map((text, index) => ({
    text,
    rect: rects[index],
    height: rects[index][3] - rects[index][1],
    baseline: rects[index][3],
    horizontal: true,
    sourceItem: { pageNumber: 1, index, text }
  }))
  const table = {
    id: 'angular-mark',
    cropRect: [0, 0, 65, 25],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 0, 65, 25] },
        { label: 'table column', rect: [0, 0, 65, 25] }
      ]
    }
  }
  return { table, items }
}
it('keeps an overprinted angular mark after the decimal base with unchanged unique sources', () => {
  const { table, items } = angularMark()
  const result = refineTable(table, items)
  expect(result.grid[0][0].replace(/\s/g, '')).toBe('0.′′0130')
  expect(result.cells[0].sourceItems).toEqual(
    items.map((i: { sourceItem: unknown }) => i.sourceItem)
  )
  expect(result.cells[0].sourceRects).toHaveLength(3)
})

it.each([
  'missing fraction',
  'competing mark',
  'duplicate identity',
  'wrong origin text',
  'unowned source',
  'other cell'
])('does not reorder an overprinted angular mark with %s', (control) => {
  const f = angularMark()
  if (control === 'missing fraction') f.items.pop()
  if (control === 'competing mark')
    f.items.push({ ...f.items[1], sourceItem: { pageNumber: 1, index: 10, text: '′′' } })
  if (control === 'duplicate identity') f.items[2].sourceItem = f.items[0].sourceItem
  if (control === 'wrong origin text') f.items[1].sourceItem.text = 'different'
  if (control === 'unowned source') delete f.items[1].sourceItem
  if (control === 'other cell')
    f.table.structure.objects.splice(
      1,
      1,
      { label: 'table column', rect: [0, 0, 20, 25] },
      { label: 'table column', rect: [20, 0, 65, 25] }
    )
  const result = refineTable(f.table, f.items)
  expect(result.repairs).not.toContain('native-overprinted-angular-mark-anchored')
})

it.each(['sourceSegment', 'sourceToken', 'nested segment'])(
  'rejects an external %s alias for an angular mark',
  (carrier) => {
    const f = angularMark(),
      origin = f.items[1].sourceItem
    const alias = {
      text: origin.text,
      rect: [200, 200, 210, 210],
      height: 10,
      baseline: 210,
      horizontal: true
    }
    const segment = { ...origin, start: 0, end: origin.text.length, rect: alias.rect }
    f.items.push({
      ...alias,
      ...(carrier === 'sourceSegment'
        ? { sourceSegment: segment }
        : carrier === 'sourceToken'
          ? { sourceToken: origin }
          : { sourceToken: { sourceSegment: segment } })
    })
    expect(refineTable(f.table, f.items).repairs).not.toContain(
      'native-overprinted-angular-mark-anchored'
    )
  }
)
it('retains angular mark order with an unrelated external segment', () => {
  const f = angularMark()
  f.items.push({
    text: 'external',
    rect: [200, 200, 210, 210],
    height: 10,
    baseline: 210,
    horizontal: true,
    sourceSegment: {
      pageNumber: 1,
      index: 1000,
      text: 'external',
      start: 0,
      end: 8,
      rect: [200, 200, 210, 210]
    }
  })
  expect(refineTable(f.table, f.items).repairs).toContain(
    'native-overprinted-angular-mark-anchored'
  )
})

it('preserves an ordinary mathematical prime without applying angular overprint recovery', () => {
  const f = angularMark()
  f.items = [
    { text: 'f', rect: [5, 5, 17, 21], height: 16, baseline: 21, horizontal: true },
    { text: '′', rect: [17, 2, 21, 14], height: 12, baseline: 14, horizontal: true }
  ]
  const result = refineTable(f.table, f.items)
  expect(result.grid[0][0].replace(/\s/g, '')).toBe('f′')
  expect(result.repairs).not.toContain('native-overprinted-angular-mark-anchored')
})

const fixture = (): ReturnType<typeof JSON.parse> => {
  const x = readPdfFixture(
    resolve('test/fixtures/source-grids/native-nested-script-owner-change.jsonl')
  )
  return { ...x, pageItems: x.items, issues: new Set(), repairs: [] }
}

it('preserves a nested script when its intermediate anchor changes cell ownership', () => {
  const x = fixture(),
    before = JSON.stringify(x.items)
  expect(populateTableCellText(x)).toEqual([])
  expect(x.cells.map((cell: { text: string }) => cell.text.replace(/\s/g, ''))).toEqual([
    'ga−b',
    '3'
  ])
  expect(x.issues.has('ambiguous-script-anchor')).toBe(true)
  expect(x.cells.flatMap((cell: { sourceRects: number[][] }) => cell.sourceRects).sort()).toEqual(
    x.items.map((item: { rect: number[] }) => item.rect).sort()
  )
  expect(JSON.stringify(x.items)).toBe(before)
})

it('retains script positioning when the complete chain belongs to one cell', () => {
  const x = fixture()
  x.cells = [{ ...x.cells[0], rect: [0.863, 0, 77.211, 50], items: [] }]
  x.rows = [{ rect: [0.863, 0, 77.211, 50] }]
  expect(populateTableCellText(x)).toEqual([])
  expect(x.cells[0].text.replace(/\s/g, '')).toBe('ga−b3')
  expect(x.cells[0].textRuns.at(-1)).toEqual({ text: '3', position: 'superscript' })
  expect(x.issues.has('ambiguous-script-anchor')).toBe(false)
})

it.each([32.01, 33.5])(
  'keeps a right parenthesized superscript at x=%s after its mathematical base',
  (left) => {
    const x = fixture()
    x.items = [
      { text: 'B', rect: [20, 20, 32, 36], baseline: 36, height: 16, horizontal: true },
      {
        text: '(4)',
        rect: [left, 15.6, left + 16, 27.6],
        baseline: 27.6,
        height: 12,
        horizontal: true
      },
      { text: 'q', rect: [32.01, 26.1, 38, 38.1], baseline: 38.1, height: 12, horizontal: true }
    ]
    x.pageItems = x.items
    x.cells = [{ ...x.cells[0], rect: [0, 0, 80, 50], items: [] }]
    x.rows = [{ rect: [0, 0, 80, 50] }]
    expect(populateTableCellText(x)).toEqual([])
    expect(x.cells[0].textRuns[0]).toEqual({ text: 'B', position: 'normal' })
    expect(x.cells[0].textRuns).toHaveLength(3)
    expect(x.cells[0].textRuns).toEqual(
      expect.arrayContaining([
        { text: 'B', position: 'normal' },
        { text: '(4)', position: 'superscript' },
        { text: 'q', position: 'subscript' }
      ])
    )
  }
)

it('keeps detached parenthesized text as an independent line', () => {
  const x = fixture()
  x.items = [
    { text: 'B', rect: [20, 20, 32, 36], baseline: 36, height: 16, horizontal: true },
    { text: '(4)', rect: [42, 15.6, 58, 27.6], baseline: 27.6, height: 12, horizontal: true }
  ]
  x.pageItems = x.items
  x.cells = [{ ...x.cells[0], rect: [0, 0, 80, 50], items: [] }]
  x.rows = [{ rect: [0, 0, 80, 50] }]
  populateTableCellText(x)
  expect(x.cells[0].text).toBe('(4) B')
  expect(x.cells[0].textRuns).toBeUndefined()
})
