import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const { recoverWrappedCountTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-wrapped-count-grid.mjs')).href
)
const { refineTable, hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
type Token = { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }
const token = (text: string, x: number, y: number): Token => ({
  text,
  rect: [x, y, x + text.length * 7, y + 18],
  baseline: y + 18,
  height: 18,
  horizontal: true
})
function fixture(): Token[] {
  const items: Token[] = []
  for (let section = 0; section < 3; section++) {
    const y = 160 + section * 210
    items.push(
      token(['Therapy', 'Radiotherapy', 'Endocrine therapy'][section], 128, y),
      token('0.123', 708, y + 103)
    )
    for (let row = 0; row < 2; row++) {
      const line = y + 62 + row * 82
      items.push(token(row ? 'no' : 'yes', 178, line))
      for (let c = 0; c < 3; c++)
        items.push(
          token(row ? '40' : '60', 356 + c * 117, line),
          token(row ? '(40.' : '(60.', 413 + c * 117, line - 20),
          token('0)', 413 + c * 117, line + 21)
        )
    }
  }
  return items
}
it('recovers headerless categorical tables with wrapped percentages and shared probabilities', () => {
  const items = fixture(),
    before = structuredClone(items)
  const raw = recoverWrappedCountTable(items, [], 2)
  expect(raw).toBeDefined()
  const t = refineTable(raw, items, [], [], [])
  expect(hasTableEvidence(t, undefined, items)).toBe(true)
  expect(t.grid).toHaveLength(9)
  for (const row of [1, 4, 7]) {
    expect(t.grid[row]).toEqual(['yes', '60', '(60.0)', '60', '(60.0)', '60', '(60.0)', '0.123'])
    expect(t.grid[row + 1]).toEqual(['no', '40', '(40.0)', '40', '(40.0)', '40', '(40.0)', ''])
    expect(t.cells).toContainEqual(
      expect.objectContaining({ row, column: 7, rowSpan: 2, colSpan: 1, text: '0.123' })
    )
  }
  expect(t.unassigned).toEqual([])
  expect(
    t.cells
      .flatMap((c: { sourceTokens: { text: string }[] }) => c.sourceTokens.map((i) => i.text))
      .sort()
  ).toEqual(items.map((i) => i.text).sort())
  expect(items).toEqual(before)
})
it('preserves source rounding without replacing it', () => {
  const items = fixture()
  const index = items.findIndex((i) => i.text === '0)')
  items[index].text = '1)'
  const raw = recoverWrappedCountTable(items, [], 2)
  expect(raw).toBeDefined()
  expect(refineTable(raw, items, [], [], []).grid[1][2]).toBe('(60.1)')
})
it('retains a source heading fragment after the last complete category', () => {
  const items = fixture()
  items.push(token('Next category', 128, 805))
  const raw = recoverWrappedCountTable(items, [], 2)
  expect(raw).toBeDefined()
  expect(refineTable(raw, items, [], [], []).grid.at(-1)[0]).toBe('Next category')
})
it.each([
  'missing suffix',
  'inconsistent total',
  'incorrect percentage',
  'missing probability',
  'two probabilities',
  'misaligned column',
  'dividing rule',
  'extra prose',
  'no category titles'
])('rejects %s rather than certifying an incomplete or contradictory grid', (reason) => {
  const items = fixture(),
    rules: number[][] = []
  if (reason === 'missing suffix')
    items.splice(
      items.findIndex((i) => i.text === '0)'),
      1
    )
  if (reason === 'inconsistent total') items.find((i) => i.text === '40')!.text = '41'
  if (reason === 'incorrect percentage') items.find((i) => i.text === '(60.')!.text = '(90.'
  if (reason === 'missing probability')
    items.splice(
      items.findIndex((i) => i.text === '0.123'),
      1
    )
  if (reason === 'two probabilities') items.push(token('0.456', 708, 245))
  if (reason === 'misaligned column') {
    const i = items.find((i) => i.text === '60')!
    i.rect[0] += 10
    i.rect[2] += 10
  }
  if (reason === 'dividing rule') rules.push([128, 235, 750, 235])
  if (reason === 'extra prose') items.push(token('Other text', 480, 350))
  if (reason === 'no category titles')
    for (let i = items.length - 1; i >= 0; i--) if (items[i].rect[0] === 128) items.splice(i, 1)
  expect(recoverWrappedCountTable(items, rules, 2)).toBeUndefined()
})

it('retains dash-only missing categories without filling them with zeros', () => {
  const items = fixture()
  for (let section = 0; section < 3; section++) {
    const y = 160 + section * 210 + 187
    items.push(token('unknown', 178, y))
    for (let c = 0; c < 3; c++)
      items.push(token('-', 356 + c * 117, y), token('-', 413 + c * 117, y))
  }
  const raw = recoverWrappedCountTable(items, [], 2)
  expect(raw).toBeDefined()
  const t = refineTable(raw, items, [], [], [])
  expect(t.grid.filter((r: string[]) => r[0] === 'unknown')).toEqual(
    Array.from({ length: 3 }, () => ['unknown', '-', '-', '-', '-', '-', '-', ''])
  )
})
