import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { findAlgorithmCandidates, associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const line = (text: string, x: number, y: number, width = 300): ReturnType<typeof JSON.parse> => ({
  text,
  x,
  y,
  width,
  height: 10,
  fontSize: 10
})
const graphic = (rect: number[]): ReturnType<typeof JSON.parse> => ({
  kind: 'path',
  normalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600))
})
const procedure = (title: string, input = true): ReturnType<typeof JSON.parse> => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  invalidGraphicsBounds: 0,
  lines: [
    line(title, 50, 102),
    ...(input ? [line('Require: source vector', 50, 122)] : []),
    line('1: function UPDATE (state)', 55, 140),
    line('2: for j = 1, ..., count do', 55, 160),
    line('3: state ← STEP(state)', 65, 180),
    line('4: return state', 55, 200)
  ],
  graphicsBounds: [
    [50, 100, 550, 101],
    [50, 115, 550, 116],
    [50, 220, 550, 221]
  ].map(graphic)
})
it.each([true, false])(
  'retains a formally numbered appendix algorithm, input anchor: %s',
  (input) => {
    expect(findAlgorithmCandidates(procedure('Algorithm B.2 Framed update', input))).toHaveLength(1)
  }
)
it('requires frame and pseudocode evidence for an appendix title', () => {
  const sample = procedure('Algorithm B.2 is used in the following analysis')
  sample.lines = [
    sample.lines[0],
    line('The following ordinary paragraph describes the method.', 50, 140)
  ]
  expect(findAlgorithmCandidates(sample)).toEqual([])
})
it('retains a formally captioned rounded text illustration', () => {
  const caption = { page: 1, lines: ['Figure 4. Illustrated message.'], rect: [50, 180, 550, 190] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      ...Array.from({ length: 9 }, (_, i) => ({
        ...line(`${i}: ${'Synthetic source text '.repeat(6)}`, 120, 90 + i * 7, 355),
        height: 5,
        fontSize: 5
      })),
      line(caption.lines[0], 50, 180)
    ],
    graphicsBounds: [graphic([100, 65, 500, 175]), graphic([100, 90, 498, 172])]
  }
  const match = associateFigures(page, [caption])[0]
  expect(match.rect).toBeDefined()
  expect(match.rect[0]).toBeLessThanOrEqual(100)
  expect(match.rect[1]).toBeLessThanOrEqual(65)
  expect(match.rect[3]).toBeGreaterThanOrEqual(175)
})
