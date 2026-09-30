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
it('recognizes a Legend to Figure caption and associates the source image', () => {
  const f = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/figure-caption-prefixed-by-legend-to.jsonl')
  )
  const captions = findCaptionCandidates([f.page])
  expect(captions).toHaveLength(1)
  expect(captions[0].lines[0]).toMatch(/^Legend to Figure 1/)
  expect(associateFigures(f.page, captions)[0].rect).toBeDefined()
})
it.each([
  ['stacked-raster-figures-with-crossing-outlined-labels', [55, 48, 542, 296]],
  ['multi-panel-figure-with-repeated-axis-phrases', [60, 49, 534, 648]],
  ['shaded-chart-column-with-integral-legend', [306, 27, 549, 528]],
  ['framed-flowchart-with-fused-node-label-lines', [81, 198, 531, 622]]
])(
  'retains the complete source figure and excludes neighbouring content in %s',
  (name, expected) => {
    const f = readPdfFixture(
        resolve('src/main/literature/pdf-structure/fixtures', name + '.jsonl')
      ),
      original = structuredClone(f)
    const g = associateFigures(f.page, f.captions)[0]
    expect(g.rect).toBeDefined()
    g.rect.forEach((v: number, n: number) => expect(Math.abs(v - expected[n])).toBeLessThan(2))
    expect(f).toEqual(original)
  }
)
