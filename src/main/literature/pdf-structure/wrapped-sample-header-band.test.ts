import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverWrappedSampleHeaderBand } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/wrapped-sample-headings-inside-one-native-band.jsonl'
    )
  )

it('keeps wrapped sample qualifications in the same native header row as the outer headings', () => {
  const f = load()
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[0]).toEqual([
    'Measure',
    'Treatment group (n=44)',
    'Comparator group (n=44)',
    'P value'
  ])
  expect(r.grid).toHaveLength(6)
  expect(r.grid[2]).toEqual(['Duration, min', '104.0±22.8', '98.7±24.5', '0.294'])
  expect(
    r.cells
      .filter((c: { row: number }) => c.row === 0)
      .every((c: { rowSpan: number }) => c.rowSpan === 1)
  ).toBe(true)
  expect(r.unassigned).toEqual([])
})

it.each(['sample', 'leaf', 'underline', 'border', 'caption', 'ownership'])(
  'declines a single header band without complete %s proof',
  (kind) => {
    const f = load()
    if (kind === 'sample') f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '(n=44)')
    if (kind === 'leaf')
      f.tokens.find((i: { text: string }) => i.text === '(n=44)').text = 'Mean (SD)'
    if (kind === 'underline') f.rules.push([223.5, 111, 307.5, 111])
    if (kind === 'border') f.rules = f.rules.filter((r: number[]) => r[1] !== 96.75030000000015)
    if (kind === 'caption') f.captions = []
    if (kind === 'ownership') f.tokens.push({ ...f.tokens[0] })
    expect(recoverWrappedSampleHeaderBand(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)

it('recognizes the complete source header independently of the displaced model row', () => {
  const f = load()
  expect(recoverWrappedSampleHeaderBand(f.table, f.tokens, f.captions, f.rules)).toEqual([
    59, 96.75030000000015, 436, 129.22530000000006
  ])
})
