import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { findAlgorithmCandidates, associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const line = (
  text: string,
  x: number,
  y: number,
  width = 160
): { text: string; x: number; y: number; width: number; height: number; fontSize: number } => ({
  text,
  x,
  y,
  width,
  height: 10,
  fontSize: 10
})
const sample = {
  pageNumber: 1,
  width: 600,
  height: 800,
  invalidGraphicsBounds: 0,
  lines: [
    line('Algorithm 1 Search', 50, 202),
    line('Require: query', 50, 220),
    line('1: Initialize', 55, 240),
    line('2: return result', 55, 260),
    line('Algorithm 2 Search', 320, 222),
    line('Require: documents', 320, 240),
    line('1: Initialize', 325, 260),
    line('2: return result', 325, 280)
  ],
  graphicsBounds: [
    [50, 200, 300, 204],
    [50, 215, 300, 219],
    [50, 280, 300, 284],
    [320, 220, 570, 224],
    [320, 235, 570, 239],
    [320, 300, 570, 304]
  ].map((r) => ({ kind: 'path', normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 600)) }))
}

it('keeps two-column algorithms separate and includes the title and closing rule', () => {
  const algorithms = findAlgorithmCandidates(sample)
  expect(
    algorithms.map((a: { caption: { lines: string[] }; rect: number[] }) => [
      a.caption.lines[0],
      a.rect.map(Math.round)
    ])
  ).toEqual([
    ['Algorithm 1 Search', [48, 198, 302, 286]],
    ['Algorithm 2 Search', [318, 218, 572, 306]]
  ])
})

it.each(['title', 'pseudocode', 'closing-rule'])(
  'requires %s evidence before classifying an algorithm',
  (missing) => {
    const page = structuredClone(sample)
    if (missing === 'title') page.lines = page.lines.filter((l) => !l.text.startsWith('Algorithm'))
    if (missing === 'pseudocode')
      page.lines = page.lines.filter((l) => !l.text.startsWith('Require'))
    if (missing === 'closing-rule')
      page.graphicsBounds = page.graphicsBounds.filter((_, i) => i !== 2 && i !== 5)
    expect(findAlgorithmCandidates(page)).toEqual([])
  }
)

it('keeps algorithm rules out of the preceding figure association', () => {
  const page = {
    ...sample,
    graphicsBounds: [
      ...sample.graphicsBounds,
      { kind: 'image', normalizedRect: [50 / 600, 60 / 800, 300 / 600, 140 / 800] }
    ]
  }
  const exclusions = findAlgorithmCandidates(page).map((a: { rect: number[] }) => a.rect)
  const [figure] = associateFigures(
    page,
    [{ page: 1, lines: ['Fig. 1. Flow'], rect: [50, 150, 300, 170] }],
    exclusions
  )
  expect(figure.rect.map(Math.round)).toEqual([50, 60, 300, 140])
})
