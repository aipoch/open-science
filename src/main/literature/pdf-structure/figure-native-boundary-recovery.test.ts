import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { associateFigures, resolveFigureCaption, deduplicateFigureCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('src/main/literature/pdf-structure/fixtures', name + '.jsonl'))

it('retains both outer branches beside a centered flowchart caption', () => {
  const x = load('centered-flowchart-caption-with-wide-branches')
  const [figure] = associateFigures(x.page, x.captions)
  expect(figure.rect[0]).toBeCloseTo(134.57178125)
  expect(figure.rect[2]).toBeCloseTo(457.080015625)
  expect(figure.rect[3]).toBeLessThan(x.captions[0].rect[1])
})

it('keeps outlined category labels and legend rows connected below vector bars', () => {
  const x = load('outlined-category-labels-below-vector-bars')
  const [figure] = associateFigures(x.page, x.captions)
  expect(figure.rect[3]).toBeCloseTo(694.2883671875)
  expect(figure.rect[3]).toBeLessThan(x.captions[0].rect[1])
})

it('keeps paragraph headings outside a framed diagram with a side caption', () => {
  const x = load('framed-diagram-before-paragraph-headings')
  const [figure] = associateFigures(x.page, x.captions)
  expect(figure.rect[2]).toBeCloseTo(336.61409375)
  expect(figure.rect[3]).toBeCloseTo(313.13984765625)
})

it('excludes a footer mark separated from a side-captioned plate by native prose', () => {
  const x = load('side-captioned-raster-with-detached-footer')
  const [figure] = associateFigures(x.page, x.captions)
  expect(figure.rect).toEqual([183.698453125, 55.607765625, 548.7700625, 503.5592109375])
  x.page.lines = x.page.lines.filter((l: { y: number }) => l.y < 510)
  expect(associateFigures(x.page, x.captions)[0].reason).toBe('ambiguous-graphic-direction')
})

it('links a complete ordered legend list to its following numbered plates', () => {
  const { captions } = load('numbered-plates-following-a-legend-list')
  const plates = captions.filter((c: { page: number }) => c.page > 1)
  for (const plate of plates) {
    const resolved = resolveFigureCaption(plate, captions)
    expect(resolved.page).toBe(1)
    expect(resolved.lines.join(' ').length).toBeGreaterThan(25)
  }
  expect(
    resolveFigureCaption(
      plates[0],
      captions.filter((c: object) => c !== plates[1])
    )
  ).toBe(plates[0])
})

it('removes an overlapping unresolved duplicate of a resolved caption layer', () => {
  const { figures } = load('overlapping-duplicate-caption-layers')
  expect(deduplicateFigureCaptions(figures)).toEqual([figures[0]])
  figures[1].caption.rect = figures[1].caption.rect.map((v: number) => v + 100)
  expect(deduplicateFigureCaptions(figures)).toHaveLength(2)
})

it.each([
  'paragraph-ending-in-figure-and-table-references',
  'paragraph-ending-in-directional-figure-reference'
])('does not crop a paragraph-ending reference: %s', (name) => {
  const { page } = load(name)
  expect(findCaptionCandidates([page])).toEqual([])
})
