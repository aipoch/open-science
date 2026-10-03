import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { nativeProseInkTopLimit } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-crop-geometry.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> => ({
  figure: {
    rect: [10, 100, 200, 250],
    excludedProseLines: [{ x: 20, y: 86, width: 140, height: 10 }]
  },
  tokens: [
    {
      text: 'A preceding body line.',
      horizontal: true,
      rect: [20, 86, 160, 96],
      baseline: 96,
      height: 10,
      fontDescent: -0.3
    }
  ]
})
it('keeps final render padding clear of source-owned body descenders', () => {
  const x = fixture(),
    before = JSON.stringify(x)
  const top = Math.max(x.figure.rect[1] - 2, nativeProseInkTopLimit(x.figure, x.tokens))
  expect(top).toBe(99.5)
  expect(top).toBeLessThan(x.figure.rect[1])
  expect(JSON.stringify(x)).toBe(before)
})
it.each([
  'no prose proof',
  'unknown font',
  'invalid font',
  'different owner',
  'ink overlaps plate'
])('keeps established crop when padding has no independent ink boundary: %s', (variant) => {
  const x = fixture()
  if (variant === 'no prose proof') x.figure.excludedProseLines = []
  if (variant === 'unknown font') delete x.tokens[0].fontDescent
  if (variant === 'invalid font') x.tokens[0].fontDescent = -Infinity
  if (variant === 'different owner') x.figure.excludedProseLines[0].x += 300
  if (variant === 'ink overlaps plate') x.tokens[0].fontDescent = -0.6
  expect(nativeProseInkTopLimit(x.figure, x.tokens)).toBe(0)
})
