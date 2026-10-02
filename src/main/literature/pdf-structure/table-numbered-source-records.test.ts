import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/numbered-case-records-with-variable-height-stubs.jsonl'
    )
  )
const { recoverIdentifierRecords } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
)
it('owns every consecutive native identifier and its variable-height description', () => {
  const f = load(),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid.filter((r: string[]) => /^\d+$/.test(r[0])).map((r: string[]) => r[0])).toEqual([
    '6',
    '7',
    '8',
    '9'
  ])
  expect(t.grid.find((r: string[]) => r[0] === '8')?.[1]).toBe('Type A with detail')
  expect(t.grid.find((r: string[]) => r[0] === '8')?.[4]).toBe('A multiline description')
  expect(t.unassigned).toEqual([])
})
it.each(['identifier gap', 'header', 'opening border'])(
  'declines numbered recovery without %s proof',
  (reason) => {
    const f = load()
    if (reason === 'identifier gap')
      f.tokens.find((i: { text: string }) => i.text === '8').text = '18'
    if (reason === 'header')
      f.tokens.find((i: { text: string }) => i.text === 'Record').text = 'Description'
    if (reason === 'opening border') f.rules = []
    expect(recoverIdentifierRecords(f.table, f.tokens, f.rules)).toBeUndefined()
  }
)
