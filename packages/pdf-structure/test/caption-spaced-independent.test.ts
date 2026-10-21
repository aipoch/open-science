import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)

function sample(two = false): ReturnType<typeof JSON.parse> {
  const em = 11,
    x = 60,
    width = 450
  const line = (
    text: string,
    y: number,
    w = width,
    fontSize = em,
    height = fontSize
  ): ReturnType<typeof JSON.parse> => ({ text, x, y, width: w, height, fontSize })
  const lines = two
    ? [
        line('Table 1: Two complete sets of measurements are shown with', 100),
        line('the same native units.', 127, 160),
        line('Independent ordinary paragraph begins below.', 165, width, 12)
      ]
    : [
        line('Figure 1. Measurements for the complete sequence are shown.', 100),
        line('The upper series contains the paired observations for the', 119),
        line('sample in the measured units x', 138, 400, 12, 13),
        { ...line('2', 138, 5, 8), x: 460 },
        { ...line(' here and', 138, 45, 12, 13), x: 465 },
        line('all later values.', 159, 150),
        line('Independent heading', 225, 180, 13)
      ]
  const rules = two
    ? [
        [60, 80, 510, 80],
        [60, 90, 510, 90]
      ]
    : []
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    rotation: 0,
    invalidGraphicsBounds: 0,
    lines,
    graphicsBounds: rules.map((r, i) => ({
      kind: 'path',
      operationIndex: i,
      normalizedRect: r.map((v, n) => v / (n % 2 ? 800 : 600))
    }))
  }
  return { page, rules }
}

it.each([false, true])(
  'recovers a closed independent wide-leading caption, two lines=%s',
  (two) => {
    const f = sample(two),
      before = structuredClone(f),
      results = findCaptionCandidates([f.page], new Map([[1, f.rules]]))
    expect(results).toHaveLength(1)
    expect(results[0].lines).toHaveLength(two ? 2 : 4)
    expect(results[0].lines.at(-1)).toBe(two ? 'the same native units.' : 'all later values.')
    expect(results[0].rect).toEqual([60, 100, 510, two ? 138 : 170])
    expect(f).toEqual(before)
  }
)

it('retains an isolated native tall line band before a closed page ending', () => {
  const f = sample()
  f.page.lines.splice(3, 2)
  f.page.lines[2].width = 450
  f.page.lines.pop()
  const result = findCaptionCandidates([f.page], new Map([[1, f.rules]]))
  expect(result[0].lines).toHaveLength(4)
  expect(result[0].lines[2]).toBe(f.page.lines[2].text)
})

it('uses the smaller numeric table rows between its header rule and two-line caption', () => {
  const f = sample(true)
  f.rules = [[60, 50, 510, 50]]
  f.page.graphicsBounds = [
    { kind: 'path', operationIndex: 0, normalizedRect: [0.1, 50 / 800, 0.85, 50 / 800] }
  ]
  f.page.lines.unshift(
    ...[50, 75].map((y) => ({
      text: 'Group 10 20 30',
      x: 80,
      y,
      width: 400,
      height: 10,
      fontSize: 10
    }))
  )
  expect(findCaptionCandidates([f.page], new Map([[1, f.rules]]))[0].lines).toHaveLength(2)
  f.page.lines[1].text = 'Independent words'
  expect(findCaptionCandidates([f.page], new Map([[1, f.rules]]))[0].lines).toHaveLength(1)
})

it.each([
  'leading',
  'gutter',
  'short-interior',
  'open-tail',
  'body-font',
  'unproved-font',
  'crossing-paint',
  'crossing-text',
  'missing-table',
  'caption-reference'
])('keeps a suspected continuation out with %s evidence missing', (mode) => {
  const two = mode === 'missing-table' || mode === 'caption-reference',
    f = sample(two)
  if (mode === 'leading') f.page.lines[1].y += 5
  if (mode === 'gutter') f.page.lines[1].x += 10
  if (mode === 'short-interior') f.page.lines[1].width = 200
  if (mode === 'open-tail') f.page.lines[5].text = 'all later values'
  if (mode === 'body-font') {
    f.page.lines[6].fontSize = 11
    f.page.lines[6].height = 11
  }
  if (mode === 'unproved-font') {
    f.page.lines.splice(3, 1)
    f.page.lines[2].height = 12
    f.page.lines[3].height = 12
  }
  if (mode === 'crossing-paint')
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex: 5,
      normalizedRect: [0.1, 0.15, 0.9, 0.2]
    })
  if (mode === 'crossing-text')
    f.page.lines.push({ text: 'Unrelated', x: 50, y: 125, width: 30, height: 11, fontSize: 11 })
  if (mode === 'missing-table') {
    f.rules = []
    f.page.graphicsBounds = []
  }
  if (mode === 'caption-reference') f.page.lines[1].text = 'Table 2: Another independent caption.'
  const result = findCaptionCandidates([f.page], new Map([[1, f.rules]]))
  expect(
    result.find((c: { lines: string[] }) => c.lines[0].startsWith(two ? 'Table 1' : 'Figure 1'))
      ?.lines.length ?? 0
  ).toBeLessThan(two ? 2 : 4)
})
