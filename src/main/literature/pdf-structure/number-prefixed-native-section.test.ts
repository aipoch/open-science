import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledComparisonRecords } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/number-prefixed-outdented-section-after-measured-record.jsonl'
    )
  )

it('retains a number-prefixed native section independently of the measured record above it', () => {
  const x = fixture()
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  const row = r.grid.find((row: string[]) => row[0] === '7 Sections following entry')
  expect(row).toEqual(['7 Sections following entry', '', '', '', ''])
  expect(r.grid.find((row: string[]) => row[0] === 'Measurement C')).toBeDefined()
  expect(r.unassigned).toEqual([])
})

it.each(['indented heading', 'missing peers', 'crossing baseline', 'sparse next records'])(
  'does not infer a number-prefixed section with %s',
  (kind) => {
    const x = fixture()
    const heading = x.tokens.find((i: { text: string }) => i.text === '7 Sections following entry')
    if (kind === 'indented heading') {
      heading.rect[0] += 12
      heading.rect[2] += 12
    }
    if (kind === 'missing peers')
      x.tokens
        .filter((i: { text: string; rect: number[] }) => i.text === 'Section' && i.rect[1] < 950)
        .forEach((i: { rect: number[] }) => {
          i.rect[0] += 12
          i.rect[2] += 12
        })
    if (kind === 'crossing baseline') heading.rect[1] -= 5
    if (kind === 'sparse next records')
      x.tokens = x.tokens.filter(
        (i: { rect: number[] }) => !(i.rect[1] > 1025 && i.rect[0] > 300 && i.rect[0] < 600)
      )
    const r = recoverRuledComparisonRecords(x.table, x.tokens, x.captions, x.rules)
    expect(
      r?.spans.some(
        (s: { row: number; colSpan: number }) =>
          s.colSpan === 5 &&
          r.rows[s.row][1] <= heading.rect[1] &&
          r.rows[s.row][3] >= heading.rect[3]
      )
    ).not.toBe(true)
  }
)
