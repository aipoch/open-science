import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { associateFigures, resolveFigureCaption, deduplicateFigureCaptions } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures', name + '.jsonl'))

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

function unresolvedTitleAboveOwnedPlate(): ReturnType<typeof JSON.parse> {
  const captions = [
    { page: 1, lines: ['Figure 1. Prior drawing.'], rect: [40, 40, 550, 60] },
    { page: 1, lines: ['Figure 2. Current drawing.'], rect: [40, 300, 550, 320] }
  ]
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    rotation: 0,
    invalidGraphicsBounds: 0,
    lines: captions.map((c) => ({
      text: c.lines[0],
      x: c.rect[0],
      y: c.rect[1],
      width: 510,
      height: 10,
      fontSize: 10
    })),
    graphicsBounds: [0, 1, 2].map((n) => ({
      kind: 'path',
      normalizedRect: [(60 + n) / 600, (150 + n) / 800, (540 - n) / 600, (280 - n) / 800]
    }))
  }
  return { page, captions }
}

it('does not lend a following captioned plate to an unresolved page-top title', () => {
  const f = unresolvedTitleAboveOwnedPlate(),
    before = structuredClone(f)
  const result = associateFigures(f.page, f.captions)
  expect(result).toHaveLength(2)
  expect(result[0].rect).toBeUndefined()
  expect(result[0].caption).toEqual(f.captions[0])
  expect(result[1].rect).toEqual([60, 150, 540, 280])
  expect(f).toEqual(before)
})

it('retains below-title recovery without a competing following caption', () => {
  const f = unresolvedTitleAboveOwnedPlate()
  f.captions = f.captions.slice(0, 1)
  f.page.lines = f.page.lines.slice(0, 1)
  expect(associateFigures(f.page, f.captions)[0].rect).toEqual([60, 150, 540, 280])
})
