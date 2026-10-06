import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-evidence.mjs')).href
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
