import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-evidence.mjs')).href
)
const token = (text: string, rect: number[], height = 10): ReturnType<typeof JSON.parse> => ({
  text,
  rect,
  height,
  baseline: rect[3],
  horizontal: true
})
const footnote = (): ReturnType<typeof JSON.parse> => {
  const items = [
      token(
        'One complete paragraph tail contains several ordinary words',
        [0, 40, 220, 53.5],
        13.5
      ),
      token(
        'Another complete paragraph tail contains several ordinary words',
        [-0.5, 57, 220, 70.5],
        13.5
      ),
      token(
        'A final complete paragraph tail contains several ordinary words',
        [0, 74, 220, 87.5],
        13.5
      ),
      token('images.', [240, 28, 265, 41.5], 13.5),
      token('1', [240, 76.3, 244, 83.8], 7.5),
      token('https://example.org/anonymous', [245, 78.5, 375, 87.5], 9)
    ],
    table = {
      cropRect: [45, 20, 290, 105],
      grid: [
        [items[0].text, items[3].text],
        [items[1].text, ''],
        [items[2].text, '1']
      ],
      cells: items.slice(0, 5).map((i, n) => ({
        text: i.text,
        row: n < 3 ? n : n === 3 ? 0 : 2,
        column: n < 3 ? 0 : 1,
        rect: i.rect,
        sourceRects: [i.rect],
        rowSpan: 1,
        colSpan: 1
      })),
      issues: [],
      unassigned: [],
      clipped: []
    }
  return { table, items, rules: [[240, 74.2, 310, 74.2]] }
}
it('rejects paragraph tails beside a separately ruled small-font footnote despite native line indent rounding', () => {
  const f = footnote(),
    before = structuredClone(f)
  expect(hasTableEvidence(f.table, undefined, f.items, f.rules)).toBe(false)
  expect(f).toEqual(before)
  expect(hasTableEvidence(f.table, { lines: ['Table 1: Explicit data.'] }, f.items, f.rules)).toBe(
    true
  )
  f.rules = []
  expect(hasTableEvidence(f.table, undefined, f.items, f.rules)).toBe(true)
})
const directory = (): ReturnType<typeof JSON.parse> => {
  const items = [token('Contents', [10, 30, 70, 44], 14)]
  for (let n = 1; n <= 6; n++) {
    items.push(token(`S${n} Anonymous section wording`, [10, 45 + n * 25, 150, 55 + n * 25]))
    items.push(token(String(Math.ceil(n / 2) * 2), [260, 45 + n * 25, 266, 55 + n * 25]))
  }
  return {
    items,
    table: {
      cropRect: [0, 20, 275, 230],
      grid: Array.from({ length: 6 }, (_, n) => [items[n * 2 + 1].text, items[n * 2 + 2].text]),
      cells: [],
      issues: [],
      unassigned: [],
      clipped: []
    }
  }
}
it('rejects a complete source-owned flat supplemental section/page directory', () => {
  const f = directory(),
    before = structuredClone(f)
  expect(hasTableEvidence(f.table, undefined, f.items, [])).toBe(false)
  expect(f).toEqual(before)
})
it.each([
  'no heading',
  'neighbor heading',
  'nonconsecutive labels',
  'misaligned targets',
  'interior rule',
  'caption'
])('preserves ambiguous flat section rows with %s', (variant) => {
  const f = directory()
  if (variant === 'no heading') f.items.shift()
  if (variant === 'neighbor heading') f.items[0].rect[0] = -150
  if (variant === 'nonconsecutive labels') f.items[3].text = 'S8 Anonymous section wording'
  if (variant === 'misaligned targets') f.items[4].rect = [230, 110, 236, 120]
  const rules = variant === 'interior rule' ? [[0, 130, 275, 130]] : []
  const caption = variant === 'caption' ? { lines: ['Table 1: Explicit data.'] } : undefined
  expect(hasTableEvidence(f.table, caption, f.items, rules)).toBe(true)
})

