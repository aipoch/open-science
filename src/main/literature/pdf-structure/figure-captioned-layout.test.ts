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
