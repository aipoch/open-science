import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { recoverRuledColumnGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-column-grid.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/two-tier-header-font-box-grazing-native-opening.jsonl'
    )
  )

it('preserves an owned upper header font box grazing the native opening', () => {
  const x = fixture()
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.clipped).toEqual([])
  expect(r.grid[0][1]).toBe('Summary')
  expect(r.grid).toHaveLength(10)
  expect(r.unassigned).toEqual([])
  const native = recoverRuledColumnGrid(x.table, x.tokens, x.captions, x.rules)
  const header = x.tokens.find((i: { text: string }) => i.text === 'Summary')
  expect(native.cropRect[1]).toBeLessThanOrEqual(header.rect[1])
  expect(native.rows[0][1]).toBeCloseTo(5.2391165771485)
})

it.each([
  'large overhang',
  'above-line baseline',
  'foreign ink',
  'vertical foreign ink',
  'competing opening',
  'crossing caption',
  'outside parent'
])('keeps the native crop when %s cannot prove header-only padding', (kind) => {
  const x = fixture()
  const header = x.tokens.find((i: { text: string }) => i.text === 'Summary')
  if (kind === 'large overhang') header.rect[1] -= header.height
  if (kind === 'above-line baseline') header.baseline = 5
  if (kind === 'crossing caption')
    x.captions.push({
      lines: ['Table 2. External description'],
      rect: [...header.rect]
    })
  if (kind === 'outside parent') {
    header.rect[0] = 20
    header.rect[2] = 50
  }
  if (kind.includes('foreign ink'))
    x.tokens.push({
      text: 'External',
      horizontal: kind !== 'vertical foreign ink',
      height: 0.015,
      baseline: 5.21,
      rect: [100, 5.2, 130, 5.215]
    })
  if (kind === 'competing opening') {
    const opening = x.rules.find((r: number[]) => r[1] > 5 && r[1] < 6)
    x.rules.push([opening[0], opening[1] - 0.009, opening[2], opening[3] - 0.009])
  }
  const r = recoverRuledColumnGrid(x.table, x.tokens, x.captions, x.rules)
  expect(r.cropRect[1]).toBeGreaterThan(header.rect[1])
})
