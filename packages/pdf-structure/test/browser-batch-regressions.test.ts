import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { isAlgorithmExtendedOpenRuleDuplicate } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-regions.mjs')).href
)
const { recoverCaptionedPanelGrid } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)

it('suppresses an open-rule duplicate that runs into an Algorithm block', () => {
  const complete = [{ cropRect: [100, 160, 500, 280] }]
  const candidate = { id: 'p23-open-rule-table-0', cropRect: [98, 158, 502, 520] }
  const items = [
    { text: 'Algorithm 6', rect: [110, 300, 180, 314] },
    { text: 'Input: traces and counts', rect: [110, 324, 260, 338] }
  ]
  expect(isAlgorithmExtendedOpenRuleDuplicate(items, complete, candidate)).toBe(true)
})

it('keeps a legitimate continued table without an algorithm marker', () => {
  const complete = [{ cropRect: [100, 160, 500, 280] }]
  const candidate = { id: 'p23-open-rule-table-0', cropRect: [98, 158, 502, 520] }
  const items = [
    { text: 'continued row', rect: [110, 300, 180, 314] },
    { text: '12.4', rect: [420, 300, 450, 314] }
  ]
  expect(isAlgorithmExtendedOpenRuleDuplicate(items, complete, candidate)).toBe(false)
})

it('joins a captioned two-panel figure when the upper panel was table-shaped', () => {
  const page = {
    width: 600,
    height: 800,
    lines: [
      { text: '(a) first panel', x: 110, y: 130, width: 140, height: 12 },
      { text: 'upper panel details', x: 110, y: 200, width: 180, height: 12 }
    ],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [120 / 600, 420 / 800, 480 / 600, 680 / 800] }
    ]
  }
  const caption = {
    page: 1,
    lines: ['Figure 9: (a) first panel and (b) second panel.'],
    rect: [80, 720, 520, 750]
  }
  const figure = { caption, rect: [120, 420, 480, 680] }
  const result = recoverCaptionedPanelGrid(page, figure, [caption], [[100, 170, 500, 360]])
  expect(result?.rect[0]).toBeLessThanOrEqual(100)
  expect(result?.rect[1]).toBeLessThanOrEqual(130)
  expect(result?.rect[2]).toBeGreaterThanOrEqual(500)
  expect(result?.rect[3]).toBeGreaterThanOrEqual(680)
})

it('ignores malformed graphics while recovering a table-shaped upper panel', () => {
  const page = {
    width: 600,
    height: 800,
    lines: [
      { text: '(a) first panel', x: 110, y: 130, width: 140, height: 12 },
      { text: 'upper panel details', x: 110, y: 200, width: 180, height: 12 }
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: null },
      { kind: 'image', normalizedRect: [120 / 600, 420 / 800, 480 / 600, 680 / 800] }
    ]
  }
  const caption = {
    page: 1,
    lines: ['Figure 9: (a) first panel and (b) second panel.'],
    rect: [80, 720, 520, 750]
  }
  expect(() =>
    recoverCaptionedPanelGrid(
      page,
      { caption, rect: [120, 420, 480, 680] },
      [caption],
      [[100, 170, 500, 360]]
    )
  ).not.toThrow()
})

it('joins an explicitly left-right figure with a text-heavy right panel', () => {
  const page = {
    width: 600,
    height: 800,
    lines: [
      { text: 'What this paper tests', x: 300, y: 90, width: 150, height: 12 },
      { text: '1 Do generators produce valid references?', x: 300, y: 110, width: 220, height: 12 },
      { text: 'Varied: base vs. post-trained variants.', x: 312, y: 124, width: 190, height: 12 },
      {
        text: '2 Do the references cover varied expressions?',
        x: 300,
        y: 150,
        width: 230,
        height: 12
      },
      {
        text: 'Varied: model variant and reference count.',
        x: 312,
        y: 164,
        width: 190,
        height: 12
      },
      { text: 'Left panel content', x: 100, y: 110, width: 120, height: 12 }
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [70 / 600, 90 / 800, 280 / 600, 260 / 800] },
      { kind: 'path', normalizedRect: [290 / 600, 86 / 800, 306 / 600, 104 / 800] },
      { kind: 'path', normalizedRect: [290 / 600, 126 / 800, 306 / 600, 144 / 800] }
    ]
  }
  const caption = {
    page: 1,
    lines: ['Figure 1: The benchmark (left) and the conditions behind its scores (right).'],
    rect: [70, 300, 530, 330]
  }
  const result = recoverCaptionedPanelGrid(
    page,
    { caption, rect: [70, 86, 380, 270] },
    [caption],
    []
  )
  expect(result?.rect[0]).toBeLessThanOrEqual(70)
  expect(result?.rect[2]).toBeGreaterThanOrEqual(530)
  expect(result?.rect[3]).toBeLessThanOrEqual(300)
})
