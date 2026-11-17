import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { reconcileRepeatedSectionHeadings } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-row-repair.mjs')).href
)
const { recoverRuledInteriorSectionRows } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-fenced-section.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve('test/fixtures/source-grids/unmerged-first-heading-among-complete-sections.jsonl')
  )
it('reconciles an unmerged section using three independently merged headings and complete repeated children', () => {
  const f = fixture(),
    before = structuredClone(f),
    repairs: string[] = []
  reconcileRepeatedSectionHeadings({ ...f, repairs })
  expect(
    f.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 0)
  ).toMatchObject({ colSpan: 3 })
  expect(f.cells.filter((c: { row: number }) => c.row === 1)).toHaveLength(1)
  expect(f.cells.filter((c: { row: number }) => c.row !== 1)).toEqual(
    before.cells.filter((c: { row: number }) => c.row !== 1)
  )
  expect(f.items).toEqual(before.items)
  expect(f.rows).toEqual(before.rows)
  expect(repairs).toEqual(['section-heading-span-reconciled'])
})
it.each([0.7, 1.8])('uses font-relative section evidence at scale %s', (scale) => {
  const f = fixture(),
    repairs: string[] = []
  for (const c of [...f.rows, ...f.cells]) c.rect = c.rect.map((v: number) => v * scale)
  for (const c of f.cells)
    c.sourceRects = c.sourceRects.map((r: number[]) => r.map((v) => v * scale))
  for (const i of f.items) {
    i.rect = i.rect.map((v: number) => v * scale)
    i.height *= scale
    i.baseline *= scale
  }
  f.rules = f.rules.map((r: number[]) => r.map((v) => v * scale))
  reconcileRepeatedSectionHeadings({ ...f, repairs })
  expect(repairs).toEqual(['section-heading-span-reconciled'])
})
it.each([
  'missing witnesses',
  'different children',
  'independent heading value',
  'missing child value',
  'native separator',
  'different heading font',
  'different heading indent',
  'vertical span',
  'unowned source'
])('keeps independent column ownership with %s', (kind) => {
  const f = fixture(),
    heading = f.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 0)
  if (kind === 'missing witnesses')
    for (const c of f.cells) if ([16, 21].includes(c.row)) c.colSpan = 1
  if (kind === 'different children')
    f.cells.find((c: { row: number; column: number }) => c.row === 2 && c.column === 0).text =
      'Group C'
  if (kind === 'independent heading value') {
    const c = f.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 1)
    c.text = '7'
    c.sourceRects = [[300, 204, 308, 218]]
  }
  if (kind === 'missing child value')
    f.cells.find((c: { row: number; column: number }) => c.row === 3 && c.column === 2).text = ''
  if (kind === 'native separator') f.rules.push([76, 220, 638, 220])
  if (kind === 'different heading font')
    for (const i of f.items)
      if (heading.sourceRects.some((r: number[]) => r.every((v, n) => v === i.rect[n])))
        i.height *= 0.6
  if (kind === 'different heading indent')
    for (const r of heading.sourceRects) {
      r[0] += 20
      r[2] += 20
    }
  if (kind === 'vertical span')
    f.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 1).rowSpan = 2
  if (kind === 'unowned source')
    f.items.push({
      text: 'Independent',
      rect: [400, 206, 460, 218],
      baseline: 218,
      height: 12,
      horizontal: true
    })
  const before = structuredClone(f),
    repairs: string[] = []
  reconcileRepeatedSectionHeadings({ ...f, repairs })
  expect(f).toEqual(before)
  expect(repairs).toEqual([])
})

it.each(['closed face', 'broken outer rule', 'inner divider', 'other source'])(
  'accepts an interior heading only in a complete single-cell ruled face: %s',
  (mode) => {
    const grid = [
        ['Field', 'First', 'Second'],
        ['', '', ''],
        ['Record', '12', '65']
      ],
      rows = grid.map((_, row) => ({ rect: [0, row * 20, 300, row * 20 + 20] })),
      cells = grid.flatMap((record, row) =>
        record.map((text, column) => {
          const x = column * 100,
            y = row * 20
          return {
            row,
            column,
            rowSpan: 1,
            colSpan: 1,
            text,
            rect: [x, y, x + 100, y + 20],
            sourceRects: text ? [[x + 5, y + 5, x + 25, y + 13]] : []
          }
        })
      ),
      label = {
        text: 'Trial group',
        sourceItem: { text: 'Trial group', pageNumber: 1, index: 4 },
        rect: [122, 24, 178, 34],
        baseline: 34,
        height: 10,
        horizontal: true
      },
      items = [label],
      unassigned = [label.text],
      rules = [
        [0, 20, 300, 20],
        [0, 40, 300, 40],
        [0, 20, 0, 40],
        [300, 20, 300, 40]
      ]
    if (mode === 'broken outer rule') rules[3][3] = 30
    if (mode === 'inner divider') rules.push([100, 20, 100, 40])
    if (mode === 'other source') items.push({ ...label, text: 'Extra', rect: [40, 24, 59, 34] })
    const before = structuredClone({ grid, rows, cells, unassigned })
    const count = recoverRuledInteriorSectionRows({ grid, rows, cells, items, unassigned, rules })
    if (mode !== 'closed face') {
      expect(count).toBe(0)
      expect({ grid, rows, cells, unassigned }).toEqual(before)
      return
    }
    expect(count).toBe(1)
    expect(unassigned).toEqual([])
    expect(grid[1]).toEqual([label.text, '', ''])
    expect(cells.filter((cell) => cell.row === 1)).toEqual([
      expect.objectContaining({
        column: 0,
        colSpan: 3,
        text: label.text,
        rect: rows[1].rect,
        sourceItems: [label.sourceItem]
      })
    ])
    expect(cells.filter((cell) => cell.row !== 1)).toEqual(
      before.cells.filter((cell) => cell.row !== 1)
    )
    expect(rows).toEqual(before.rows)
  }
)
