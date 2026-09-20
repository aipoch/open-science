import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)

it.each([
  ['flowchart-below-raster-with-short-caption', 1, [83, 370, 518, 716]],
  ['raster-flowchart-with-outlined-page-number', 0, [128, 81, 476, 697]],
  ['column-flowchart-above-comment-heading', 0, [319, 47, 536, 292]],
  ['chart-side-caption', 0, [45, 46, 371, 207]],
  ['survival-panels-with-unheaded-risk-rows', 0, [83, 58, 516, 585]],
  ['dense-category-panels-with-outdented-letters', 0, [140, 48, 457, 680]]
])('preserves the full figure in %s', (name, index, extent) => {
  const { page } = readPdfFixture(
    resolve(`src/main/literature/pdf-structure/fixtures/${name}.jsonl`)
  )
  const figures = associateFigures(page, findCaptionCandidates([page]))
  const figure = figures[index as number]
  expect(figure?.rect).toBeDefined()
  const rect = figure.rect as number[]
  const expected = extent as number[]
  expect(rect[0]).toBeLessThanOrEqual(expected[0] + 2)
  expect(rect[1]).toBeLessThanOrEqual(expected[1] + 2)
  expect(rect[2]).toBeGreaterThanOrEqual(expected[2] - 2)
  expect(rect[3]).toBeGreaterThanOrEqual(expected[3] - 2)
  expect(rect[3]).toBeLessThan(expected[3] + 12)
})

it('keeps a rounded flowchart frame above its caption but excludes a frame spanning the legend', () => {
  const { page } = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/column-flowchart-above-comment-heading.jsonl'
    )
  )
  const captions = findCaptionCandidates([page])
  const figure = associateFigures(page, captions)[0]
  expect(figure.rect[3]).toBeLessThanOrEqual(figure.caption.rect[1] - 2)
  const frame = page.graphicsBounds.find(
    (g: { normalizedRect: number[] }) =>
      g.normalizedRect[2] - g.normalizedRect[0] > 0.35 &&
      g.normalizedRect[3] - g.normalizedRect[1] > 0.3
  )
  frame.normalizedRect[3] += 0.03
  const overlapping = associateFigures(page, captions)[0]
  expect(overlapping.rect[0]).toBeGreaterThan(figure.rect[0] + 5)
  expect(overlapping.rect[3]).toBeLessThan(figure.caption.rect[1])
})

it('keeps another figure on a page with a captioned vector flowchart', () => {
  const { page } = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/column-flowchart-above-comment-heading.jsonl'
    )
  )
  // Use the empty peer column for a second figure with its own caption.
  page.lines = page.lines.filter((line: { x: number }) => line.x > page.width / 2)
  page.graphicsBounds = page.graphicsBounds.filter(
    (graphic: { normalizedRect: number[] }) => graphic.normalizedRect[0] > 0.5
  )
  const captions = findCaptionCandidates([page])
  const second = {
    page: page.pageNumber,
    lines: ['Figure 2. Study results.'],
    rect: [50, 260, 270, 272]
  }
  page.graphicsBounds.push({
    kind: 'image',
    normalizedRect: [50 / 612, 60 / 792, 270 / 612, 240 / 792]
  })
  const figures = associateFigures(page, [...captions, second])
  expect(figures).toHaveLength(2)
  expect(figures.map((figure: { caption: unknown }) => figure.caption)).toEqual([
    ...captions,
    second
  ])
  expect(figures[1].rect).toBeDefined()
  expect(figures[1].rect[0]).toBeLessThanOrEqual(50)
  expect(figures[1].rect[2]).toBeGreaterThanOrEqual(270)
})
