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
      'src/main/literature/pdf-structure/fixtures/source-grids/wrapped-compound-stub-below-count-baseline.jsonl'
    )
  )
it('owns a capitalized continuation of a slash compound on its count baseline', () => {
  const f = load(),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(
    t.grid.some((r: string[]) => r[0] === 'North/Coastal Region' && r.slice(1).every(Boolean))
  ).toBe(true)
  expect(t.grid.some((r: string[]) => r[0] === 'Region')).toBe(false)
})
it.each(['indent', 'compound'])(
  'keeps an independent capitalized line without %s proof',
  (reason) => {
    const f = load()
    if (reason === 'indent')
      for (const i of f.tokens.filter((i: { text: string }) => i.text === 'Region')) {
        i.rect[0] += 8
        i.rect[2] += 8
      }
    if (reason === 'compound')
      f.tokens.find((i: { text: string }) => i.text === 'North/Coastal').text = 'North Coastal'
    const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
    expect(
      t.grid.some(
        (r: string[]) => r[0] === 'North/Coastal Region' || r[0] === 'North Coastal Region'
      )
    ).toBe(false)
  }
)
