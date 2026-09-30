import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/vector-plots-above-shaded-prose.jsonl'
    )
  )
it('recovers vector panels above a caption without attaching a shaded prose column', () => {
  const { page } = fixture()
  const figures = associateFigures(page, findCaptionCandidates([page]))
  expect(figures).toHaveLength(1)
  expect(figures[0].rect).toBeDefined()
  expect(figures[0].rect[1]).toBeLessThan(130)
  expect(figures[0].rect[3]).toBeLessThan(370)
  expect(figures[0].rect[2]).toBeGreaterThan(470)
})
it('retains ambiguity when the lower region contains drawing evidence', () => {
  const { page } = fixture()
  page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.6, 0.53, 0.8, 0.61] })
  const figures = associateFigures(page, findCaptionCandidates([page]))
  expect(figures[0].rect).toBeUndefined()
})
