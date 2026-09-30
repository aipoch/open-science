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
it('recovers slash-count records, wrapped stubs and raised parenthesized note labels', () => {
  const f = fixture('paired-ratio-cohorts-with-raised-note-labels'),
    original = structuredClone(f)
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.unassigned).toEqual([])
  expect(t.grid.some((r: string[]) => r[1] === '19/7' && r[2] === '8/5')).toBe(true)
  expect(t.grid.some((r: string[]) => r[0].includes('(yes/no)') && r[1] === '7/19')).toBe(true)
  expect(t.issues).toEqual([])
  expect(t.grid.some((r: string[]) => r[0] === 'Subtype' && r[1] === '1')).toBe(true)
  expect(t.cells.find((c: { text: string }) => c.text === 'Size of lesionc)')?.colSpan).toBe(3)
  expect(f).toEqual(original)
})
it('preserves centered section bands and separate labelled cohort records', () => {
  const f = fixture('centered-sections-between-complete-cohort-records')
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.unassigned).toEqual([])
  expect(
    t.cells
      .filter((c: { text: string }) => /Data$/.test(c.text))
      .every((c: { colSpan: number }) => c.colSpan === 4)
  ).toBe(true)
  const a = t.grid.find((r: string[]) => r[0] === 'Index A, mean ± SD')
  const b = t.grid.find((r: string[]) => r[0] === 'Index B, mean ± SD')
  expect(a?.[1]).toBe('−1.1 ± 1.8')
  expect(b?.[1]).toBe('47.9 ± 16.6')
})
it.each([true, false])(
  'changes paired column roles only with an explicit percentage header (%s)',
  (percentage) => {
    const f = fixture('paired-summary-columns-changing-to-percent')
    if (!percentage) for (const i of f.tokens) if (i.text === '%') i.text = 'SD'
    const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
    const value = t.cells.find((c: { text: string }) => c.text === '54')
    expect(value?.colSpan).toBe(percentage ? 2 : 1)
    expect(t.cells.find((c: { text: string }) => c.text === '11.1')?.colSpan).toBe(1)
    expect(t.unassigned).toEqual([])
  }
)
