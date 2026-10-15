import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { findAlgorithmCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)

const fixture = (): {
  pageNumber: number
  width: number
  height: number
  lines: { text: string; x: number; y: number; width: number; height: number; fontSize: number }[]
  graphicsBounds: { kind: string; normalizedRect: number[] }[]
} => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  lines: [
    ['Algorithm 2 Training', 50, 100, 200],
    ['Input: samples', 60, 120, 100],
    ['while not converged do', 60, 140, 150],
    ['for each batch do', 70, 160, 120],
    ['Sample values', 80, 180, 100],
    ['for each instance', 240, 180, 100],
    ['Update parameters', 80, 200, 110],
    ['end for', 70, 220, 40],
    ['end while', 60, 240, 50]
  ].map(([text, x, y, width]) => ({
    text: String(text),
    x: Number(x),
    y: Number(y),
    width: Number(width),
    height: 10,
    fontSize: 10
  })),
  graphicsBounds: [98, 115, 260].map((y) => ({
    kind: 'path',
    normalizedRect: [50 / 600, y / 800, 450 / 600, (y + 1) / 800]
  }))
})

it('does not mistake a split inline quantifier for a separately indented loop', () => {
  const result = findAlgorithmCandidates(fixture())
  expect(result).toHaveLength(1)
  expect(result[0].rect).toEqual([48, 96, 452, 263])
})

it('still rejects an unclosed control on its own baseline', () => {
  const page = fixture()
  page.lines.find((line) => line.text === 'for each instance')!.y = 195
  expect(findAlgorithmCandidates(page)).toEqual([])
})
