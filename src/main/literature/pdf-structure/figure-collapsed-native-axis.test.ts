import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const input = (): {
  page: {
    pageNumber: number
    width: number
    height: number
    rotation: number
    invalidGraphicsBounds: number
    graphicsBounds: { kind: string; normalizedRect: number[] }[]
    lines: { text: string; x: number; y: number; width: number; height: number; fontSize: number }[]
  }
  captions: { page: number; lines: string[]; rect: number[] }[]
  rules: number[][]
} => ({
  page: {
    pageNumber: 1,
    width: 600,
    height: 800,
    rotation: 0,
    invalidGraphicsBounds: 0,
    graphicsBounds: [{ kind: 'path', normalizedRect: [90 / 600, 80 / 800, 310 / 600, 260 / 800] }],
    lines: [
      ...Array.from({ length: 5 }, (_, i) => ({
        text: String(i + 1),
        x: 80,
        y: 85 + i * 35,
        width: 0,
        height: 5,
        fontSize: 5
      })),
      { text: 'u', x: 66, y: 170, width: 8, height: 0, fontSize: 8 }
    ]
  },
  captions: [{ page: 1, lines: ['Figure 1. Native chart.'], rect: [50, 285, 330, 310] }],
  rules: [
    [90, 80, 310, 80],
    [90, 260, 310, 260],
    [90, 80, 90, 260],
    [310, 80, 310, 260]
  ]
})
it('retains collapsed native axis anchors only beside a uniquely closed plot and repeated ticks', () => {
  const f = input(),
    r = associateFigures(f.page, f.captions, [], f.rules)[0]
  expect(r.rect[0]).toBeLessThanOrEqual(66)
  expect(f.page.lines[0].width).toBe(0)
  expect(f.page.lines.at(-1)?.height).toBe(0)
})
it.each(['missing-edge', 'competing-edge', 'irregular-ticks', 'external-prose'])(
  'does not expand a chart from unproven collapsed anchors: %s',
  (variant) => {
    const f = input()
    if (variant === 'missing-edge') f.rules.pop()
    if (variant === 'competing-edge')
      f.rules.push([91, 80, 310, 80], [91, 260, 310, 260], [91, 80, 91, 260])
    if (variant === 'irregular-ticks') f.page.lines[2].y += 10
    if (variant === 'external-prose')
      f.page.lines.push({
        text: 'An independent long paragraph crosses the proposed axis strip.',
        x: 60,
        y: 100,
        width: 100,
        height: 10,
        fontSize: 10
      })
    const r = associateFigures(f.page, f.captions, [], f.rules)[0]
    expect(r.rect[0]).toBeGreaterThan(66)
  }
)
