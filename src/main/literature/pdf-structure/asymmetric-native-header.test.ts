import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverAsymmetricSummaryHeaderGrid, recoverOverlappingLeafRecordGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/asymmetric-summaries-with-overlapping-leaf-underlines.jsonl'
    )
  )

it('uses the complete native leaf border and both asymmetric parent tiers', () => {
  const x = fixture()
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid[0]).toHaveLength(16)
  expect(r.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ row: 0, column: 1, colSpan: 9, text: 'Observed summaries' }),
      expect.objectContaining({ row: 0, column: 10, colSpan: 6 }),
      ...[1, 4, 7, 10, 13].map((column) => expect.objectContaining({ row: 1, column, colSpan: 3 }))
    ])
  )
  expect(r.unassigned).toEqual([])
})

it.each([2, 5, 16])('requires every native %i-stroke header band', (count) => {
  const x = fixture()
  const bands = Map.groupBy(x.rules, (r: number[]) => r[1])
  const band = [...bands.values()].find((b) => b.length === count)!
  x.rules.splice(x.rules.indexOf(band[0]), 1)
  expect(recoverAsymmetricSummaryHeaderGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})

it('rejects a competing opening rule', () => {
  const x = fixture()
  x.rules.push([50.6, 727, 829.2, 727])
  expect(recoverAsymmetricSummaryHeaderGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})

it('rejects source crossing a native header tier', () => {
  const x = fixture()
  x.tokens.push({
    text: 'Extra',
    horizontal: true,
    height: 9.564,
    baseline: 752,
    rect: [200, 744, 220, 753]
  })
  expect(recoverAsymmetricSummaryHeaderGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})

it('rejects a source value crossing a native leaf gutter', () => {
  const x = fixture()
  const value = x.tokens.find(
    (i: { text: string; rect: number[] }) => i.rect[1] > 800 && /^\d+$/.test(i.text)
  )
  value.rect[2] = 190
  expect(recoverAsymmetricSummaryHeaderGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})

it('requires repeated complete cohorts and a unique local caption', () => {
  const x = fixture()
  x.tokens.find((i: { text: string; rect: number[] }) => i.text === 'BBB').text = 'Other'
  expect(recoverAsymmetricSummaryHeaderGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
  const y = fixture()
  y.captions.push(structuredClone(y.captions[0]))
  expect(recoverAsymmetricSummaryHeaderGrid(y.table, y.tokens, y.captions, y.rules)).toBeUndefined()
})

it.each([
  ['paired-native-leaves-with-an-omitted-measured-record', 7],
  ['three-native-statistical-groups-with-model-spanned-records', 10]
])('retains every measured source record in %s', (name, columns) => {
  const x = readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/${name}.jsonl`))
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid[0]).toHaveLength(columns)
  expect(r.grid.slice(2).every((v: string[]) => v.some(Boolean))).toBe(true)
  expect(r.unassigned).toEqual([])
})

it.each([
  'missing-leaf',
  'missing-parent',
  'missing-footer',
  'competing-caption',
  'crossing-value'
])('requires complete native measured-record proof: %s', (mode) => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/three-native-statistical-groups-with-model-spanned-records.jsonl'
    )
  )
  const bands = Map.groupBy(x.rules, (r: number[]) => r[1])
  if (mode === 'missing-leaf' || mode === 'missing-parent') {
    const band = [...bands.values()].find((b) => b.length === (mode === 'missing-leaf' ? 10 : 3))!
    x.rules.splice(x.rules.indexOf(band[0]), 1)
  }
  if (mode === 'missing-footer') x.rules.pop()
  if (mode === 'competing-caption') x.captions.push(structuredClone(x.captions[0]))
  if (mode === 'crossing-value') {
    const token = x.tokens.find(
      (i: { text: string; rect: number[] }) => i.rect[1] > 530 && /^\d+$/.test(i.text)
    )
    token.rect[2] += 80
  }
  expect(recoverOverlappingLeafRecordGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})
