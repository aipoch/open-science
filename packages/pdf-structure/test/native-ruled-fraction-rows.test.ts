import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const input = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture('test/fixtures/source-grids/native-ruled-fraction-rows.jsonl')

it('keeps ruled fraction denominators with their own record and preserves the next scalar row', () => {
  const f = input(),
    before = structuredClone(f)
  const r = refineTable(f.table, f.pageItems, f.captions, [], f.rules)
  const denominators = r.cells.filter((c: { sourceItems?: { text: string }[] }) =>
    c.sourceItems?.some((i) => i.text === '4000')
  )
  expect(denominators).toHaveLength(1)
  expect(denominators[0]).toMatchObject({ row: 1, column: 1 })
  expect(denominators[0].text).toBe('[5e−4/4000,5e−6/4000]')
  expect(denominators[0].textRuns).toBeUndefined()
  for (const cell of r.cells)
    if (cell.textRuns)
      expect(cell.textRuns.map((run: { text: string }) => run.text).join('')).toBe(cell.text)
  expect(
    denominators[0].sourceItems.filter((i: { text: string }) => i.text === '4000')
  ).toHaveLength(2)
  expect(r.grid[2]).toEqual(['|Sk|', '40'])
  expect(r.grid).toHaveLength(4)
  expect(
    r.cells
      .flatMap((c: { sourceItems?: { index: number }[] }) => c.sourceItems ?? [])
      .map((i: { index: number }) => i.index)
      .sort((a: number, b: number) => a - b)
  ).toEqual(f.pageItems.map((i: { sourceItem: { index: number } }) => i.sourceItem.index))
  expect(f).toEqual(before)
  for (const cell of r.cells)
    for (const rect of cell.sourceRects ?? []) {
      expect(rect[0]).toBeGreaterThanOrEqual(cell.rect[0])
      expect(rect[1]).toBeGreaterThanOrEqual(cell.rect[1])
      expect(rect[2]).toBeLessThanOrEqual(cell.rect[2])
      expect(rect[3]).toBeLessThanOrEqual(cell.rect[3])
    }
})

it.each(['missing-bars', 'missing-fence', 'unproved-stack'])(
  'does not reinterpret native math rows with %s',
  (failure) => {
    const f = input()
    if (failure === 'missing-bars') f.rules = f.rules.filter((r: number[]) => r[2] - r[0] > 100)
    if (failure === 'missing-fence')
      f.rules = f.rules.filter((r: number[]) => Math.abs(r[1] - 976.7445) > 0.01)
    if (failure === 'unproved-stack') {
      const item = f.pageItems.find((i: { text: string }) => i.text === '4000')
      item.rect[0] -= 12
      item.rect[2] -= 12
    }
    const r = refineTable(f.table, f.pageItems, f.captions, [], f.rules)
    expect(r.repairs).not.toContain('native-closed-field-faces-recovered')
  }
)
