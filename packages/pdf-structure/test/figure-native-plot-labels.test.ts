import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
const { nativeAttachedPlotLabels } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { nativeTopParagraphTail } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-bands.mjs')).href
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

it('completes right colorbar ticks and fragmented rotated labels', () => {
  const f = input()
  f.tokens = [
    ...Array.from({ length: 5 }, (_, i) =>
      token(`${i * 100}`, [496, 110 + i * 25, 514, 118 + i * 25])
    ),
    token('Velocity', [519, 130, 527, 190], false),
    token('x', [522, 122, 528, 130], false, 6)
  ]
  expect(nativeAttachedPlotLabels(f.page, f.figure, [], [], [], f.tokens).rect).toEqual([
    100, 100, 528, 250
  ])
  f.tokens = f.tokens.slice(3)
  expect(nativeAttachedPlotLabels(f.page, f.figure, [], [], [], f.tokens).rect).toEqual(
    f.figure.rect
  )
  f.tokens.push({ ...f.tokens[0] }, { ...f.tokens[0] })
  expect(nativeAttachedPlotLabels(f.page, f.figure, [], [], [], f.tokens).rect).toEqual(
    f.figure.rect
  )
})

it.each(['complete', 'missing-marker', 'duplicate-key', 'prose', 'table', 'caption'])(
  'completes partially owned bottom legend labels only with paired keys: %s',
  (change) => {
    const f = input()
    f.tokens = [
      token('First measure', [190, 248, 280, 256]),
      token('Second measure', [350, 248, 450, 256])
    ]
    f.rules = [
      [166, 252, 176, 252],
      [176, 252, 186, 252],
      [326, 252, 336, 252],
      [336, 252, 346, 252]
    ]
    const tables: number[][] = [],
      captions: ReturnType<typeof JSON.parse>[] = []
    if (change === 'missing-marker') f.rules = f.rules.slice(0, 2)
    if (change === 'duplicate-key') f.tokens[1] = { ...f.tokens[0] }
    if (change === 'prose') f.tokens.push(token('Unowned prose', [100, 250, 150, 258]))
    if (change === 'table') tables.push([100, 250, 150, 258])
    if (change === 'caption') captions.push({ page: 1, rect: [100, 250, 150, 258] })
    expect(
      nativeAttachedPlotLabels(f.page, f.figure, captions, tables, f.rules, f.tokens).rect
    ).toEqual(change === 'complete' ? [100, 100, 500, 256] : f.figure.rect)
  }
)
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

const outerAxes = (): ReturnType<typeof JSON.parse> => ({
  page: { pageNumber: 1, width: 600, height: 800, graphicsBounds: [] },
  figure: { rect: [98, 98, 402, 252] },
  rules: [
    [100, 100, 400, 100],
    [100, 250, 400, 250],
    [100, 100, 100, 250],
    [400, 100, 400, 250]
  ],
  tokens: [
    ...Array.from({ length: 4 }, (_, i) => token(String(i), [84, 110 + i * 30, 94, 118 + i * 30])),
    token('Amplitude', [65, 140, 73, 210], false),
    ...Array.from({ length: 4 }, (_, i) =>
      token(String(i), [120 + i * 70, 254, 130 + i * 70, 262])
    ),
    token('Time', [230, 266, 260, 274])
  ]
})
it('completes external tick columns and axis titles from a closed native frame', () => {
  const f = outerAxes()
  expect(nativeAttachedPlotLabels(f.page, f.figure, [], [], f.rules, f.tokens).rect).toEqual([
    65, 98, 402, 274
  ])
})
it.each(['open frame', 'one tick', 'caption barrier', 'body continuation', 'bad token'])(
  'refuses outside frame labels with %s',
  (kind) => {
    const f = outerAxes()
    let captions: unknown[] = []
    if (kind === 'open frame') f.rules.pop()
    if (kind === 'one tick')
      f.tokens = f.tokens.filter((_: unknown, i: number) => i === 0 || i === 4)
    if (kind === 'caption barrier') captions = [{ page: 1, rect: [80, 251, 410, 260] }]
    if (kind === 'body continuation')
      f.tokens.push(
        token('This paragraph must remain separate from the figure.', [70, 265, 400, 273])
      )
    if (kind === 'bad token') f.tokens[0].rect[2] = 70
    expect(
      nativeAttachedPlotLabels(f.page, f.figure, captions, [], f.rules, f.tokens).rect
    ).toEqual(f.figure.rect)
  }
)
