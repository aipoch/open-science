import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeHeaderGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )

it('keeps native test and probability columns independent with clipped probabilities and shared section tests', () => {
  const f = load('independent-test-columns-beside-underlined-count-leaves')
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.unassigned).toEqual([])
  expect(r.grid[0]).toEqual([
    'Characteristics',
    'Treatment group (n = 210)',
    '',
    'Comparator group (n = 155)',
    '',
    'χ2',
    'P'
  ])
  expect(r.grid[3]).toEqual(['< 40', '90', '42.9', '53', '34.2', '2.809', '0.094'])
  expect(r.grid[6].slice(-2)).toEqual(['0.222', '0.638'])
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 3, column: 6, rowSpan: 2, text: '0.094' })
  )
})

it('widens clipped probabilities only inside their native closing border', () => {
  const f = load('clipped-probabilities-inside-native-count-footer')
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.cropRect[2]).toBeGreaterThanOrEqual(454.0962)
  expect(r.grid).toHaveLength(19)
  expect(r.clipped).toEqual([])
  expect(r.issues).toEqual([])
  f.rules = f.rules.filter((r: number[]) => r[1] < 1000)
  const missing = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(missing.cropRect).toEqual(f.table.cropRect)
  expect(missing.clipped.length).toBeGreaterThan(0)
})

it('preserves two repeated sample-qualified summary headers and their independent spanning stubs', () => {
  const f = load('repeated-sample-qualified-summary-header-bands')
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(16)
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 0, rowSpan: 2, text: 'Low scale' })
  )
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 8, column: 0, rowSpan: 2, text: 'High scale' })
  )
  for (const row of [0, 8])
    for (const column of [3, 4])
      expect(r.cells).toContainEqual(expect.objectContaining({ row, column, rowSpan: 2 }))
  expect(r.grid[2]).toEqual(['Pre-test', '3.70 ± 3.36', '4.58 ± 3.61', '2.100', '0.037'])
  expect(r.grid[15]).toEqual(['P', '0.263', '0.001', '', ''])
  expect(r.unassigned).toEqual([])
  expect(r.issues).toEqual([])
})

it.each(['sample', 'underline', 'leaf', 'body'])(
  'declines repeated summary bands without complete %s proof',
  (kind) => {
    const f = load('repeated-sample-qualified-summary-header-bands')
    if (kind === 'sample')
      f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '(n = 173)')
    if (kind === 'underline') f.rules = f.rules.filter((r: number[]) => r[1] < 900)
    if (kind === 'leaf')
      f.tokens = f.tokens.filter(
        (i: { text: string; rect: number[] }) => !(i.text === 'Mean ± SD' && i.rect[1] > 900)
      )
    if (kind === 'body') f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '3.70')
    expect(recoverNativeHeaderGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)

it('restores clipped cohort prefixes and owns a single probability over each count pair', () => {
  const f = load('clipped-cohort-prefixes-above-native-count-leaves')
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.unassigned).toEqual([])
  expect(r.grid[0]).toEqual([
    'Screening screening behaviors',
    'Treatment group (n = 37)',
    '',
    'Comparator group (n = 43)',
    '',
    'P'
  ])
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 3, column: 5, rowSpan: 2, text: '0.901' })
  )
  f.rules.pop()
  expect(recoverNativeHeaderGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})
