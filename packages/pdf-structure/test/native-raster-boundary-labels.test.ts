import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { nativeOwnedFigureBottomLabels } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-owned-figure-labels.mjs')).href
)
function catalog(): ReturnType<typeof JSON.parse> {
  const tokens = [],
    graphicsBounds = []
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++) {
      const index = row * 3 + col,
        x = 50 + col * 160,
        y = 50 + row * 120
      graphicsBounds.push({
        kind: 'image',
        operationIndex: index + 1,
        imageHash: `${index}`.repeat(64),
        normalizedRect: [x, y, x + 120, y + 90].map((v, n) => v / (n % 2 ? 800 : 600))
      })
      const text = `Sample ${index + 1}`
      tokens.push({
        text,
        horizontal: true,
        height: 10,
        baseline: y + 103,
        rect: [x + 30, y + 93, x + 90, y + 103],
        sourceItem: { pageNumber: 1, index, text }
      })
    }
  const caption = {
    page: 1,
    lines: ['Figure 1. Repeated measurements.'],
    rect: [50, 410, 490, 420]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    graphicsBounds,
    lines: [
      ...tokens.map((t) => ({
        text: t.text,
        x: t.rect[0],
        y: t.rect[1],
        width: t.rect[2] - t.rect[0],
        height: 10,
        fontSize: 10
      })),
      { text: caption.lines[0], x: 50, y: 410, width: 440, height: 10, fontSize: 10 }
    ]
  }
  return { page, caption, tokens, rect: [50, 50, 490, 380] }
}
const labels = (f: ReturnType<typeof catalog>): number[][] =>
  nativeOwnedFigureBottomLabels(f.page, f.caption, [f.caption], [], f.rect, [], f.tokens)
it('completes the final native label row proved by every whole raster in a repeated catalog', () => {
  const f = catalog(),
    before = structuredClone(f)
  expect(labels(f)).toEqual(f.tokens.slice(6).map((t: { rect: number[] }) => t.rect))
  expect(f).toEqual(before)
})

it.each(['missing-label', 'duplicate-origin', 'detached-label', 'foreign-tail', 'wrong-font'])(
  'leaves a detached catalog tail unowned when full repeated closure fails: %s',
  (kind) => {
    const f = catalog()
    if (kind === 'missing-label') f.tokens.splice(1, 1)
    if (kind === 'duplicate-origin') f.tokens.push(structuredClone(f.tokens[0]))
    if (kind === 'detached-label') f.tokens[1].rect[1] += 20
    if (kind === 'wrong-font') f.tokens[1].height *= 1.5
    if (kind === 'foreign-tail')
      f.tokens.push({
        text: 'Another paragraph.',
        horizontal: true,
        height: 10,
        baseline: 393,
        rect: [50, 383, 70, 393],
        sourceItem: { pageNumber: 1, index: 20, text: 'Another paragraph.' }
      })
    expect(labels(f)).toEqual([])
  }
)
function wrappedPair(): ReturnType<typeof JSON.parse> {
  const caption = { page: 1, lines: ['Fig. 1: Two measurements.'], rect: [40, 550, 500, 560] }
  const tokens = [0, 1].flatMap((side) =>
    [
      '(a) A complete native explanation',
      'continues across the same row width',
      'and ends here.'
    ].map((text, row) => {
      if (side && !row) text = text.replace('(a)', '(b)')
      const x = 40 + side * 260,
        y = 490 + row * 12,
        index = side * 3 + row
      return {
        text,
        horizontal: true,
        height: 10,
        baseline: y + 10,
        rect: [x, y, x + 200, y + 10],
        sourceItem: { pageNumber: 1, index, text }
      }
    })
  )
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    graphicsBounds: [0, 1].map((side) => ({
      kind: 'image',
      imageHash: 'whole-panel',
      normalizedRect: [50 + side * 260, 400, 230 + side * 260, 480].map(
        (v, n) => v / (n % 2 ? 800 : 600)
      )
    })),
    lines: [
      ...tokens.map((t) => ({
        text: t.text,
        x: t.rect[0],
        y: t.rect[1],
        width: 200,
        height: 10,
        fontSize: 10
      })),
      { text: caption.lines[0], x: 40, y: 550, width: 460, height: 10, fontSize: 10 }
    ]
  }
  return { page, caption, tokens, rect: [40, 400, 500, 500] }
}
it('retains both complete native continuation rows of a pair of wrapped subcaptions', () => {
  const f = wrappedPair(),
    before = structuredClone(f)
  expect(labels(f)).toEqual([
    [40, 490, 240, 524],
    [300, 490, 500, 524]
  ])
  expect(f).toEqual(before)
})
it.each(['source-gap', 'stale-source', 'foreign-line', 'different-lane'])(
  'does not borrow an unproved wrapped continuation: %s',
  (kind) => {
    const f = wrappedPair()
    if (kind === 'source-gap') f.tokens[1].sourceItem.index = 20
    if (kind === 'stale-source') f.tokens[1].sourceItem.text += ' Stale.'
    if (kind === 'different-lane') f.tokens[1].rect = [250, 502, 450, 512]
    if (kind === 'foreign-line')
      f.tokens.push({
        text: 'Unrelated prose.',
        horizontal: true,
        height: 10,
        baseline: 524,
        rect: [250, 514, 290, 524],
        sourceItem: { pageNumber: 1, index: 30, text: 'Unrelated prose.' }
      })
    expect(labels(f).some((r) => r[3] === 524)).toBe(false)
  }
)
