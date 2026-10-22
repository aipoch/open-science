/* eslint-disable @typescript-eslint/explicit-function-return-type -- inferred anonymous fixture shapes */
import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const {
  nativeTableSourceConflicts,
  reviewNativeTableSources,
  reviewFinalNativeTableSources,
  trimNativeTablePageCounterCrop
} = await import(pathToFileURL(resolve('resources/literature-pdf-table-source-integrity.mjs')).href)
type Font = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
  sourceItem: { pageNumber: number; index: number; text: string }
}
const font = (text: string, x: number, y: number, index: number, width = 20): Font => ({
  text,
  rect: [x, y, x + width, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true,
  sourceItem: { pageNumber: 1, index, text }
})
const cell = (row: number, column: number, fonts: Font[]) => ({
  row,
  column,
  rowSpan: 1,
  colSpan: 1,
  text: fonts.map((f) => f.text).join(' '),
  sourceRects: fonts.map((f) => f.rect),
  sourceItems: fonts.map((f) => f.sourceItem)
})
function table(cells: ReturnType<typeof cell>[], unassigned: string[] = []) {
  const grid = Array.from({ length: Math.max(...cells.map((c) => c.row)) + 1 }, () =>
    Array(Math.max(...cells.map((c) => c.column)) + 1).fill('')
  )
  cells.forEach((c) => {
    grid[c.row][c.column] = c.text
  })
  return { cropRect: [0, 0, 300, 190], grid, cells, unassigned, issues: [] }
}
it.each(['left', 'right'])(
  'isolates a complete native owner clipped by the final %s crop edge',
  (edge) => {
    const f = font('Native label', edge === 'left' ? 0 : 100, 30, 0, 40)
    const bad = { ...table([cell(0, 0, [f])]), cropRect: [20, 0, 120, 100] }
    const goodFont = font('Independent value', 70, 60, 1)
    const good = table([cell(0, 0, [goodFont])])
    const input = { cropRect: [0, 0, 300, 190], parts: [bad, good], thumbnail: 'original.png' }
    const before = JSON.stringify(input)
    const result = reviewFinalNativeTableSources(input, [f, goodFont], [])
    expect(result.parts[0].issues).toEqual(['native-table-structure-ambiguous'])
    expect(result.parts[0].cells).toBe(bad.cells)
    expect(result.parts[0].grid).toBe(bad.grid)
    expect(result.parts[0].cropRect).toBe(bad.cropRect)
    expect(result.parts[1]).toBe(good)
    expect(result.thumbnail).toBe(input.thumbnail)
    expect(JSON.stringify(input)).toBe(before)
  }
)
it.each([
  'small overhang',
  'measured segment',
  'wrong rectangle',
  'duplicate native',
  'wrong text'
])('does not infer clipped whole ownership from %s', (reason) => {
  const f = font('Native label', 0, 30, 0, 40)
  const c = cell(0, 0, [f])
  const t = { ...table([c]), cropRect: [20, 0, 120, 100] }
  const inventory = [f]
  if (reason === 'small overhang') t.cropRect[0] = 5
  if (reason === 'measured segment') {
    const measured = {
      ...t,
      cells: [
        {
          ...c,
          text: 'label',
          sourceItems: undefined,
          sourceRects: [[25, 30, 40, 40]],
          sourceSegments: [{ ...f.sourceItem, start: 7, end: 12, rect: [25, 30, 40, 40] }]
        }
      ]
    }
    expect(reviewFinalNativeTableSources(measured, inventory, [])).toBe(measured)
    return
  }
  if (reason === 'wrong rectangle') c.sourceRects = [[20, 30, 40, 40]]
  if (reason === 'duplicate native') inventory.push({ ...f })
  if (reason === 'wrong text') f.text = 'Other text'
  expect(reviewFinalNativeTableSources(t, inventory, [])).toBe(t)
})
it('isolates a final native contradiction to its table part and preserves original sources', () => {
  const fonts = [0, 1, 2, 3].flatMap((r) => [
    font(String(r), 10, 20 + r * 25, r * 2),
    font('value', 70, 20 + r * 25, r * 2 + 1)
  ])
  const collapsed = table([0, 1, 2, 3].map((r) => cell(r, 0, fonts.slice(r * 2, r * 2 + 2))))
  const valid = table(fonts.map((f, i) => cell(Math.floor(i / 2), i % 2, [f])))
  const part = { cells: collapsed.cells, grid: collapsed.grid, issues: collapsed.issues }
  const input = { cropRect: collapsed.cropRect, parts: [part, valid], thumbnail: 'original.png' }
  const checked = reviewFinalNativeTableSources(input, fonts, [[50, 15, 50, 110]])
  expect(checked.parts[0].issues).toEqual(['native-table-structure-ambiguous'])
  expect(checked.parts[0].cells).toBe(part.cells)
  expect(checked.parts[0]).not.toHaveProperty('cropRect')
  expect(checked.parts[1]).toBe(valid)
  expect(checked.thumbnail).toBe(input.thumbnail)
  expect(input.parts[0].issues).toEqual([])
})
it('distinguishes an omitted printed header from an unrelated trailing note', () => {
  const a = font('Name', 10, 10, 0),
    b = font('Value', 100, 10, 1),
    data = [font('A', 10, 40, 2), font('12', 100, 40, 3)],
    tail = font('Note', 10, 90, 4)
  const t = table(
    [cell(0, 0, [a]), cell(0, 1, []), cell(1, 0, [data[0]]), cell(1, 1, [data[1]])],
    ['Value', 'Note']
  )
  expect(nativeTableSourceConflicts(t, [a, b, ...data, tail])).toContain(
    'unassigned-printed-header'
  )
  expect(nativeTableSourceConflicts({ ...t, unassigned: ['Note'] }, [a, ...data, tail])).toEqual([])
  // A title above fully owned headers does not contradict any leaf column.
  const complete = { ...t, cells: [cell(0, 0, [a]), cell(0, 1, [b]), ...t.cells.slice(2)] }
  const title = font('Independent section heading', 10, 0, 5, 200)
  expect(
    nativeTableSourceConflicts({ ...complete, unassigned: [title.text] }, [a, b, ...data, title])
  ).toEqual([])
  // An empty slot alone cannot assign unrelated words to that column.
  const remote = font('Separate heading', 200, 10, 6)
  expect(
    nativeTableSourceConflicts({ ...t, unassigned: [remote.text] }, [a, ...data, remote])
  ).toEqual([])
})
it('does not assign separate pieces of one grouped heading to adjacent leaf columns', () => {
  const a = [font('N', 90, 5, 0, 10), font('Low', 60, 30, 1)],
    b = [font('ABC', 100, 9, 2, 18), font('High', 140, 30, 3)]
  const t = table([cell(0, 0, a), cell(0, 1, b)])
  expect(nativeTableSourceConflicts(t, [...a, ...b])).toContain('header-split-between-columns')
  expect(nativeTableSourceConflicts(t, [...a, ...b, { ...b[0] }])).toEqual([])
})
it('flags an omitted native leaf heading below a grouped header', () => {
  const omitted = font('Name Type', 10, 25, 0, 80),
    first = font('First', 120, 25, 1),
    second = font('Second', 200, 25, 2),
    one = font('A', 10, 55, 3),
    two = font('B', 10, 80, 4)
  const cells = [
    cell(0, 0, []),
    cell(1, 0, []),
    cell(1, 1, [first]),
    cell(1, 2, [second]),
    cell(2, 0, [one]),
    cell(3, 0, [two])
  ]
  const t = table(cells, [omitted.text])
  expect(nativeTableSourceConflicts(t, [omitted, first, second, one, two])).toContain(
    'unassigned-printed-header'
  )
  expect(nativeTableSourceConflicts(t, [omitted, first, one, two])).toEqual([])
})
it('recognizes a wholly omitted header row only with independent aligned body columns', () => {
  const heads = [font('Left', 10, 10, 0, 35), font('Right', 100, 10, 1, 35)],
    values = [
      font('A', 10, 40, 2),
      font('12', 100, 40, 3),
      font('B', 10, 70, 4),
      font('24', 100, 70, 5)
    ]
  const t = table(
    values.map((f, i) => cell(Math.floor(i / 2), i % 2, [f])),
    heads.map((f) => f.text)
  )
  expect(nativeTableSourceConflicts(t, [...heads, ...values])).toContain(
    'unassigned-printed-header'
  )
  expect(nativeTableSourceConflicts(t, [heads[0], ...values])).toEqual([])
  const note = font('Note spans both columns', 10, 10, 7, 125)
  expect(nativeTableSourceConflicts({ ...t, unassigned: [note.text] }, [note, ...values])).toEqual(
    []
  )
})
it('recognizes a repeated separate numeric leaf lane but not a prose suffix', () => {
  const rows = [
    ['Description', '§'],
    ['One', '1'],
    ['Two', '2'],
    ['Three', '3']
  ]
  const fonts = rows.flatMap(([label, n], r) => [
    font(label, 10, r * 30, r * 2, 40),
    font(n, 120, r * 30, r * 2 + 1, 7)
  ])
  const t = table(rows.map((_, r) => cell(r, 0, fonts.slice(r * 2, r * 2 + 2))))
  expect(nativeTableSourceConflicts(t, fonts)).toContain('independent-terminal-column')
  expect(nativeTableSourceConflicts({ ...t, cells: t.cells.slice(0, 2) }, fonts)).toEqual([])
})
it('rejects independent numeric records collapsed across aligned leaf columns', () => {
  const fonts = [0, 1, 2].flatMap((column) => [
    font('12.5', 20 + column * 80, 30, column * 2),
    font('24.1', 20 + column * 80, 50, column * 2 + 1)
  ])
  const cells = [0, 1, 2].map((column) => cell(1, column, fonts.slice(column * 2, column * 2 + 2)))
  const input = table(cells)
  expect(reviewNativeTableSources(input, fonts)).toBe(input)
  expect(nativeTableSourceConflicts(table(cells), fonts)).toContain('collapsed-numeric-records')
  expect(reviewFinalNativeTableSources(table(cells), fonts, []).issues).toContain(
    'native-table-structure-ambiguous'
  )
  // Two multiline values alone do not establish independent records.
  expect(nativeTableSourceConflicts(table(cells.slice(0, 2)), fonts)).toEqual([])
  const prose = fonts.map((f) => ({
    ...f,
    text: 'wrapped text',
    sourceItem: { ...f.sourceItem, text: 'wrapped text' }
  }))
  expect(
    nativeTableSourceConflicts(
      table([0, 1, 2].map((column) => cell(1, column, prose.slice(column * 2, column * 2 + 2)))),
      prose
    )
  ).toEqual([])
  const staggered = fonts.map((f, i) => ({ ...f, baseline: f.baseline + Math.floor(i / 2) * 5 }))
  expect(nativeTableSourceConflicts(table(cells), staggered)).toEqual([])
})
it('joins only adjacent same-baseline native fragments when checking collapsed numeric records', () => {
  const fonts = [0, 1, 2].flatMap((column) => [
    font('−', 10 + column * 80, 30, column * 4, 5),
    font('2.5', 15 + column * 80, 30, column * 4 + 1, 15),
    font('4', 15 + column * 80, 50, column * 4 + 2, 5),
    font('.1', 20 + column * 80, 50, column * 4 + 3, 10)
  ])
  const cells = [0, 1, 2].map((column) => cell(1, column, fonts.slice(column * 4, column * 4 + 4)))
  expect(nativeTableSourceConflicts(table(cells), fonts)).toContain('collapsed-numeric-records')
  expect(nativeTableSourceConflicts(table(cells), [...fonts, { ...fonts[0] }])).toEqual([])
  const scripted = fonts.map((f, i) => (i % 4 === 3 ? { ...f, height: 4 } : f))
  expect(nativeTableSourceConflicts(table(cells), scripted)).toEqual([])
})
it('flags repeated tail lines that precede the next top-aligned record', () => {
  const fonts: Font[] = [],
    cells: ReturnType<typeof cell>[] = []
  for (let r = 0; r < 4; r++) {
    const stub = font('Row', 10, r * 40, fonts.length)
    fonts.push(stub)
    cells.push(cell(r, 0, [stub]))
    const value = font('Body', 100, r * 40, fonts.length)
    fonts.push(value)
    const owned = [value]
    if (r > 1) {
      const tail = font('tail)', 100, r * 40 - 17, fonts.length)
      fonts.push(tail)
      owned.unshift(tail)
    }
    cells.push(cell(r, 1, owned))
  }
  expect(nativeTableSourceConflicts(table(cells), fonts)).toContain(
    'body-line-crosses-record-start'
  )
  expect(nativeTableSourceConflicts(table(cells.slice(0, 6)), fonts)).toEqual([])
})
it('retains a wide native heading as uncertain when the adjacent heading is only a marker', () => {
  const fonts = [
    font('First Second', 10, 5, 0, 130),
    font('†', 145, 5, 1, 5),
    font('10', 20, 40, 2),
    font('20', 100, 40, 3),
    font('30', 20, 70, 4),
    font('40', 100, 70, 5)
  ]
  const t = table(fonts.map((f, n) => cell(Math.floor(n / 2), n % 2, [f])))
  expect(nativeTableSourceConflicts(t, fonts)).toContain('header-crosses-independent-column')
})
it('trims only a proven page counter below a closing rule, retaining the final table row', () => {
  const last = [font('Final', 10, 154, 0), font('42', 250, 154, 1)],
    folio = font('1/3', 270, 169, 2)
  const t = table([cell(0, 0, [last[0]]), cell(0, 1, [last[1]])]),
    rules = [[5, 170, 295, 170]],
    context = { pageNumber: 1, pageCount: 3, height: 200 }
  const result = trimNativeTablePageCounterCrop(t, [...last, folio], rules, context)
  expect(result.cropRect[3]).toBe(170.5)
  expect(result.cells).toEqual(t.cells)
  const record = font('Another row', 10, 175, 3)
  expect(trimNativeTablePageCounterCrop(t, [...last, folio, record], rules, context)).toBe(t)
})