const mixedDirectory = (): ReturnType<typeof JSON.parse> => {
  let index = 0
  const whole = (
    text: string,
    x: number,
    y: number,
    width: number
  ): ReturnType<typeof JSON.parse> => ({
    ...token(text, [x, y, x + width, y + 10]),
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  const items = [whole('Contents', 200, 55, 60)],
    entries = [['References', '2']]
  for (let n = 1; n <= 3; n++)
    entries.push(
      [`S${n}. Anonymous section`, String(n * 2 + 2)],
      [`${n}.1. Anonymous subsection`, String(n * 2 + 2)]
    )
  const cells: ReturnType<typeof JSON.parse>[] = [],
    grid: string[][] = []
  for (const [row, [text, target]] of entries.entries()) {
    const y = 90 + row * 22,
      label = whole(text, /^\d\./u.test(text) ? 25 : 20, y, 220),
      page = whole(target, 434, y, 6)
    items.push(label, page)
    grid.push([text, target])
    for (const [column, f] of [label, page].entries())
      cells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: f.text,
        rect: [...f.rect],
        sourceRects: [[...f.rect]],
        sourceItems: [f.sourceItem],
        sourceTokens: [{ text: f.text, rect: [...f.rect], baseline: f.baseline, height: f.height }]
      })
  }
  return {
    table: { cropRect: [10, 80, 450, 245], grid, cells, unassigned: [], clipped: [], issues: [] },
    items,
    rules: [],
    graphics: [],
    caption: undefined
  }
}
const changeMixedLabel = (f: ReturnType<typeof JSON.parse>, index: number, text: string): void => {
  const item = f.items[index]
  item.text = item.sourceItem.text = text
  for (const cell of f.table.cells)
    if (cell.sourceItems.includes(item.sourceItem)) {
      cell.text = cell.sourceTokens[0].text = text
      f.table.grid[cell.row][cell.column] = text
    }
}
it.each([false, true])(
  'rejects a source-owned mixed supplemental Contents directory (residual=%s)',
  (residual) => {
    const f = mixedDirectory()
    if (residual) {
      const pair = f.table.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row === 2)
      f.table.cells = f.table.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row !== 2)
      f.table.unassigned = pair.map((c: ReturnType<typeof JSON.parse>) => c.text)
    }
    const before = structuredClone(f)
    expect(hasTableEvidence(f.table, f.caption, f.items, f.rules, f.graphics)).toBe(false)
    expect(f).toEqual(before)
  }
)
it.each([
  'missing heading',
  'duplicate heading',
  'distant heading',
  'occupied corridor',
  'skipped major',
  'wrong child parent',
  'skipped child',
  'decreasing page',
  'fractional page',
  'misaligned page',
  'caption',
  'internal rule',
  'internal image',
  'missing carrier',
  'duplicate identity',
  'extra carrier',
  'partial carrier',
  'missing claim',
  'unknown residual',
  'numeric data'
])('retains an ambiguous mixed navigation candidate with %s', (variant) => {
  const f = mixedDirectory()
  if (variant === 'missing heading') f.items.shift()
  if (variant === 'duplicate heading')
    f.items.push({
      ...structuredClone(f.items[0]),
      sourceItem: { pageNumber: 1, index: 99, text: 'Contents' }
    })
  if (variant === 'distant heading') f.items[0].rect = [200, 10, 260, 20]
  if (variant === 'occupied corridor' || variant === 'extra carrier') {
    const y = variant === 'occupied corridor' ? 68 : 150
    f.items.push({
      ...token('Foreign prose', [20, y, 100, y + 10]),
      sourceItem: { pageNumber: 1, index: 99, text: 'Foreign prose' }
    })
  }
  if (variant === 'skipped major') changeMixedLabel(f, 7, 'S8. Anonymous section')
  if (variant === 'wrong child parent') changeMixedLabel(f, 9, '1.1. Anonymous subsection')
  if (variant === 'skipped child') changeMixedLabel(f, 5, '1.3. Anonymous subsection')
  if (variant === 'decreasing page') changeMixedLabel(f, 8, '1')
  if (variant === 'fractional page') changeMixedLabel(f, 8, '1.5')
  if (variant === 'misaligned page') {
    const item = f.items[8]
    item.rect = item.rect.map((v: number, n: number) => v - (n % 2 ? 0 : 1))
    const cell = f.table.cells[7]
    cell.rect = [...item.rect]
    cell.sourceRects = [[...item.rect]]
    cell.sourceTokens[0].rect = [...item.rect]
  }
  if (variant === 'caption') f.caption = { lines: ['Table 1: Explicit data.'] }
  if (variant === 'internal rule') f.rules.push([10, 150, 450, 150])
  if (variant === 'internal image') f.graphics.push({ kind: 'image', rect: [100, 140, 110, 150] })
  if (variant === 'missing carrier') f.items.splice(5, 1)
  if (variant === 'duplicate identity') f.items[4].sourceItem.index = f.items[2].sourceItem.index
  if (variant === 'partial carrier') f.items[1].rect[0] = 0
  if (variant === 'missing claim') f.table.cells[2].sourceItems = []
  if (variant === 'unknown residual') f.table.unassigned.push('Unknown residual')
  if (variant === 'numeric data')
    for (let n = 1; n < f.items.length; n += 2) changeMixedLabel(f, n, `Measured value ${n}`)
  const before = structuredClone(f)
  expect(hasTableEvidence(f.table, f.caption, f.items, f.rules, f.graphics)).toBe(true)
  expect(f).toEqual(before)
})
