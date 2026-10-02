import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverSegmentedClinicalRecordGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const cases = [
  'segmented-category-table-with-missing-terminal-record',
  'segmented-category-continuation-with-body-in-header',
  'striped-paired-counts-with-section-in-header',
  'striped-paired-count-continuation-with-repeated-heading'
]
it.each(cases)('retains complete native records in %s', (name) => {
  const x = readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/${name}.jsonl`))
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.unassigned).toEqual([])
  expect(r.grid[0].some((v: string) => /\d+\s*\(/.test(v))).toBe(false)
  expect(r.grid.slice(1).every((v: string[]) => v.some(Boolean))).toBe(true)
  if (name.startsWith('striped'))
    expect(
      r.cells.some(
        (c: { text: string; row: number; colSpan: number }) =>
          c.text === 'Section' && c.row > 0 && c.colSpan === 2
      )
    ).toBe(true)
})

it.each([
  'missing-divider',
  'missing-terminal',
  'competing-caption',
  'crossing-ink',
  'foreign-strip',
  'incomplete-record'
])('declines incomplete segmented category proof: %s', (mode) => {
  const x = readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/${cases[0]}.jsonl`))
  if (mode === 'missing-divider')
    x.rules.splice(
      x.rules.findIndex((r: number[]) => r[0] > 390 && r[1] > 150),
      1
    )
  if (mode === 'missing-terminal') x.rules = x.rules.filter((r: number[]) => r[0] !== r[2])
  if (mode === 'competing-caption') x.captions.push(structuredClone(x.captions[0]))
  if (mode === 'crossing-ink')
    x.tokens.push({
      text: 'Extra',
      horizontal: true,
      height: 10,
      baseline: 1020,
      rect: [245, 1010, 270, 1020]
    })
  if (mode === 'foreign-strip')
    x.tokens.push({
      text: 'Extra',
      horizontal: true,
      height: 10,
      baseline: 1020,
      rect: [830, 1010, 850, 1020]
    })
  if (mode === 'incomplete-record')
    x.tokens.splice(
      x.tokens.findIndex((i: { rect: number[] }) => i.rect[1] > 980 && i.rect[0] > 390),
      1
    )
  expect(recoverSegmentedClinicalRecordGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})

it('does not infer shared paired statistics with an extra second-record value', () => {
  const x = readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/${cases[2]}.jsonl`))
  x.tokens.push({
    text: '1.1',
    horizontal: true,
    height: 10.4607,
    baseline: 221.9,
    rect: [480, 211.44, 495, 221.9]
  })
  expect(recoverSegmentedClinicalRecordGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})
