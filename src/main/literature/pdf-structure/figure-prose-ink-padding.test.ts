import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { nativeProseInkTopLimit, nativeOwnedFigureInkBottom } = await import(
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

const ownedLabel = (): ReturnType<typeof JSON.parse> => ({
  figure: { rect: [40, 200, 530, 391.16] },
  tokens: [
    {
      text: 'g(q)',
      horizontal: true,
      rect: [407, 380.65, 443, 391.16],
      baseline: 391.16,
      height: 10.51,
      fontDescent: -0.215
    }
  ]
})

it('includes font descenders of a wholly owned native axis label without interpreting its text', () => {
  const x = ownedLabel()
  const before = JSON.stringify(x)
  const bottom = nativeOwnedFigureInkBottom(x.figure, x.tokens)
  expect(bottom).toBeCloseTo(393.91965)
  expect(bottom).toBeGreaterThan(x.figure.rect[3] + 2 / 1.5)
  x.tokens[0].text = '¸=¹'
  expect(nativeOwnedFigureInkBottom(x.figure, x.tokens)).toBe(bottom)
  x.tokens[0].text = 'g(q)'
  expect(JSON.stringify(x)).toBe(before)
})

it('retains a native subcaption at the same edge after viewport scaling roundoff', () => {
  const x = ownedLabel()
  x.figure.rect[3] = 404.756
  x.tokens[0] = {
    text: '(b) Native panel label.',
    horizontal: true,
    rect: [131.798, 396.7859, 221.454, 404.75600000000003],
    baseline: 404.75600000000003,
    height: 7.9701,
    fontDescent: -0.216
  }
  expect(nativeOwnedFigureInkBottom(x.figure, x.tokens)).toBeCloseTo(406.9775416)
})

it.each([
  'unknown font',
  'invalid font',
  'positive descent',
  'rotated text',
  'crosses left edge',
  'crosses top edge',
  'crosses bottom edge',
  'crosses bottom beyond roundoff',
  'different baseline',
  'excluded prose',
  'foreign text in extension'
])('keeps the plate boundary without complete native label ownership: %s', (variant) => {
  const x = ownedLabel()
  if (variant === 'unknown font') delete x.tokens[0].fontDescent
  if (variant === 'invalid font') x.tokens[0].fontDescent = -Infinity
  if (variant === 'positive descent') x.tokens[0].fontDescent = 0.2
  if (variant === 'rotated text') x.tokens[0].horizontal = false
  if (variant === 'crosses left edge') x.tokens[0].rect[0] = 39
  if (variant === 'crosses top edge') x.tokens[0].rect[1] = 199
  if (variant === 'crosses bottom edge') x.tokens[0].rect[3] += 0.1
  if (variant === 'crosses bottom beyond roundoff') {
    x.tokens[0].rect[3] += 1e-7
    x.tokens[0].baseline = x.tokens[0].rect[3]
  }
  if (variant === 'different baseline') x.tokens[0].baseline -= 1
  if (variant === 'excluded prose') {
    x.figure.excludedProseLines = [{ x: 407, y: 380.65, width: 36, height: 10.51 }]
  }
  if (variant === 'foreign text in extension') {
    x.tokens.push({ rect: [60, 393, 100, 403], horizontal: true })
  }
  expect(nativeOwnedFigureInkBottom(x.figure, x.tokens)).toBe(x.figure.rect[3])
})
