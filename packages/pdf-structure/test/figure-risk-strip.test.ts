import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
const { isFigureRiskTable, isFigureOwnedPartialTable, isNativeFigureOwnedClippedTable } =
  await import(pathToFileURL(resolve('resources/literature-pdf-table-evidence.mjs')).href)
it('rejects a risk strip even when detector padding captures adjacent prose', () => {
  const cells = Array.from({ length: 8 }, (_, i) => ({
    row: Math.floor(i / 4),
    column: i % 4,
    text: String(30 - i),
    sourceRects: [
      [
        100 + (i % 4) * 20,
        100 + Math.floor(i / 4) * 15,
        115 + (i % 4) * 20,
        110 + Math.floor(i / 4) * 15
      ]
    ]
  }))
  const page = { lines: [{ text: 'Number at risk', x: 80, y: 85, width: 60, height: 10 }] }
  const figures = [
    { rect: [50, 40, 250, 180], caption: { lines: ['Figure 1: Kaplan-Meier estimates'] } }
  ]
  const table = {
    cells: [
      ...cells,
      { row: 0, column: 4, text: 'Adjacent prose fragment', sourceRects: [[260, 100, 340, 110]] }
    ]
  }
  expect(isFigureRiskTable(table, figures, page, 1)).toBe(true)
  expect(isFigureRiskTable(table, figures, { lines: [] }, 1)).toBe(false)
  expect(
    isFigureRiskTable(
      {
        ...table,
        cells: [...cells, { row: 3, column: 1, text: '12', sourceRects: [[260, 120, 275, 130]] }]
      },
      figures,
      page,
      1
    )
  ).toBe(false)
})

it('rejects an uncaptioned partial table crop owned by a larger figure panel', () => {
  const table = {
    cropRect: [150, 120, 455, 287],
    issues: ['text-crosses-crop-boundary', 'unassigned-source-text'],
    unassigned: ['32 frames · 128 trajectories per dataset']
  }
  const figures = [{ rect: [108, 80, 506, 196] }]
  expect(isFigureOwnedPartialTable(table, figures)).toBe(true)
  expect(isFigureOwnedPartialTable({ ...table, issues: [], unassigned: [] }, figures)).toBe(false)
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function assignedPartialPanel() {
  const items = ['First label', '12', 'Second label', '24'].map((text, index) => ({
    text,
    horizontal: true,
    height: 10,
    baseline: 60 + Math.floor(index / 2) * 30,
    rect: [
      index % 2 ? 140 : 40,
      50 + Math.floor(index / 2) * 30,
      index % 2 ? 160 : 115,
      60 + Math.floor(index / 2) * 30
    ],
    sourceItem: { pageNumber: 1, index, text }
  }))
  const runtimeTokens = items.map((item) => ({
    text: item.text,
    rect: [...item.rect],
    height: item.height,
    baseline: item.baseline
  }))
  return {
    items,
    table: {
      page: 1,
      cropRect: [80, 40, 180, 120],
      grid: [
        ['First label', '', '12'],
        ['Second label', '', '24']
      ],
      cells: [
        ...items.map((item, index) => ({
          row: Math.floor(index / 2),
          column: index % 2 ? 2 : 0,
          rowSpan: 1,
          colSpan: 1,
          text: item.text,
          sourceTokens: [structuredClone(runtimeTokens[index])],
          sourceRects: [[...item.rect]],
          sourceItems: [{ ...item.sourceItem }]
        })),
        ...[0, 1].map((row) => ({
          row,
          column: 1,
          rowSpan: 1,
          colSpan: 1,
          text: '',
          sourceTokens: [] as typeof runtimeTokens,
          sourceRects: [] as number[][],
          sourceItems: [] as (typeof items)[number]['sourceItem'][]
        }))
      ],
      issues: ['native-table-structure-ambiguous'],
      unassigned: []
    },
    figures: [
      {
        rect: [20, 20, 200, 140],
        caption: { page: 1, lines: ['Figure 1. Comparison.'], rect: [20, 145, 200, 165] }
      }
    ]
  }
}

it('removes an assigned but clipped native table fragment only inside its unique complete figure', () => {
  const f = assignedPartialPanel(),
    before = JSON.stringify(f)
  expect(isNativeFigureOwnedClippedTable(f.table, f.figures, 1, { items: f.items })).toBe(true)
  expect(JSON.stringify(f)).toBe(before)
})

it.each([
  'table caption',
  'missing figure caption',
  'non-figure caption',
  'competing figure',
  'outside source',
  'wrong literal',
  'wrong source rectangle',
  'duplicate native',
  'duplicate owner',
  'source alias',
  'measured segment',
  'wrong runtime token literal',
  'wrong runtime token source',
  'partial runtime token',
  'runtime token alias',
  'complete crop'
])('preserves a table when native figure ownership is unproved: %s', (reason) => {
  const f = assignedPartialPanel()
  if (reason === 'table caption') Object.assign(f.table, { caption: f.figures[0].caption })
  if (reason === 'missing figure caption') Object.assign(f.figures[0], { caption: undefined })
  if (reason === 'non-figure caption')
    f.figures[0].caption.lines = ['Table 1. Independent results.']
  if (reason === 'competing figure') f.figures.push(structuredClone(f.figures[0]))
  if (reason === 'outside source') {
    f.items[0].rect[0] = 5
    f.table.cells[0].sourceRects[0][0] = 5
  }
  if (reason === 'wrong literal') f.items[0].text = 'Other label'
  if (reason === 'wrong source rectangle') f.table.cells[0].sourceRects[0][0] += 1
  if (reason === 'duplicate native') f.items.push(structuredClone(f.items[0]))
  if (reason === 'duplicate owner') f.table.cells[1].sourceItems.push({ ...f.items[0].sourceItem })
  if (reason === 'source alias') Object.assign(f.items[0], { sourceToken: f.items[0].sourceItem })
  if (reason === 'measured segment')
    Object.assign(f.table.cells[0], {
      sourceSegments: [{ ...f.items[0].sourceItem, start: 0, end: 2, rect: f.items[0].rect }]
    })
  if (reason === 'wrong runtime token literal')
    f.table.cells[0].sourceTokens[0].text = 'Other label'
  if (reason === 'wrong runtime token source')
    Object.assign(f.table.cells[0].sourceTokens[0], {
      sourceItem: { ...f.items[0].sourceItem, index: 99 }
    })
  if (reason === 'partial runtime token') f.table.cells[0].sourceTokens[0].rect[0] += 1
  if (reason === 'runtime token alias')
    Object.assign(f.table.cells[0].sourceTokens[0], { sourceSegment: f.items[0].sourceItem })
  if (reason === 'complete crop') f.table.cropRect[0] = 35
  expect(isNativeFigureOwnedClippedTable(f.table, f.figures, 1, { items: f.items })).toBe(false)
})
