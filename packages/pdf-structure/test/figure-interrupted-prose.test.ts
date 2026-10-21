import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { nativeTopParagraphTail } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-bands.mjs')).href
)

it('does not use a caption continuation as independent paragraph evidence', () => {
  const lines = [60, 73, 260].map((y) => ({
    text: 'Independent measurements under the stated conditions and reported experimental observations',
    x: 50,
    y,
    width: 500,
    height: 10,
    fontSize: 10
  }))
  const captions = [{ rect: [50, 245, 550, 270] }]
  expect(nativeTopParagraphTail(lines[1], [50, 100, 550, 230], lines, captions)).toBe(false)
})

it.each([true, false])(
  'requires independently continuing prose below an interrupting plot: %s',
  (continued) => {
    const lines = [60, 73, ...(continued ? [260] : [])].map((y) => ({
      text: 'The independent source describes several observations and continues with further measured values',
      x: 50,
      y,
      width: 500,
      height: 10,
      fontSize: 10
    }))
    expect(nativeTopParagraphTail(lines[1], [50, 100, 550, 230], lines)).toBe(continued)
  }
)

it.each([true, false])(
  'uses disjoint subplot evidence before excluding remote mathematical prose: %s',
  (bracketed) => {
    const page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: (bracketed ? [111, 174, 186] : [174, 186]).map((y) => ({
        text: 'Each independent source measurement explains these values.',
        x: 54,
        y,
        width: 245,
        height: 10,
        fontSize: 10
      })),
      graphicsBounds: [
        [103, 142, 265, 148],
        [316, 50, 567, 278],
        [349, 68, 447, 142],
        [469, 71, 557, 142]
      ].map((r) => ({
        kind: 'path',
        normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 600))
      }))
    }
    const captions = [
      { page: 1, rect: [317, 287, 562, 297], lines: ['FIG. 1. Independent observations.'] }
    ]
    const [figure] = associateFigures(page, captions)
    if (bracketed) expect(figure.rect[0]).toBeGreaterThan(310)
    else expect(figure.rect[0]).toBeLessThan(200)
    expect(figure.rect[2]).toBeGreaterThan(550)
  }
)
