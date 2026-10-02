import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { findAlgorithmCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const input = (): ReturnType<typeof JSON.parse> => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  lines: [
    ['Algorithm 1 Native block de-', 50, 10],
    ['scription', 62, 10],
    ['Require: Native input', 80, 8],
    ['Ensure: Native output', 94, 8],
    ['1: First step', 110, 8],
    ['2: Second step', 124, 8]
  ].map(([text, y, fontSize]) => ({ text, x: 50, y, width: 220, height: fontSize, fontSize })),
  graphicsBounds: [48, 150].map((y) => ({
    kind: 'path',
    normalizedRect: [48 / 600, y / 800, 275 / 600, (y + 1) / 800]
  }))
})
it('preserves a wrapped literal numbered algorithm title inside its native rules', () => {
  const f = findAlgorithmCandidates(input())
  expect(f).toHaveLength(1)
  expect(f[0].caption.lines).toEqual(['Algorithm 1 Native block de-', 'scription'])
  expect(f[0].rect[1]).toBeLessThanOrEqual(48)
  expect(f[0].rect[3]).toBeGreaterThanOrEqual(151)
})
it.each(['missing-opening', 'missing-closing', 'unnumbered', 'missing-steps'])(
  'does not invent an algorithm without %s proof',
  (reason) => {
    const p = input()
    if (reason === 'missing-opening') p.graphicsBounds.shift()
    if (reason === 'missing-closing') p.graphicsBounds.pop()
    if (reason === 'unnumbered') p.lines[0].text = 'Native block'
    if (reason === 'missing-steps')
      p.lines = p.lines.filter((l: ReturnType<typeof JSON.parse>) => !/^\d+:/.test(l.text))
    expect(findAlgorithmCandidates(p)).toEqual([])
  }
)
it('does not include a different-font or indented body line in a wrapped title', () => {
  const p = input()
  p.lines[1].fontSize = 8
  expect(findAlgorithmCandidates(p)[0].caption.lines).toHaveLength(1)
  p.lines[1].fontSize = 10
  p.lines[1].x = 60
  expect(findAlgorithmCandidates(p)[0].caption.lines).toHaveLength(1)
})
