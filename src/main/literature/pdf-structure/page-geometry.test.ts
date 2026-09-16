import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { union } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-page-geometry.mjs')).href
)

it('unions dense vector plots without expanding rectangles into call arguments', () => {
  // Real vector scatter plots can contain over 158,000 painted marks on one page.
  const rects = Array.from({ length: 160_000 }, (_, index) => [index, -index, index + 2, 3])
  expect(union(rects)).toEqual([0, -159_999, 160_001, 3])
  expect(rects[0]).toEqual([0, -0, 2, 3])
})

it('preserves empty and non-finite rectangle union semantics', () => {
  expect(union([])).toEqual([Infinity, Infinity, -Infinity, -Infinity])
  expect(
    union([
      [1, 2, 3, 4],
      [-1, 5, 2, 8]
    ])
  ).toEqual([-1, 2, 3, 8])
  expect(union([[NaN, 0, Infinity, 1]])).toEqual([NaN, 0, Infinity, 1])
})
