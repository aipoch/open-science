import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'

const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)

it('does not scan every interior path for marks with no enclosing prose', () => {
  let reads = 0
  const count = 800
  const graphicsBounds = Array.from({ length: count }, (_, index) => {
    const left = 0.2 + (index % 40) * 0.01
    const top = 0.25 + Math.floor(index / 40) * 0.01
    const rect = [left, top, left + 0.001, top + 0.001]
    return {
      kind: 'path',
      get normalizedRect(): number[] {
        reads++
        return rect
      }
    }
  })
  graphicsBounds.push({ kind: 'path', normalizedRect: [0.2, 0.25, 0.6, 0.45] })
  const caption = { page: 1, lines: ['Figure 1. Native point marks'], rect: [100, 375, 400, 387] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds
  }
  const result = associateFigures(page, [caption], [])
  expect(result).toHaveLength(1)
  expect(result[0].rect).toEqual([120, 200, 360, 360])
  // Count actual geometry reads rather than timing a machine-dependent run.
  expect(reads).toBeLessThan(count * 40)
})

it.each(['side', 'stacked'])('bounds geometry work across %s captions', (mode) => {
  let reads = 0
  const count = 128
  const graphicsBounds = Array.from({ length: count }, (_, index) => {
    const left = (mode === 'side' ? 0.58 : 0.2) + (index % 32) * 0.009
    const top = (mode === 'side' ? 0.16 : 0.35) + Math.floor(index / 32) * 0.009
    const rect = [left, top, left + 0.005, top + 0.006]
    return {
      kind: 'path',
      get normalizedRect(): number[] {
        reads++
        return rect
      }
    }
  })
  const captions =
    mode === 'side'
      ? [{ page: 1, lines: ['Figure 1. Results.'], rect: [60, 220, 240, 238] }]
      : [200, 400].map((top, index) => ({
          page: 1,
          lines: [`Figure ${index + 1}. Results.`],
          rect: [60, top, 440, top + 18]
        }))
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds
  }
  expect(associateFigures(page, captions)).toEqual(
    captions.map((caption) => ({ caption, reason: 'no-unambiguous-adjacent-graphics' }))
  )
  // Tiny marks do not establish a crop. Their count must not multiply full-page scans.
  expect(reads).toBeLessThan(count * 64)
})
