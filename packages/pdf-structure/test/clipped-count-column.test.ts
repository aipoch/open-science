import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
it('keeps count fragments beyond a clipped detector edge when native header strokes and repeated records agree', () => {
  const x = readPdfFixture(
    resolve('test/fixtures/source-grids/clipped-count-column-below-native-header-rule.jsonl')
  )
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.cropRect[2]).toBeGreaterThan(490)
  expect(t.clipped).toEqual([])
})
