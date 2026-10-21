import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-evidence.mjs')).href
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function directory() {
  const entries: [string, number, number, number, number][] = [
    ['Section directory', 50, 10, 150, 14]
  ]
  for (const [i, title] of ['First topic', 'Second topic', 'Third topic'].entries())
    entries.push(
      [String.fromCharCode(65 + i), 10, 40 + i * 20, 18, 10],
      [title, 30, 40 + i * 20, 130, 10],
      [String(5 + i), 180, 40 + i * 20, 190, 10]
    )
  entries.push(['4', 95, 110, 103, 10])
  const items = entries.map(([text, left, baseline, right, height], index) => ({
    text,
    rect: [left, baseline - height, right, baseline],
    baseline,
    height,
    horizontal: true,
    sourceItem: { pageNumber: 4, index, text }
  }))
  const grid = [0, 1, 2].map((i) => [items[i * 3 + 2].text, items[i * 3 + 3].text]),
    cells = grid.flatMap((row, r) =>
      row.map((text, column) => {
        const item = items[r * 3 + column + 2]
        return {
          row: r,
          column,
          rowSpan: 1,
          colSpan: 1,
          text,
          rect: column ? [170, 30 + r * 20, 195, 50 + r * 20] : [25, 30 + r * 20, 160, 50 + r * 20],
          sourceItems: [item.sourceItem],
          sourceRects: [item.rect]
        }
      })
    )
  const navigation = {
    pageNumber: 4,
    documentPages: 12,
    links: [0, 1, 2].map((i) => ({
      rect: [8, 29 + i * 20, 132, 42 + i * 20],
      destination: `section-${i}`,
      targetPage: 5 + i
    })),
    outline: grid.map((row, i) => ({ title: row[0], destination: `section-${i}`, page: 5 + i }))
  }
  return {
    table: { page: 4, grid, cells, cropRect: [25, 25, 195, 85], unassigned: [], issues: [] },
    items,
    navigation
  }
}
it('excludes only the complete source-backed local navigation directory', () => {
  const f = directory(),
    before = structuredClone(f)
  expect(hasTableEvidence(f.table, undefined, f.items, [], [])).toBe(true)
  expect(hasTableEvidence(f.table, undefined, f.items, [], [], f.navigation)).toBe(false)
  expect(f).toEqual(before)
})
it('keeps a complete native label intact when its ordinal and title share one source', () => {
  const f = directory()
  const ordinal = f.items[1],
    title = f.items[2]
  title.text = `${ordinal.text} ${title.text}`
  title.sourceItem.text = title.text
  title.rect[0] = ordinal.rect[0]
  f.items.splice(1, 1)
  f.table.cells[0].text = title.text
  f.table.grid[0][0] = title.text
  const before = structuredClone(f)
  expect(hasTableEvidence(f.table, undefined, f.items, [], [], f.navigation)).toBe(false)
  expect(f).toEqual(before)
})
it.each([
  'destination',
  'page number',
  'outline title',
  'duplicate link',
  'unlinked row',
  'source',
  'caption',
  'rule',
  'graphic'
])('retains a table candidate without complete %s navigation evidence', (guard) => {
  const f = directory()
  let caption
  const rules: number[][] = [],
    graphics: { kind: string; rect: number[] }[] = []
  if (guard === 'destination') f.navigation.links[0].destination = 'unknown'
  if (guard === 'page number') f.navigation.links[0].targetPage = 9
  if (guard === 'outline title') f.navigation.outline[0].title = 'Different topic'
  if (guard === 'duplicate link') f.navigation.links.push(structuredClone(f.navigation.links[0]))
  if (guard === 'unlinked row') f.navigation.links.pop()
  if (guard === 'source') f.table.cells[0].sourceRects[0] = []
  if (guard === 'caption') caption = { page: 4, lines: ['Table 3. Comparison.'] }
  if (guard === 'rule') rules.push([0, 90, 200, 90])
  if (guard === 'graphic') graphics.push({ kind: 'path', rect: [0, 20, 200, 90] })
  expect(hasTableEvidence(f.table, caption, f.items, rules, graphics, f.navigation)).toBe(true)
})
