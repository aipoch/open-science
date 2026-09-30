import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/outlined-flowchart-with-inset-caption.jsonl'
    )
  )
it('retains all outlined flowchart nodes inside a frame with an inset bottom caption', () => {
  const { page } = fixture()
  const captions = findCaptionCandidates([page])
  const f = associateFigures(page, captions)[0]
  expect(f.rect).toBeDefined()
  expect(f.rect[1]).toBeLessThan(370)
  expect(f.rect[3]).toBeGreaterThan(730)
  expect(f.rect[0]).toBeLessThan(64)
  expect(f.rect[2]).toBeGreaterThan(530)
})
it.each(['missing-side', 'no-interior', 'occupied-table'])(
  'declines incomplete frame evidence: %s',
  (variant) => {
    const { page } = fixture()
    const captions = findCaptionCandidates([page])
    if (variant === 'missing-side')
      page.graphicsBounds = page.graphicsBounds.filter(
        (g: { normalizedRect: number[] }) =>
          !(g.normalizedRect[0] > 0.89 && g.normalizedRect[3] - g.normalizedRect[1] > 0.4)
      )
    if (variant === 'no-interior')
      page.graphicsBounds = page.graphicsBounds.filter(
        (g: { normalizedRect: number[] }) =>
          g.normalizedRect[2] - g.normalizedRect[0] > 0.75 ||
          g.normalizedRect[3] - g.normalizedRect[1] > 0.4
      )
    const f = associateFigures(
      page,
      captions,
      variant === 'occupied-table' ? [[100, 400, 500, 700]] : []
    )[0]
    expect(f.rect).toBeUndefined()
  }
)
