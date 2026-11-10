import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { deduplicateTableDetections, intersectionOverUnion } = await import(
  pathToFileURL(resolve('resources/literature-pdf-onnx-postprocess.mjs')).href
)

const table = (
  rect: number[],
  score: number,
  label = 'table'
): { label: string; score: number; rect: number[] } => ({ label, score, rect })

it('calculates overlap for identical and disjoint boxes', () => {
  expect(intersectionOverUnion([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1)
  expect(intersectionOverUnion([0, 0, 10, 10], [20, 0, 30, 10])).toBe(0)
})

it('keeps the highest-scoring near-duplicate table detection', () => {
  const duplicate = table([1, 1, 101, 101], 0.54)
  const winner = table([0, 0, 100, 100], 0.91)
  expect(deduplicateTableDetections([duplicate, winner])).toEqual([winner])
})

it('keeps adjacent tables and non-table labels', () => {
  const first = table([0, 0, 100, 100], 0.91)
  const second = table([90, 0, 190, 100], 0.9)
  const rotated = table([0, 0, 100, 100], 0.95, 'table rotated')
  expect(deduplicateTableDetections([first, second, rotated])).toEqual([first, second, rotated])
})
