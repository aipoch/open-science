import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { nativeAttachedPlotLabels } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-native-plot-labels.mjs'))
    .href
)
const { nativeTopParagraphTail } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-native-plot-bands.mjs')).href
)
const token = (
  text: string,
  rect: number[],
  horizontal = true,
  height = 8
): ReturnType<typeof JSON.parse> => ({ text, rect, horizontal, height, baseline: rect[3] })
const input = (): ReturnType<typeof JSON.parse> => ({
  page: { pageNumber: 1, width: 600, height: 800, graphicsBounds: [] },
  figure: { rect: [100, 100, 500, 250] },
  tokens: [
    ...Array.from({ length: 5 }, (_, i) => token(`${i}.0`, [100, 110 + i * 25, 116, 118 + i * 25])),
    token('Power', [80, 130, 90, 170], false, 10),
    token('−2', [77, 120, 85, 130], false, 8),
    token('First', [160, 80, 185, 86], true, 6),
    token('Second', [260, 80, 290, 86], true, 6),
    token('Third', [360, 80, 385, 86], true, 6)
  ],
  rules: [
    [143, 83, 157, 83],
    [243, 83, 257, 83],
    [343, 83, 357, 83]
  ]
})
it('recovers fragmented rotated axis and the complete keyed common legend', () => {
  const f = input()
  expect(nativeAttachedPlotLabels(f.page, f.figure, [], [], f.rules, f.tokens).rect).toEqual([
    77, 80, 500, 250
  ])
})
it.each(['missing-ticks', 'distant-axis', 'missing-markers', 'competing-caption', 'table'])(
  'requires independent ownership for external plot lettering: %s',
  (reason) => {
    const f = input(),
      captions: ReturnType<typeof JSON.parse>[] = [],
      tables: number[][] = []
    if (reason === 'missing-ticks') f.tokens = f.tokens.slice(5)
    if (reason === 'distant-axis')
      f.tokens = f.tokens.filter((t: ReturnType<typeof JSON.parse>) => t.horizontal)
    if (reason === 'missing-markers') f.rules = []
    if (reason === 'competing-caption') captions.push({ page: 1, rect: [77, 80, 190, 90] })
    if (reason === 'table') tables.push([77, 80, 190, 90])
    const rect = nativeAttachedPlotLabels(
      f.page,
      f.figure,
      captions,
      tables,
      f.rules,
      f.tokens
    ).rect
    if (reason === 'missing-ticks' || reason === 'distant-axis') expect(rect[0]).toBe(100)
    if (reason === 'missing-markers') expect(rect[1]).toBe(100)
    if (reason === 'table' || reason === 'competing-caption') expect(rect).toEqual(f.figure.rect)
  }
)
it('recovers one enclosed heading only above repeated populated axes', () => {
  const f = input()
  f.tokens = f.tokens.filter((t: ReturnType<typeof JSON.parse>) => t.rect[1] >= 100)
  f.tokens.push(token('Common panel title', [190, 75, 410, 86], true, 10))
  f.page.graphicsBounds = [
    { kind: 'path', normalizedRect: [90 / 600, 70 / 800, 510 / 600, 260 / 800] }
  ]
  f.rules = [
    [120, 110, 120, 230],
    [280, 110, 280, 230],
    [440, 110, 440, 230]
  ]
  expect(nativeAttachedPlotLabels(f.page, f.figure, [], [], f.rules, f.tokens).rect[1]).toBe(75)
  f.page.graphicsBounds = []
  expect(nativeAttachedPlotLabels(f.page, f.figure, [], [], f.rules, f.tokens).rect[1]).toBe(100)
})

it.each([false, true])(
  'keeps a two-row body tail outside smaller figure lettering, bullets: %s',
  (bullets) => {
    const lines = [
      {
        text: bullets
          ? '• First external operation;'
          : 'A source paragraph with enough words to prove an ordinary body row before the figure.',
        x: 40,
        y: 40,
        width: 440,
        height: 10,
        fontSize: 10
      },
      {
        text: bullets ? '• Second external operation.' : 'Final words.',
        x: 40,
        y: 54,
        width: 140,
        height: 10,
        fontSize: 10
      },
      { text: 'Plot title', x: 120, y: 100, width: 120, height: 6, fontSize: 6 }
    ]
    expect(nativeTopParagraphTail(lines[1], [70, 80, 470, 250], lines)).toBe(true)
    lines[2].fontSize = 10
    expect(nativeTopParagraphTail(lines[1], [70, 80, 470, 250], lines)).toBe(false)
  }
)
