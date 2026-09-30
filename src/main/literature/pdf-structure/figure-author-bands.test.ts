import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const fixture = (n: number): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/author-bands-adjoining-figure-panels.jsonl'
    )
  ).cases[n]
it.each([
  [0, 40],
  [1, 100],
  [2, 55]
])('excludes the author band while preserving the adjacent figure %s', (n, minTop) => {
  const x = fixture(n),
    r = associateFigures(x.page, x.captions)
  expect(r).toHaveLength(1)
  expect(r[0].rect[1]).toBeGreaterThan(minTop)
  expect(r[0].rect[3]).toBeGreaterThan(x.captions[0].rect[1] - 20)
})
it('retains a shallow chart title when there is no native author-header evidence', () => {
  const x = fixture(1)
  for (const l of x.page.lines)
    if (/et al/i.test(l.text)) l.text = 'Study outcomes and subgroup comparisons'
  const [r] = associateFigures(x.page, x.captions)
  expect(r.rect[1]).toBeLessThan(90)
})
