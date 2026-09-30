import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
it.each([
  ['overlapping-category-with-raised-note', 'Other'],
  ['overlapping-record-with-missing-value-dashes', 'ALT increased'],
  ['inserted-record-overlapping-model-band', 'Illiterate']
])('retains the complete native record in %s', (name, label) => {
  const x = fixture(name),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.unassigned).not.toContain(label)
  expect(t.grid.some((row: string[]) => row[0] === label)).toBe(true)
  if (label === 'Other') expect(t.grid).toContainEqual(['Other', '9 (10.3)e', '2 (2.3)f', ''])
  if (label === 'ALT increased')
    expect(t.grid.find((row: string[]) => row[0] === label)?.[6]).toBe('1')
  if (label === 'Illiterate')
    for (const row of [
      ['Illiterate', '2 (5.4)', '6 (17.1)', '8 (11.1)'],
      ['Married', '30 (81.1)', '31 (88.6)', '61 (84.7)'],
      ['Employed', '11 (29.7)', '4 (11.4)', '15 (20.8)']
    ]) {
      expect(t.unassigned).not.toContain(row[0])
      expect(t.grid.map((record: string[]) => record.slice(0, 4))).toContainEqual(row)
    }
})
it('preserves both headers and the unruled last row of a striped table', () => {
  const x = fixture('striped-table-with-unruled-final-record'),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toContainEqual(['Myalgia', '11 (11.0)', '0 (0.0)', '8 (4.0)', '0 (0.0)'])
  expect(t.grid.flat().join(' ')).toContain('Any Grade')
  expect(t.cropRect[1]).toBeLessThan(100)
  expect(t.cropRect[3]).toBeGreaterThan(614)
  expect(t.rows[0].rect[1]).toBeGreaterThan(x.captions[0].rect[3])
})

it('separates repeated ordinal leaves collapsed into the final model column', () => {
  const x = fixture('overlapping-record-with-missing-value-dashes')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toContainEqual(['Toxicity Type', '1, 2', '3', '4', '5', '1, 2', '3', '4', '5'])
  expect(t.grid).toContainEqual(['Anemia', '48', '7', '—', '—', '30', '—', '—', '—'])
  expect(t.grid).toContainEqual(['Worst degree', '53', '21', '5', '—', '69', '15', '1', '—'])
})

it('retains a clipped final summary and its two treatment-wide cells', () => {
  const x = fixture('clipped-summary-under-grouped-columns')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid.at(-1)).toEqual(['Median (range)', '174 (66-266)', '', '165 (112-289)', ''])
  expect(t.cells.filter((cell: { row: number }) => cell.row === t.grid.length - 1)).toMatchObject([
    { column: 0, colSpan: 1, text: 'Median (range)' },
    { column: 1, colSpan: 2, text: '174 (66-266)' },
    { column: 3, colSpan: 2, text: '165 (112-289)' }
  ])
  expect(t.cropRect[3]).toBeGreaterThan(651)
  expect(t.cropRect[3]).toBeLessThan(668)
  expect(t.clipped).toEqual([])
})

it.each(['missing-repeated-header', 'source-crosses-divider'])(
  'does not split ordinal columns without independent evidence: %s',
  (variant) => {
    const x = fixture('overlapping-record-with-missing-value-dashes')
    if (variant === 'missing-repeated-header') {
      x.tokens = x.tokens.filter(
        (i: { text: string; rect: number[] }) =>
          !(i.text === '5' && i.rect[0] < 600 && i.rect[1] < 145)
      )
    } else {
      const token = x.tokens.find(
        (i: { rect: number[] }) => i.rect[0] > 800 && i.rect[1] > 150 && i.rect[1] < 160
      )
      token.rect[0] = 750
      token.text = '1–2'
    }
    const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(t.grid[0]).toHaveLength(8)
    expect(t.repairs).not.toContain('repeated-ordinal-column-recovered')
  }
)

it.each(['note-label', 'missing-value', 'detached-line', 'missing-caption'])(
  'does not extend a crop into an unproven summary: %s',
  (variant) => {
    const x = fixture('clipped-summary-under-grouped-columns')
    if (variant === 'note-label')
      x.tokens.find((i: { text: string }) => i.text === 'Median (range)').text = 'NOTE.'
    if (variant === 'missing-value')
      x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '165 (112-289)')
    if (variant === 'missing-caption') x.captions = []
    if (variant === 'detached-line')
      for (const token of x.tokens.filter((i: { rect: number[] }) => i.rect[1] > 639)) {
        token.rect[1] += 20
        token.rect[3] += 20
        token.baseline += 20
      }
    const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(t.cropRect[3]).toBe(x.table.cropRect[3])
  }
)

it('does not merge a final statistic that is aligned to a leaf instead of its parent', () => {
  const x = fixture('clipped-summary-under-grouped-columns')
  const value = x.tokens.find((i: { text: string }) => i.text === '165 (112-289)')
  value.rect[0] -= 45
  value.rect[2] -= 45
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid.at(-1)[0]).toBe('Median (range)')
  expect(t.cells.filter((cell: { row: number }) => cell.row === t.grid.length - 1)).toHaveLength(5)
})
