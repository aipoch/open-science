import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { recoverSampleQualifiedHeaderCuts } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-source-records.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/sample-closing-parenthesis-crossing-predicted-probability-cut.jsonl'
    )
  )
const cuts = [53, 465.3784286826849, 605.331195935607, 769.2281675338745, 855]

it('owns the closing sample qualifier without moving any body text to another leaf column', () => {
  const f = load()
  const next = recoverSampleQualifiedHeaderCuts(f.tokens, cuts, 127, 168.54916076362133)
  expect(next?.[3]).toBeGreaterThan(771.4612149)
  expect(next?.slice(0, 3)).toEqual(cuts.slice(0, 3))
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[0][2]).toBe('Comparator (n = 138a) %')
  expect(r.grid[0][3]).toBe('p')
})

it('rejects a cut change that would transfer even one body glyph to the other column', () => {
  const f = load()
  f.tokens.push({
    text: '0.1',
    horizontal: true,
    height: 12,
    baseline: 190,
    rect: [775, 178, 785, 190]
  })
  expect(recoverSampleQualifiedHeaderCuts(f.tokens, cuts, 127, 168.54916076362133)).toBeUndefined()
})
