import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const { collectClosedFigureFrames } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-graphics.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const {
  nativeCaptionedPlotBand,
  nativeFigureRunningHead,
  nativeClosedCategoryLabels,
  nativeAlignedNodeFigure,
  nativeTopParagraphTail,
  nativeDisjointPlotColumn
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-native-plot-bands.mjs')).href
)
const input = (): ReturnType<typeof JSON.parse> => {
  const caption = { page: 1, lines: ['Figure 1: Paired curves.'], rect: [40, 280, 240, 292] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 40, y: 280, width: 200, height: 10, fontSize: 10 }],
    graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
  }
  const rules: number[][] = []
  for (const left of [100, 330]) {
    rules.push(
      [left, 60, left + 170, 60],
      [left, 240, left + 170, 240],
      [left, 60, left, 240],
      [left + 170, 60, left + 170, 240]
    )
    for (const rect of [
      [left - 1, 59, left + 171, 241],
      [left + 3, 64, left + 160, 232],
      [left + 6, 68, left + 155, 220],
      [left + 10, 74, left + 150, 205]
    ])
      page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600))
      })
    for (let i = 0; i < 5; i++)
      page.lines.push({
        text: String(i),
        x: left - 15,
        y: 75 + i * 30,
        width: 8,
        height: 8,
        fontSize: 8
      })
    page.lines.push({
      text: 'Horizontal axis',
      x: left + 20,
      y: 247,
      width: 110,
      height: 8,
      fontSize: 8
    })
  }
  const tableCaption = {
    page: 1,
    lines: ['Table 1. Independent records.'],
    rect: [40, 380, 240, 392]
  }
  return { page, caption, captions: [caption, tableCaption], rules }
}
const positionedClosedPlots = (): ReturnType<typeof JSON.parse> => {
  const caption = {
      page: 1,
      lines: [
        'Figure 1: Left: first measurement. Center: second measurement. Right: third measurement.'
      ],
      rect: [95, 170, 510, 180]
    },
    page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: [] as ReturnType<typeof JSON.parse>[],
      graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
    },
    frames = [
      [110, 70, 220, 140],
      [250, 71.1, 360, 141.1],
      [390, 71.4, 500, 141.4]
    ],
    rules: number[][] = [],
    tokens: ReturnType<typeof JSON.parse>[] = []
  const line = (text: string, rect: number[], height: number, horizontal = true): void => {
    page.lines.push({
      text,
      x: rect[0],
      y: rect[1],
      width: rect[2] - rect[0],
      height: rect[3] - rect[1],
      fontSize: height
    })
    tokens.push({ text, rect, height, horizontal, baseline: rect[3] })
  }
  line(caption.lines[0], caption.rect, 10)
  for (const [left, top, right, bottom] of frames) {
    rules.push(
      [left, top, right, top],
      [left, bottom, right, bottom],
      [left, top, left, bottom],
      [right, top, right, bottom]
    )
    for (const rect of [
      [left - 14, top - 3, right + 6, bottom + 17],
      ...Array.from({ length: 3 }, (_, n) => [
        left + 5,
        top + 10 + n * 4,
        right - 5,
        bottom - 10 - n * 4
      ])
    ])
      page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: rect.map((v, n) => v / (n % 2 ? 800 : 600))
      })
    for (let n = 0; n < 4; n++)
      line(String(n), [left - 8, top + 8 + n * 15, left - 4, top + 11 + n * 15], 3)
    line('0 1 2 3 4', [left + 3, bottom + 1, right - 3, bottom + 4], 3)
    line('Position', [left + 30, bottom + 6, left + 66, bottom + 9.5], 3.5)
    line('Outcome', [left - 12, top + 25, left - 8.5, top + 37], 3.5, false)
  }
  return { page, caption, captions: [caption], frames, rules, tokens }
}
it('retains three independently closed positioned plots and every whole measured paint carrier', () => {
  const f = positionedClosedPlots(),
    before = structuredClone(f),
    proof = nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, f.frames, f.tokens)
  expect(proof?.rect).toEqual([96, 67, 506, 158.4])
  expect(proof?.graphicsCount).toBe(3)
  expect(f).toEqual(before)
})
it('completes the real association consumer across all three positioned closed plots', () => {
  const f = positionedClosedPlots(),
    figures = associateFigures(f.page, f.captions, [], f.rules, f.frames, f.tokens)
  expect(figures).toHaveLength(1)
  expect(figures[0].rect).toEqual([96, 67, 506, 158.4])
  expect(figures[0].caption).toEqual(f.caption)
  expect(figures[0].graphicsCount).toBe(3)
})
it.each([
  'missing-frame',
  'mismatched-frame',
  'missing-font',
  'clipped-font',
  'invalid-baseline',
  'duplicate-font',
  'missing-rotated-axis',
  'missing-position-key',
  'competing-caption',
  'foreign-column-paint',
  'oversized-background',
  'crossing-table'
])('refuses incomplete three-position plot evidence: %s', (reason) => {
  const f = positionedClosedPlots(),
    tables: number[][] = []
  if (reason === 'missing-frame') f.frames.shift()
  if (reason === 'mismatched-frame') f.frames[0][0] += 0.01
  if (reason === 'missing-font')
    f.tokens = f.tokens.filter((t: ReturnType<typeof JSON.parse>) => t.text !== 'Position')
  if (reason === 'clipped-font')
    f.page.lines.find((l: ReturnType<typeof JSON.parse>) => l.text === 'Position').height -= 0.1
  if (reason === 'invalid-baseline')
    f.tokens.find((t: ReturnType<typeof JSON.parse>) => t.text === 'Position').baseline = NaN
  if (reason === 'duplicate-font')
    f.tokens.push(
      structuredClone(f.tokens.find((t: ReturnType<typeof JSON.parse>) => t.text === 'Position'))
    )
  if (reason === 'missing-rotated-axis')
    f.tokens.find((t: ReturnType<typeof JSON.parse>) => t.text === 'Outcome').horizontal = true
  if (reason === 'missing-position-key')
    f.caption.lines[0] = f.caption.lines[0].replace('Left:', 'First:')
  if (reason === 'competing-caption') f.captions.push(structuredClone(f.caption))
  if (reason === 'foreign-column-paint')
    f.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [230 / 600, 90 / 800, 265 / 600, 100 / 800]
    })
  if (reason === 'oversized-background')
    f.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [90 / 600, 60 / 800, 510 / 600, 165 / 800]
    })
  if (reason === 'crossing-table') tables.push([120, 90, 210, 130])
  const proof = nativeCaptionedPlotBand(
    f.page,
    f.caption,
    f.captions,
    tables,
    f.rules,
    f.frames,
    f.tokens
  )
  expect(proof?.graphicsCount).not.toBe(3)
  if (reason === 'crossing-table') expect(proof?.graphicsCount).toBe(2)
})
it('preserves a different-page equal-coordinate caption outside the positioned plot ownership proof', () => {
  const f = positionedClosedPlots()
  f.captions.push({ ...structuredClone(f.caption), page: 2 })
  expect(
    nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, f.frames, f.tokens)?.rect
  ).toEqual([96, 67, 506, 158.4])
})
const closedSharedLegend = (): ReturnType<typeof JSON.parse> => {
  const caption = {
    page: 1,
    lines: ['FIG. 1: Three measurements share an independent closed legend.'],
    rect: [55, 280, 565, 290]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 55, y: 280, width: 510, height: 10, fontSize: 10 }],
    graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
  }
  const tokens: ReturnType<typeof JSON.parse>[] = [],
    frames = [
      [80, 60, 530, 85],
      [100, 105, 230, 210],
      [265, 105, 395, 210],
      [430, 105, 560, 210]
    ]
  const line = (text: string, r: number[], size = 10, horizontal = true): void => {
    page.lines.push({
      text,
      x: r[0],
      y: r[1],
      width: r[2] - r[0],
      height: r[3] - r[1],
      fontSize: size
    })
    tokens.push({ text, rect: r, height: size, baseline: r[3], horizontal })
  }
  const paint = (r: number[]): void => {
    page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: r.map((v, n) => v / (n % 2 ? 800 : 600))
    })
  }
  paint([52, 50, 570, 253])
  frames.slice(1).forEach((f, n) => {
    paint([f[0] - 2, f[1] - 2, f[2] + 3, f[3] + 4])
    for (let i = 0; i < 3; i++) paint([f[0] + 4, f[1] + 18 + i * 4, f[2] - 4, f[3] - 3 - i * 4])
    line(`Panel ${String.fromCharCode(65 + n)}`, [f[0] + 40, 91, f[2] - 40, 102], 11)
    for (let i = 0; i < 3; i++) {
      line(String(i), [f[0] + 5 + i * 55, 214, f[0] + 13 + i * 55, 224])
      line(String(i), [f[0] - 17, 125 + i * 32, f[0] - 9, 135 + i * 32])
    }
    line('Axis', [f[0] + 55, 229, f[2] - 55, 239])
    line('Y', [f[0] - 35, 150, f[0] - 25, 165], 10, false)
  })
  paint([78, 59, 533, 91])
  paint([86, 64, 95, 68])
  line(
    'Shared legend uses ordinary native words and complete independent physical boundaries.',
    [105, 61, 520, 69],
    8
  )
  line('Second series', [105, 73, 180, 81], 8)
  return { page, caption, captions: [caption], frames, tokens, owned: [65, 72, 563, 240] }
}
it('completes a separately boxed shared legend without cutting crossed complete native paint', () => {
  const f = closedSharedLegend(),
    before = structuredClone(f),
    actual = nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      [],
      [],
      f.frames,
      f.tokens,
      f.owned
    )
  expect(actual?.caption).toBe(f.caption)
  expect(actual?.graphicsCount).toBe(3)
  expect(actual?.rect).toEqual([52, 50, 570, (253 / 800) * 800])
  expect(f).toEqual(before)
})
it('preserves an already complete associated plate rather than replacing its existing owner', () => {
  const f = closedSharedLegend(),
    actual = associateFigures(f.page, f.captions, [], [], f.frames, f.tokens)
  expect(actual).toHaveLength(1)
  expect(actual[0].caption).toBe(f.caption)
  expect(actual[0].rect.slice(0, 3)).toEqual([52, 50, 570])
  expect(actual[0].rect[3]).toBeCloseTo(253, 10)
  expect(actual[0].graphicsCount).toBe(15)
})
it.each([
  'missing-owned',
  'missing-legend',
  'missing-face',
  'misaligned-face',
  'unequal-face',
  'fifth-frame',
  'different-page',
  'foreign-caption',
  'foreign-table',
  'foreign-image',
  'distant-container',
  'caption-overlap',
  'crossing-paint',
  'foreign-prose',
  'duplicate-container',
  'legend-gap-paint',
  'face-gap-paint',
  'duplicate-legend-stroke',
  'missing-font',
  'missing-height',
  'wrong-height',
  'missing-baseline',
  'nonfinite-baseline',
  'clipped-font',
  'duplicate-font',
  'missing-axis',
  'no-interior-paint',
  'invalid-graphics',
  'unknown-paint'
])('refuses shared legend completion without every independent source owner: %s', (reason) => {
  const f = closedSharedLegend(),
    tables: number[][] = []
  const addPaint = (r: number[], kind = 'path'): void => {
    f.page.graphicsBounds.push({ kind, normalizedRect: r.map((v, n) => v / (n % 2 ? 800 : 600)) })
  }
  if (reason === 'missing-legend') f.frames.shift()
  if (reason === 'missing-face') f.frames.pop()
  if (reason === 'misaligned-face') f.frames[2][1] += 0.1
  if (reason === 'unequal-face') f.frames[2][2] += 0.1
  if (reason === 'fifth-frame') f.frames.push([90, 65, 140, 75])
  if (reason === 'different-page') f.caption.page = 2
  if (reason === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 2: Independent plate.'], rect: [100, 65, 200, 75] })
  if (reason === 'foreign-table') tables.push([100, 65, 200, 75])
  if (reason === 'foreign-image') addPaint([100, 65, 200, 75], 'image')
  if (reason === 'distant-container') f.page.graphicsBounds[0].normalizedRect[1] = 20 / 800
  if (reason === 'caption-overlap') f.page.graphicsBounds[0].normalizedRect[3] = 281 / 800
  if (reason === 'crossing-paint') addPaint([20, 60, 130, 75])
  if (reason === 'foreign-prose') {
    f.page.lines.push({
      text: 'Independent ordinary text in the empty title corridor',
      x: 90,
      y: 86,
      width: 410,
      height: 10,
      fontSize: 10
    })
    f.tokens.push({
      text: 'Independent ordinary text in the empty title corridor',
      rect: [90, 86, 500, 96],
      height: 10,
      baseline: 96,
      horizontal: true
    })
  }
  if (reason === 'duplicate-container')
    f.page.graphicsBounds.push(structuredClone(f.page.graphicsBounds[0]))
  if (reason === 'legend-gap-paint') addPaint([140, 87, 250, 90])
  if (reason === 'face-gap-paint') addPaint([110, 99, 150, 102])
  if (reason === 'duplicate-legend-stroke')
    f.page.graphicsBounds.push(structuredClone(f.page.graphicsBounds.at(-2)))
  const font = f.tokens.find((t: ReturnType<typeof JSON.parse>) => t.text === 'Second series')
  if (reason === 'missing-font') f.tokens.splice(f.tokens.indexOf(font), 1)
  if (reason === 'missing-height') delete font.height
  if (reason === 'wrong-height') font.height = 1
  if (reason === 'missing-baseline') delete font.baseline
  if (reason === 'nonfinite-baseline') font.baseline = NaN
  if (reason === 'clipped-font') font.rect[3] -= 0.1
  if (reason === 'duplicate-font') f.tokens.push(structuredClone(font))
  if (reason === 'missing-axis')
    f.tokens = f.tokens.filter(
      (t: ReturnType<typeof JSON.parse>) => !(t.rect[1] > 210 && t.rect[0] > 100 && t.rect[2] < 230)
    )
  if (reason === 'no-interior-paint') f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 1)
  if (reason === 'invalid-graphics') f.page.invalidGraphicsBounds = 1
  if (reason === 'unknown-paint') addPaint([140, 87, 250, 90], 'unobserved-paint')
  expect(
    nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      tables,
      [],
      f.frames,
      f.tokens,
      reason === 'missing-owned' ? undefined : f.owned
    )
  ).toBeUndefined()
})
const spectra = (): ReturnType<typeof JSON.parse> => {
  const f = input()
  f.caption.rect = [40, 650, 560, 662]
  f.page.lines = [{ text: f.caption.lines[0], x: 40, y: 650, width: 520, height: 10, fontSize: 10 }]
  f.captions = [f.caption]
  f.page.graphicsBounds = []
  f.rules = []
  for (const top of [80, 280, 480]) {
    f.rules.push(
      [80, top, 520, top],
      [80, top + 140, 520, top + 140],
      [80, top, 80, top + 140],
      [520, top, 520, top + 140]
    )
    for (let i = 0; i < 5; i++) {
      f.page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: [85, top + 10 + i * 5, 515, top + 100 + i * 4].map(
          (v, n) => v / (n % 2 ? 800 : 600)
        )
      })
      f.page.lines.push({
        text: String(i),
        x: 65,
        y: top + 15 + i * 20,
        width: 8,
        height: 8,
        fontSize: 8
      })
    }
    f.page.lines.push({
      text: Array.from({ length: 15 }, (_, i) => (100 + i / 10).toFixed(2)).join(' '),
      x: 65,
      y: top + 142,
      width: 440,
      height: 8,
      fontSize: 8
    })
  }
  return f
}
it('keeps all closed spectra when native numeric wavelength ticks are merged into long axis rows', () => {
  const f = spectra(),
    r = nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules)
  expect(r?.rect[1]).toBeLessThanOrEqual(80)
  expect(r?.rect[3]).toBeGreaterThanOrEqual(628)
})
it.each(['body-text', 'nonmonotonic', 'outside-axis', 'foreign-table'])(
  'does not exempt an unproved long numeric row from the plot prose barrier: %s',
  (reason) => {
    const f = spectra(),
      row = f.page.lines.find((l: ReturnType<typeof JSON.parse>) => l.text.length > 60)
    if (reason === 'body-text') row.text += ' describes the separate experiment.'
    if (reason === 'nonmonotonic') row.text = row.text.split(' ').reverse().join(' ')
    if (reason === 'outside-axis') row.y -= 30
    const r = nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      reason === 'foreign-table' ? [[80, 220, 520, 235]] : [],
      f.rules
    )
    // The lower pair remains independently valid; the unproved upper row
    // must not be borrowed into its shared-caption band.
    expect(r?.rect[1] ?? Infinity).toBeGreaterThan(80)
  }
)
const keyedUnequalGrid = (): ReturnType<typeof JSON.parse> => {
  const f = input()
  f.caption.lines = ['Figure 1. Panels (a) to (d), with (e) and (f), show the measured curves.']
  f.caption.rect = [40, 470, 500, 482]
  f.captions = [f.caption]
  f.page.lines = [{ text: f.caption.lines[0], x: 40, y: 470, width: 460, height: 10, fontSize: 10 }]
  f.page.graphicsBounds = []
  f.rules = []
  f.frames = [
    [80, 60, 120, 160],
    [135, 60, 175, 160],
    [190, 60, 230, 160],
    [245, 60, 285, 160],
    [95, 210, 270, 310],
    [95, 345, 270, 445]
  ]
  f.tokens = []
  f.frames.forEach((r: number[], n: number) => {
    const text = `(${String.fromCharCode(97 + n)})`
    f.tokens.push({
      text,
      rect: [r[0] + 1, r[1] - 1, r[0] + 11, r[1] + 9],
      height: 10,
      horizontal: true
    })
    for (let i = 0; i < 4; i++)
      f.page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: [r[0] + 3, r[1] + 10 + i * 3, r[2] - 3, r[3] - 10 - i * 3].map(
          (v, j) => v / (j % 2 ? 800 : 600)
        )
      })
    f.page.lines.push({ text: '0', x: r[0] - 8, y: r[1] + 30, width: 6, height: 8, fontSize: 8 })
  })
  f.page.lines.push(
    { text: '(a) (b) (c) (d)', x: 81, y: 59, width: 175, height: 10, fontSize: 10 },
    { text: '(e)', x: 96, y: 209, width: 10, height: 10, fontSize: 10 },
    { text: '(f)', x: 96, y: 344, width: 10, height: 10, fontSize: 10 }
  )
  return f
}
it('keeps a finite unequal scientific grid only with complete native caption-keyed closed faces', () => {
  const f = keyedUnequalGrid(),
    r = nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], [], f.frames, f.tokens)
  expect(r?.rect[1]).toBeLessThanOrEqual(59)
  expect(r?.rect[3]).toBeGreaterThanOrEqual(445)
})
it.each([
  'missing-key',
  'duplicate-key',
  'missing-curve',
  'foreign-caption',
  'foreign-table',
  'unproved-frame'
])('declines an unequal scientific grid with incomplete native ownership: %s', (reason) => {
  const f = keyedUnequalGrid()
  if (reason === 'missing-key') f.tokens.shift()
  if (reason === 'duplicate-key') f.tokens[1].text = '(a)'
  if (reason === 'missing-curve') f.page.graphicsBounds.splice(0, 4)
  if (reason === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 2. Independent.'], rect: [100, 180, 250, 192] })
  expect(
    nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      reason === 'foreign-table' ? [[80, 60, 120, 160]] : [],
      [],
      reason === 'unproved-frame' ? f.frames.slice(1) : f.frames,
      f.tokens
    )
  ).toBeUndefined()
})
it('preserves both closed populated native plots under one short caption', () => {
  const f = input(),
    r = associateFigures(f.page, f.captions, [], f.rules)
  expect(r[0].rect[2]).toBeGreaterThanOrEqual(500)
  expect(r[0].rect[0]).toBeLessThanOrEqual(85)
})
it('preserves both vertically stacked closed plots above their shared caption', () => {
  const f = input()
  f.rules = f.rules.slice(0, 4)
  f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 4)
  f.page.lines = f.page.lines.slice(0, 7)
  f.rules.push(
    [100, 270, 270, 270],
    [100, 450, 270, 450],
    [100, 270, 100, 450],
    [270, 270, 270, 450]
  )
  for (const g of [...f.page.graphicsBounds])
    f.page.graphicsBounds.push({
      ...g,
      normalizedRect: g.normalizedRect.map((v: number, i: number) => v + (i % 2 ? 210 / 800 : 0))
    })
  for (const l of f.page.lines.slice(1)) f.page.lines.push({ ...l, y: l.y + 210 })
  f.caption.rect = [40, 490, 450, 502]
  f.captions[1].rect = [40, 570, 240, 582]
  f.page.lines[0] = {
    text: f.caption.lines[0],
    x: 40,
    y: 490,
    width: 410,
    height: 10,
    fontSize: 10
  }
  const r = associateFigures(f.page, f.captions, [], f.rules)
  expect(r[0].rect).toBeDefined()
  expect(r[0].rect[1]).toBeLessThan(70)
  expect(r[0].rect[3]).toBeGreaterThan(450)
})

it('preserves a finite four-by-four populated plot grid before the nearest bar-chart match', () => {
  const f = input()
  f.page.lines = [f.page.lines[0]]
  f.page.graphicsBounds = []
  f.rules = []
  f.caption.rect = [40, 620, 560, 632]
  f.page.lines[0] = { ...f.page.lines[0], y: 620, width: 520 }
  f.captions = [f.caption]
  for (const top of [70, 205, 340, 475]) {
    for (const left of [80, 200, 320, 440]) {
      f.rules.push(
        [left, top, left + 90, top],
        [left, top + 100, left + 90, top + 100],
        [left, top, left, top + 100],
        [left + 90, top, left + 90, top + 100]
      )
      for (let i = 0; i < 4; i++) {
        f.page.graphicsBounds.push({
          kind: 'path',
          normalizedRect: [left + 5, top + 8 + i * 5, left + 85, top + 40 + i * 5].map(
            (v, j) => v / (j % 2 ? 800 : 600)
          )
        })
        f.page.lines.push({
          text: String(i),
          x: left - 12,
          y: top + 10 + i * 20,
          width: 8,
          height: 7,
          fontSize: 7
        })
      }
    }
  }
  const r = associateFigures(f.page, f.captions, [], f.rules)
  expect(r[0].rect[1]).toBeLessThanOrEqual(70)
  expect(r[0].rect[3]).toBeGreaterThanOrEqual(575)
  const proof = nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules)
  expect(proof?.rect[1]).toBeLessThanOrEqual(70)
  const missing = structuredClone(f)
  missing.page.graphicsBounds = missing.page.graphicsBounds.slice(4)
  expect(
    nativeCaptionedPlotBand(missing.page, missing.caption, missing.captions, [], missing.rules)
  ).toBeUndefined()
})

it.each([
  'missing-edge',
  'missing-curves',
  'missing-ticks',
  'foreign-prose',
  'competing-caption',
  'foreign-table'
])('declines incomplete native plot ownership: %s', (reason) => {
  const f = input()
  if (reason === 'missing-edge') f.rules.pop()
  if (reason === 'missing-curves') f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 4)
  if (reason === 'missing-ticks')
    f.page.lines = f.page.lines.filter((l: ReturnType<typeof JSON.parse>) => l.x < 300)
  if (reason === 'foreign-prose')
    f.page.lines.push({
      text: 'Independent paragraph text. '.repeat(4),
      x: 110,
      y: 120,
      width: 360,
      height: 10,
      fontSize: 10
    })
  if (reason === 'competing-caption')
    f.captions.push({ page: 1, lines: ['Figure 2: Independent.'], rect: [330, 180, 490, 192] })
  expect(
    nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      reason === 'foreign-table' ? [[330, 80, 490, 230]] : [],
      f.rules
    )
  ).toBeUndefined()
})

const token = (
  text: string,
  rect: number[],
  height = 8,
  horizontal = true
): ReturnType<typeof JSON.parse> => ({ text, rect, height, horizontal, baseline: rect[3] })
const measuredStack = (): ReturnType<typeof JSON.parse> => {
  const f = spectra()
  f.caption.lines = ['Figure 1. Heights are labeled in arcseconds and in km.']
  f.page.lines[0].text = f.caption.lines[0]
  f.tokens = []
  for (const top of [80, 280, 480])
    for (let i = 0; i < 6; i++) {
      const y = top + 45 + i * 15
      f.tokens.push(
        token((i / 10).toFixed(1), [525, y, 534, y + 6], 6),
        token('′′', [534.01, y - 0.4, 537, y + 3.8], 4.2),
        token(`(${i * 80} km)`, [539.2, y, 566, y + 6], 6)
      )
      f.page.lines.push({
        text: `${(i / 10).toFixed(1)}′′ (${i * 80} km)`,
        x: 525,
        y,
        width: 41,
        height: 6,
        fontSize: 6
      })
    }
  return f
}
it('retains complete repeated native measurement-unit chains beside every populated closed face', () => {
  const f = measuredStack()
  expect(
    nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, [], f.tokens)?.rect[2]
  ).toBeGreaterThanOrEqual(566)
  expect(
    associateFigures(f.page, f.captions, [], f.rules, [], f.tokens)[0].rect[2]
  ).toBeGreaterThanOrEqual(566)
})
it('does not use another page caption as a barrier to same-page native measurement chains', () => {
  const f = measuredStack()
  f.captions.push({ page: 2, lines: ['Figure 2. Independent.'], rect: [550, 100, 580, 120] })
  expect(
    nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, [], f.tokens)?.rect[2]
  ).toBeGreaterThanOrEqual(566)
})
it('keeps repeated measurement units despite already owned close-fitting native plot path extents', () => {
  const f = measuredStack()
  for (const top of [80, 280, 480])
    f.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [65 / 600, (top - 30) / 800, 570 / 600, (top + 170) / 800]
    })
  expect(
    nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, [], f.tokens)?.rect[2]
  ).toBeGreaterThanOrEqual(566)
})
it.each(['competing-container', 'foreign-small-path', 'foreign-same-size-path'])(
  'does not ignore independent path paint merely because a plot has an outer context: %s',
  (reason) => {
    const f = measuredStack()
    for (const top of [80, 280, 480])
      f.page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: [65 / 600, (top - 30) / 800, 570 / 600, (top + 170) / 800]
      })
    const rect =
      reason === 'competing-container'
        ? [65, 50, 570, 250]
        : reason === 'foreign-same-size-path'
          ? [552, 50, 1057, 250]
          : [552, 100, 580, 120]
    f.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: rect.map((v, n) => v / (n % 2 ? 800 : 600))
    })
    expect(
      nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, [], f.tokens)?.rect[2] ??
        0
    ).toBeLessThan(566)
  }
)
it.each([
  'missing-quote',
  'wrong-baseline',
  'wrong-unit',
  'lexical-prose',
  'missing-number',
  'incomplete-peer',
  'mismatched-sequence',
  'duplicate-quote',
  'far-gutter',
  'missing-font',
  'foreign-token',
  'foreign-caption',
  'foreign-table',
  'foreign-paint',
  'missing-edge'
])('does not extend a closed stack to unproved measurement tails: %s', (reason) => {
  const f = measuredStack()
  if (reason === 'missing-quote') f.tokens.splice(1, 1)
  if (reason === 'wrong-baseline') f.tokens[2].baseline += 2
  if (reason === 'wrong-unit') f.tokens[2].text = '(0 m)'
  if (reason === 'lexical-prose') f.tokens[2].text = '(the height)'
  if (reason === 'missing-number') f.tokens.shift()
  if (reason === 'incomplete-peer') f.tokens.splice(20, 1)
  if (reason === 'mismatched-sequence') f.tokens[18].text = '9.0'
  if (reason === 'duplicate-quote') f.tokens.push({ ...f.tokens[1] })
  if (reason === 'far-gutter')
    for (const t of f.tokens) t.rect = t.rect.map((v: number, i: number) => (i % 2 ? v : v + 40))
  if (reason === 'missing-font') delete f.tokens[2].height
  if (reason === 'foreign-token') f.tokens.push(token('Independent text', [552, 101, 580, 109], 8))
  if (reason === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 2. Independent.'], rect: [550, 100, 580, 120] })
  if (reason === 'foreign-paint')
    f.page.graphicsBounds.push({
      kind: 'image',
      normalizedRect: [552 / 600, 100 / 800, 580 / 600, 120 / 800]
    })
  if (reason === 'missing-edge') f.rules = f.rules.filter((_: number[], n: number) => n % 4 !== 3)
  expect(
    nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      reason === 'foreign-table' ? [[550, 100, 580, 120]] : [],
      f.rules,
      [],
      f.tokens
    )?.rect[2] ?? 0
  ).toBeLessThan(566)
})
it('uses a native running separator when the graphics filter already omitted its stroke', () => {
  const f = input()
  f.page.pageNumber = 4
  f.page.lines.push({
    text: '4 Independent running title',
    x: 40,
    y: 30,
    width: 500,
    height: 8,
    fontSize: 8
  })
  const tokens = [
    token('4', [40, 30, 44, 38]),
    token('Independent running title', [410, 30, 540, 38])
  ]
  const proof = nativeFigureRunningHead(f.page, f.captions, tokens, [[40, 48, 540, 48]])
  expect(proof?.lines).toContain(f.page.lines.at(-1))
  for (const reason of ['missing-rule', 'competing-rule', 'caption-in-band', 'image-in-band']) {
    const g = structuredClone(f),
      rules = reason === 'missing-rule' ? [] : [[40, 48, 540, 48]]
    if (reason === 'competing-rule') rules.push([40, 47, 540, 47])
    if (reason === 'caption-in-band') g.captions[0].rect = [40, 30, 540, 38]
    if (reason === 'image-in-band')
      g.page.graphicsBounds.push({ kind: 'image', normalizedRect: [0.06, 0.03, 0.95, 0.055] })
    expect(nativeFigureRunningHead(g.page, g.captions, tokens, rules)).toBeUndefined()
  }
})
const categories = (): ReturnType<typeof JSON.parse> => {
  const f = input()
  f.rules = f.rules.slice(0, 4)
  f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 4)
  f.tokens = [
    token('Category alpha', [45, 85, 98, 95], 6, false),
    token('Category beta', [50, 120, 98, 130], 6, false),
    token('Category gamma', [48, 155, 98, 165], 6, false),
    token('Axis title', [34, 80, 42, 190], 8, false),
    token('a', [34, 42, 42, 54], 12),
    ...Array.from({ length: 4 }, (_, i) =>
      token(String(i), [105 + i * 35, 242, 109 + i * 35, 248], 6)
    )
  ]
  return f
}
it('keeps repeated slanted categories, adjacent vertical title and their panel marker', () => {
  const f = categories(),
    rect = [99, 60, 270, 260]
  const owned = nativeClosedCategoryLabels(
    f.page,
    f.caption,
    f.captions,
    [],
    rect,
    f.rules,
    f.tokens
  )
  expect(Math.min(...owned.map((r: number[]) => r[0]))).toBe(34)
  expect(Math.min(...owned.map((r: number[]) => r[1]))).toBe(42)
})
it.each([
  'missing-edge',
  'single-category',
  'missing-ticks',
  'ambiguous-title',
  'foreign-prose',
  'table-owner'
])('rejects incomplete category-axis ownership: %s', (reason) => {
  const f = categories()
  if (reason === 'missing-edge') f.rules.pop()
  if (reason === 'single-category')
    f.tokens = f.tokens.filter(
      (t: ReturnType<typeof JSON.parse>) => !['Category beta', 'Category gamma'].includes(t.text)
    )
  if (reason === 'missing-ticks')
    f.tokens = f.tokens.filter((t: ReturnType<typeof JSON.parse>) => !/^[0-9]$/.test(t.text))
  if (reason === 'ambiguous-title') f.tokens.push(token('Second axis', [32, 90, 40, 195], 8, false))
  if (reason === 'foreign-prose')
    f.tokens.push(token('Independent body paragraph text. '.repeat(3), [30, 110, 99, 122], 10))
  expect(
    nativeClosedCategoryLabels(
      f.page,
      f.caption,
      f.captions,
      reason === 'table-owner' ? [[30, 60, 99, 230]] : [],
      [99, 60, 270, 260],
      f.rules,
      f.tokens
    )
  ).toEqual([])
})
it('recognizes only repeated native paragraph continuity above drawing ink', () => {
  const lines = [0, 1, 2, 3].map((i) => ({
    text:
      i === 3
        ? 'Short final line.'
        : 'Independent prose paragraph with many source words in the same printed block.'.repeat(2),
    x: 40,
    y: 40 + i * 13,
    width: i === 3 ? 100 : 440,
    height: 10,
    fontSize: 10
  }))
  expect(nativeTopParagraphTail(lines[3], [70, 110, 470, 250], lines)).toBe(true)
  expect(nativeTopParagraphTail(lines[3], [70, 80, 470, 250], lines)).toBe(false)
  expect(
    nativeTopParagraphTail(
      lines[3],
      [70, 110, 470, 250],
      lines.map((l) => ({ ...l, text: 'Short chart title' }))
    )
  ).toBe(false)
  expect(
    nativeTopParagraphTail(
      lines[3],
      [70, 110, 470, 250],
      lines.filter((_, i) => i !== 1)
    )
  ).toBe(false)
})
const nodes = (): ReturnType<typeof JSON.parse> => {
  const f = input()
  f.caption.rect = [40, 220, 540, 232]
  f.page.lines[0] = {
    text: f.caption.lines[0],
    x: 40,
    y: 220,
    width: 500,
    height: 10,
    fontSize: 10
  }
  f.page.graphicsBounds = []
  f.rules = []
  f.tokens = []
  for (let i = 0; i < 4; i++) {
    const x = 110 + i * 90
    f.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [x / 600, 175 / 800, (x + 10) / 600, 185 / 800]
    })
    f.tokens.push(
      token('Label', [x - 5, 152, x + 15, 160]),
      token('Value', [x - 5, 194, x + 15, 202])
    )
    if (i < 3) f.rules.push([x + 10, 180, x + 90, 180])
  }
  return f
}
it('recovers a sparse aligned native-node diagram with complete upper/lower labels', () => {
  const f = nodes()
  expect(
    nativeAlignedNodeFigure(f.page, f.caption, f.captions, [], f.rules, f.tokens)?.rect
  ).toEqual([105, 152, 395, 202])
})
it.each([
  'missing-connector',
  'missing-upper-label',
  'foreign-prose',
  'table-owner',
  'unaligned-node'
])('declines a sparse chain without full native proof: %s', (reason) => {
  const f = nodes()
  if (reason === 'missing-connector') f.rules = []
  if (reason === 'missing-upper-label') f.tokens.shift()
  if (reason === 'foreign-prose')
    f.tokens.push(token('Independent paragraph. '.repeat(4), [100, 170, 405, 180], 10))
  if (reason === 'unaligned-node') f.page.graphicsBounds[0].normalizedRect[1] -= 0.01
  expect(
    nativeAlignedNodeFigure(
      f.page,
      f.caption,
      f.captions,
      reason === 'table-owner' ? [[100, 170, 405, 205]] : [],
      f.rules,
      f.tokens
    )
  ).toBeUndefined()
})
it('declines disjoint-column ownership without repeated numeric source and curve objects', () => {
  const f = input()
  f.captions.push({ page: 1, lines: ['Figure 2: Adjacent curves.'], rect: [330, 280, 540, 292] })
  expect(nativeDisjointPlotColumn(f.page, f.caption, f.captions, [], [])).toBeUndefined()
})

const columns = (): ReturnType<typeof JSON.parse> => {
  const f = input()
  f.caption.rect = [40, 280, 290, 292]
  f.page.lines[0].width = 250
  f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 4)
  f.page.lines = f.page.lines.slice(0, 7)
  f.captions.push({
    page: 1,
    lines: ['Figure 2: Independent right plot.'],
    rect: [330, 280, 560, 292]
  })
  f.tokens = f.page.lines
    .slice(1)
    .map((l: ReturnType<typeof JSON.parse>) =>
      token(l.text, [l.x, l.y, l.x + l.width, l.y + l.height], l.fontSize)
    )
  return f
}
it('recovers a whole populated column without swallowing the adjacent caption column', () => {
  const f = columns(),
    r = nativeDisjointPlotColumn(f.page, f.caption, f.captions, [], f.tokens)
  expect(r?.rect).toEqual([85, 59, 271, 255])
})
it.each(['missing-ticks', 'missing-curves', 'no-disjoint-caption', 'foreign-prose', 'table-owner'])(
  'declines unproven column ownership: %s',
  (reason) => {
    const f = columns()
    if (reason === 'missing-ticks') f.tokens = []
    if (reason === 'missing-curves') f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 1)
    if (reason === 'no-disjoint-caption') f.captions = f.captions.slice(0, 2)
    if (reason === 'foreign-prose')
      f.tokens.push(token('Independent paragraph text. '.repeat(3), [90, 100, 270, 110], 10))
    expect(
      nativeDisjointPlotColumn(
        f.page,
        f.caption,
        f.captions,
        reason === 'table-owner' ? [[100, 100, 250, 220]] : [],
        f.tokens
      )
    ).toBeUndefined()
  }
)

it('keeps a decoded painted raster in its independent caption column despite caption scripts', async () => {
  const { nativeRasterCaptionColumn } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-raster-column.mjs')).href
  )
  const f = input()
  f.caption.rect = [320, 280, 550, 300]
  f.page.lines = [
    { text: f.caption.lines[0], x: 320, y: 280, width: 230, height: 10, fontSize: 10 },
    { text: 'index', x: 380, y: 289, width: 10, height: 6, fontSize: 6 }
  ]
  f.captions[1].rect = [40, 60, 290, 110]
  f.page.graphicsBounds = [
    {
      kind: 'image',
      normalizedRect: [0.5, 0.02, 0.95, 0.34],
      paintedNormalizedRect: [0.55, 0.06, 0.935, 0.33]
    }
  ]
  expect(nativeRasterCaptionColumn(f.page, f.caption, f.captions, [])?.rect).toEqual([
    330, 48, 561, 264
  ])
  const unpainted = structuredClone(f)
  delete unpainted.page.graphicsBounds[0].paintedNormalizedRect
  expect(
    nativeRasterCaptionColumn(unpainted.page, unpainted.caption, unpainted.captions, [])
  ).toBeUndefined()
  expect(
    nativeRasterCaptionColumn(f.page, f.caption, f.captions, [[330, 100, 550, 250]])
  ).toBeUndefined()
  const ambiguous = structuredClone(f)
  ambiguous.captions[1].rect = [330, 80, 540, 110]
  expect(
    nativeRasterCaptionColumn(ambiguous.page, ambiguous.caption, ambiguous.captions, [])
  ).toBeUndefined()
})

const titledGrid = (): ReturnType<typeof JSON.parse> => {
  const page: {
      pageNumber: number
      width: number
      height: number
      lines: ReturnType<typeof JSON.parse>[]
      graphicsBounds: ReturnType<typeof JSON.parse>[]
    } = { pageNumber: 1, width: 600, height: 800, lines: [], graphicsBounds: [] },
    caption = {
      page: 1,
      lines: ['Figure 3: Eight independent complete native panels.'],
      rect: [50, 380, 560, 392]
    },
    frames: number[][] = [],
    rules: number[][] = [],
    tokens: ReturnType<typeof JSON.parse>[] = []
  page.lines.push({ text: caption.lines[0], x: 50, y: 380, width: 510, height: 10, fontSize: 10 })
  for (let n = 0; n < 8; n++) {
    const center = 125 + (n % 4) * 125,
      top = n < 4 ? 70 : 230,
      width = n < 4 ? 110 : 98,
      r = [center - width / 2, top, center + width / 2, top + 100]
    frames.push(r)
    rules.push(
      [r[0], r[1], r[2], r[1]],
      [r[0], r[3], r[2], r[3]],
      [r[0], r[1], r[0], r[3]],
      [r[2], r[1], r[2], r[3]]
    )
    const title = {
      text: String.fromCharCode(97 + n) + ') Native panel',
      x: center - 25,
      y: top - 18,
      width: 50,
      height: 8,
      fontSize: 8
    }
    page.lines.push(title)
    tokens.push(
      token(title.text, [title.x, title.y, title.x + title.width, title.y + title.height], 8)
    )
    for (let i = 0; i < 4; i++)
      page.lines.push({
        text: String(i),
        x: r[0] - 12,
        y: top + 10 + i * 20,
        width: 8,
        height: 8,
        fontSize: 8
      })
    for (let i = 0; i < 3; i++)
      page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: [
          (r[0] + 8 + i * 2) / 600,
          (top + 20 + i * 10) / 800,
          (r[2] - 8) / 600,
          (top + 70 + i * 5) / 800
        ]
      })
  }
  return { page, caption, captions: [caption], frames, rules, tokens }
}

const translatedNineGrid = (): ReturnType<typeof JSON.parse> => {
  const page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: [] as ReturnType<typeof JSON.parse>[],
      graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
    },
    caption = {
      page: 1,
      lines: ['Figure 4: Nine independent complete native measurements.'],
      rect: [50, 540, 560, 552]
    },
    frames: number[][] = [],
    tokens: ReturnType<typeof JSON.parse>[] = []
  page.lines.push({ text: caption.lines[0], x: 50, y: 540, width: 510, height: 10, fontSize: 10 })
  for (let column = 0; column < 3; column++)
    for (let row = 0; row < 3; row++) {
      const left = 100 + column * 160,
        top = 100 + row * 150 + [0, 0.8, -1.6][column],
        r = [left, top, left + 110, top + 90]
      frames.push(r)
      for (let i = 0; i < 5; i++) {
        const l = {
          text: String(i),
          x: left - 14,
          y: top + 8 + i * 15,
          width: 6,
          height: 6,
          fontSize: 6
        }
        page.lines.push(l)
        tokens.push(token(l.text, [l.x, l.y, l.x + l.width, l.y + l.height], 6))
      }
      for (let i = 0; i < 3; i++)
        page.graphicsBounds.push({
          kind: 'path',
          normalizedRect: [
            (left + 5 + i) / 600,
            (top + 10 + i * 5) / 800,
            (left + 105) / 600,
            (top + 70 + i * 3) / 800
          ]
        })
    }
  frames.push([110, 40, 520, 60])
  for (const [text, x] of [
    ['Independent series', 130],
    ['Comparison series', 330]
  ] as const) {
    const l = { text, x, y: 45, width: 100, height: 6, fontSize: 6 }
    page.lines.push(l)
    tokens.push(token(text, [x, 45, x + 100, 51], 6))
  }
  return { page, caption, captions: [caption], frames, rules: [], tokens }
}

const compactFacetedGrid = (): ReturnType<typeof JSON.parse> => {
  const page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      renderRotation: 0,
      invalidGraphicsBounds: 0,
      lines: [] as ReturnType<typeof JSON.parse>[],
      graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
    },
    caption = {
      page: 1,
      lines: ['Figure 1: Independent faceted measurements.'],
      rect: [60, 630, 540, 642]
    },
    tokens: ReturnType<typeof JSON.parse>[] = [],
    operators: ReturnType<typeof JSON.parse> = { fnArray: [], argsArray: [] },
    viewport = { width: 600, height: 800, rotation: 0, transform: [1, 0, 0, -1, 0, 800] },
    add = (op: number, args: ReturnType<typeof JSON.parse>): void => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    },
    line = (text: string, rect: number[], font: number): void => {
      page.lines.push({
        text,
        x: rect[0],
        y: rect[1],
        width: rect[2] - rect[0],
        height: rect[3] - rect[1],
        fontSize: font
      })
      tokens.push({ text, rect, horizontal: true, baseline: rect[3], height: font })
    },
    frame = (rect: number[]): void => {
      const [left, top, right, bottom] = rect,
        y0 = 800 - bottom,
        y1 = 800 - top,
        native = new Float32Array([left, y0, right, y1])
      page.graphicsBounds.push({
        kind: 'path',
        operationIndex: operators.fnArray.length,
        normalizedRect: rect.map((v, n) => v / (n % 2 ? 800 : 600))
      })
      add(OPS.constructPath, [
        OPS.fillStroke,
        [new Float32Array([0, left, y0, 1, right, y0, 1, right, y1, 1, left, y1, 4])],
        native
      ])
    }
  add(OPS.paintFormXObjectBegin, [
    new Float32Array([1, 0, 0, 1, 0, 0]),
    new Float32Array([0, 0, 600, 800])
  ])
  frame([60, 330, 540, 610])
  line(caption.lines[0], caption.rect, 12)
  for (let c = 0; c < 3; c++) {
    const left = 86 + c * 156,
      right = left + 130,
      carrier = [c === 0 ? 64 : 68 + c * 156, 334, 224 + c * 156, 608]
    frame(carrier)
    line(`Group ${c + 1}`, [left + 30, 340, left + 100, 348], 8)
    line('Measurements', [left + 30, 352, left + 100, 360], 8)
    for (let r = 0; r < 3; r++) {
      const top = 378 + r * 76,
        bottom = top + 58
      frame([left, top, right, bottom])
      frame([left, top - 12, right, top])
      line(`Series ${r + 1}`, [left + 45, top - 9, left + 85, top - 3], 6)
      for (let n = 0; n < 4; n++)
        line(String(80 - n * 20), [left - 13, top + 8 + n * 12, left - 5, top + 14 + n * 12], 6)
      for (let n = 0; n < 3; n++)
        frame([left + 20 + n * 24, bottom - 14 - n * 11, left + 24 + n * 24, bottom])
      if (r === 2) line('0 1 2 3 4', [left + 2, bottom + 4, right - 2, bottom + 10], 6)
    }
  }
  add(OPS.paintFormXObjectEnd, null)
  for (const t of tokens) {
    add(OPS.beginText, null)
    add(OPS.setFont, ['anonymous-font', t.height])
    add(OPS.setTextMatrix, [new Float32Array([1, 0, 0, 1, t.rect[0], 800 - t.baseline])])
    add(OPS.showText, [
      [...t.text].map((char) => ({
        originalCharCode: char.charCodeAt(0),
        fontChar: char,
        unicode: char,
        width: 100,
        isSpace: char === ' ',
        isInFont: true
      }))
    ])
    add(OPS.endText, null)
  }
  const frames = collectClosedFigureFrames(operators, viewport)
  return {
    page,
    caption,
    captions: [caption],
    tokens,
    frames,
    rules: [],
    owned: [241, 518, 548, 600],
    context: { operators, viewport }
  }
}

it('completes every compact faceted face and whole measured carrier using native operator context', () => {
  const f = compactFacetedGrid(),
    before = structuredClone(f),
    result = nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      [],
      f.rules,
      f.frames,
      f.tokens,
      f.owned,
      f.context
    )
  expect(result?.rect).toEqual([60, 330, 548, 610])
  expect(result?.graphicsCount).toBe(9)
  expect(f).toEqual(before)
})

it('forwards compact faceted source context through the actual association consumer', () => {
  const f = compactFacetedGrid(),
    figures = associateFigures(f.page, f.captions, [], f.rules, f.frames, f.tokens, f.context)
  expect(figures).toHaveLength(1)
  expect(figures[0].rect[0]).toBeLessThanOrEqual(60)
  expect(figures[0].rect[1]).toBeLessThanOrEqual(330)
  expect(figures[0].rect[3]).toBeGreaterThanOrEqual(610)
  expect(figures[0].graphicsCount).toBe(9)
})

it.each([
  'missing-face',
  'missing-strip',
  'missing-carrier',
  'missing-bar',
  'missing-font',
  'clipped-font',
  'invalid-font-baseline',
  'foreign-row',
  'unknown-paint',
  'oversized-paint',
  'foreign-right-padding-paint',
  'crossing-table',
  'competing-caption',
  'noncanonical-caption',
  'invalid-paint-index',
  'missing-context',
  'unknown-opcode',
  'shading',
  'invisible-text',
  'gstate',
  'type3-zero-program',
  'invalid-glyph-width',
  'reflected-transform',
  'unbalanced-save',
  'missing-form-box',
  'Float64-path',
  'DataView-form-box',
  'unknown-path-command',
  'truncated-path-command',
  'mismatched-viewport',
  'malformed-op-args'
])('refuses incomplete compact faceted source qualification: %s', (reason) => {
  const f = compactFacetedGrid(),
    tables: number[][] = [],
    operators = f.context.operators,
    index = operators.fnArray.indexOf(OPS.constructPath),
    glyph = operators.argsArray[operators.fnArray.indexOf(OPS.showText)][0][0],
    insert = (op: number, args: ReturnType<typeof JSON.parse>): void => {
      const at = operators.fnArray.indexOf(OPS.beginText)
      operators.fnArray.splice(at, 0, op)
      operators.argsArray.splice(at, 0, args)
    }
  if (reason === 'missing-face') f.frames.splice(2, 1)
  if (reason === 'missing-strip') f.frames.splice(3, 1)
  if (reason === 'missing-carrier') f.frames.splice(1, 1)
  if (reason === 'missing-bar') f.frames.splice(4, 1)
  if (reason === 'missing-font') f.tokens.splice(1, 1)
  if (reason === 'clipped-font') f.tokens[1].rect[3] -= 1
  if (reason === 'invalid-font-baseline') f.tokens[1].baseline = NaN
  if (reason === 'foreign-row') {
    f.page.lines.push({
      text: 'Foreign content',
      x: 300,
      y: 520,
      width: 40,
      height: 6,
      fontSize: 6
    })
    f.tokens.push({
      text: 'Foreign content',
      rect: [300, 520, 340, 526],
      height: 6,
      baseline: 526,
      horizontal: true
    })
  }
  if (reason === 'unknown-paint') f.page.graphicsBounds[0].kind = 'shading'
  if (reason === 'oversized-paint') f.page.graphicsBounds[0].normalizedRect[0] = 10 / 600
  if (reason === 'foreign-right-padding-paint')
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: 9999,
      normalizedRect: [542 / 600, 590 / 800, 547 / 600, 605 / 800]
    })
  if (reason === 'crossing-table') tables.push([60, 350, 120, 400])
  if (reason === 'competing-caption')
    f.captions.push({
      page: 1,
      lines: ['Figure 2: Other measurements.'],
      rect: [70, 365, 160, 377]
    })
  if (reason === 'noncanonical-caption') f.caption = structuredClone(f.caption)
  if (reason === 'invalid-paint-index') f.page.graphicsBounds[0].operationIndex = NaN
  if (reason === 'missing-context') f.context = undefined
  if (reason === 'unknown-opcode') insert(999999, null)
  if (reason === 'shading') insert(OPS.shadingFill, ['unobserved-shading'])
  if (reason === 'invisible-text') insert(OPS.setTextRenderingMode, [3])
  if (reason === 'gstate') insert(OPS.setGState, [[['CA', 0]]])
  if (reason === 'type3-zero-program') glyph.operatorListId = 0
  if (reason === 'invalid-glyph-width') glyph.width = NaN
  if (reason === 'reflected-transform') insert(OPS.transform, [-1, 0, 0, 1, 0, 0])
  if (reason === 'unbalanced-save') insert(OPS.save, null)
  if (reason === 'missing-form-box') operators.argsArray[0][1] = null
  if (reason === 'Float64-path')
    operators.argsArray[index][1][0] = new Float64Array(operators.argsArray[index][1][0])
  if (reason === 'DataView-form-box') operators.argsArray[0][1] = new DataView(new ArrayBuffer(16))
  if (reason === 'unknown-path-command') operators.argsArray[index][1][0][0] = 99
  if (reason === 'truncated-path-command')
    operators.argsArray[index][1][0] = new Float32Array([0, 10])
  if (reason === 'mismatched-viewport') f.context.viewport.transform[0] = 1.5
  if (reason === 'malformed-op-args') operators.argsArray.pop()
  const before = structuredClone(f),
    result = nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      tables,
      f.rules,
      f.frames,
      f.tokens,
      f.owned,
      f.context
    )
  expect(result?.graphicsCount).not.toBe(9)
  expect(f).toEqual(before)
})

it('preserves complete legacy association results when compact native context is absent or unsupported', () => {
  const f = compactFacetedGrid(),
    previous = associateFigures(f.page, f.captions, [], f.rules, f.frames, f.tokens)
  expect(associateFigures(f.page, f.captions, [], f.rules, f.frames, f.tokens, undefined)).toEqual(
    previous
  )
  f.context.operators.fnArray.unshift(OPS.setTextRenderingMode)
  f.context.operators.argsArray.unshift([3])
  expect(associateFigures(f.page, f.captions, [], f.rules, f.frames, f.tokens, f.context)).toEqual(
    previous
  )
})

it('retains every populated closed face and complete shared legend in a repeated translated three-by-three array', () => {
  const f = translatedNineGrid(),
    before = structuredClone(f),
    proof = nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, f.frames, f.tokens)
  expect(proof?.graphicsCount).toBe(9)
  expect(proof?.rect).toEqual([86, 40, 530, 490.8])
  const associated = associateFigures(f.page, f.captions, [], f.rules, f.frames, f.tokens)
  expect(associated[0].rect[1]).toBeLessThanOrEqual(40)
  expect(associated[0].rect[3]).toBeGreaterThanOrEqual(490.8)
  expect(f).toEqual(before)
})

it.each([
  'missing-face',
  'duplicate-face',
  'unequal-size',
  'nonrepeated-offset',
  'missing-paint',
  'missing-tick-font',
  'missing-orientation',
  'wrong-line-font',
  'clipped-tick-font',
  'missing-legend-font',
  'clipped-legend-font',
  'unframed-legend',
  'competing-legend',
  'unknown-font',
  'foreign-caption',
  'foreign-table',
  'foreign-prose'
])('refuses incomplete translated array or shared legend evidence: %s', (reason) => {
  const f = translatedNineGrid()
  if (reason === 'missing-face') f.frames.splice(0, 1)
  if (reason === 'duplicate-face') f.frames[1] = f.frames[0].slice()
  if (reason === 'unequal-size') f.frames[1][2] += 1
  if (reason === 'nonrepeated-offset') {
    f.frames[1][1] += 1
    f.frames[1][3] += 1
  }
  if (reason === 'missing-paint') f.page.graphicsBounds.splice(0, 3)
  if (reason === 'missing-tick-font') delete f.tokens[0].height
  if (reason === 'missing-orientation') delete f.tokens[0].horizontal
  if (reason === 'wrong-line-font') f.page.lines[1].fontSize = 5
  if (reason === 'clipped-tick-font') f.tokens[0].rect[3] -= 1
  if (reason === 'missing-legend-font') f.tokens.pop()
  if (reason === 'clipped-legend-font') f.tokens.at(-1).rect[3] -= 1
  if (reason === 'unframed-legend') f.frames.pop()
  if (reason === 'competing-legend') f.frames.push([110, 35, 520, 55])
  if (reason === 'unknown-font') f.tokens.push(token('Unowned source', [120, 110, 170, 116], 6))
  if (reason === 'foreign-caption')
    f.captions.push({
      page: 1,
      lines: ['Figure 5: Independent native owner.'],
      rect: [100, 150, 510, 162]
    })
  if (reason === 'foreign-prose')
    f.page.lines.push({
      text: 'Independent article paragraph. '.repeat(4),
      x: 100,
      y: 150,
      width: 400,
      height: 10,
      fontSize: 10
    })
  expect(
    nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      reason === 'foreign-table' ? [[100, 150, 500, 200]] : [],
      f.rules,
      f.frames,
      f.tokens
    )
  ).toBeUndefined()
})

it('retains all eight keyed closed plots with independently sized rows', () => {
  const f = titledGrid(),
    before = structuredClone(f),
    result = nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, f.frames, f.tokens)
  expect(result?.graphicsCount).toBe(8)
  for (const frame of f.frames) {
    expect(result?.rect[0]).toBeLessThanOrEqual(frame[0])
    expect(result?.rect[1]).toBeLessThanOrEqual(frame[1] - 18)
    expect(result?.rect[2]).toBeGreaterThanOrEqual(frame[2])
    expect(result?.rect[3]).toBeGreaterThanOrEqual(frame[3])
  }
  expect(f).toEqual(before)
})

it('binds each complete native title from its separate panel key and title glyph boxes', () => {
  const f = titledGrid()
  f.tokens = f.tokens.flatMap((item: ReturnType<typeof JSON.parse>) => [
    {
      ...item,
      text: item.text.slice(0, 2),
      rect: [item.rect[0], item.rect[1], item.rect[0] + 8, item.rect[3]]
    },
    {
      ...item,
      text: item.text.slice(3),
      rect: [item.rect[0] + 10, item.rect[1], item.rect[2], item.rect[3]]
    }
  ])
  const before = structuredClone(f)
  expect(
    nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, f.frames, f.tokens)
      ?.graphicsCount
  ).toBe(8)
  expect(f).toEqual(before)
  f.tokens[1].rect[2] += 1
  expect(
    nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, f.frames, f.tokens)
      ?.graphicsCount
  ).not.toBe(8)
})

it.each([
  'short-bottom',
  'short-top',
  'short-width',
  'wrong-height',
  'missing-height',
  'nonfinite-height',
  'missing-baseline',
  'nonfinite-baseline',
  'detached-baseline',
  'short-split-fragment'
])('requires complete native font geometry for each closed-grid title: %s', (reason) => {
  const f = titledGrid(),
    title = f.tokens[0]
  if (reason === 'short-bottom') title.rect[3] -= 1
  if (reason === 'short-top') title.rect[1] += 0.1
  if (reason === 'short-width') title.rect[2] -= 1
  if (reason === 'wrong-height') title.height = 1
  if (reason === 'missing-height') delete title.height
  if (reason === 'nonfinite-height') title.height = NaN
  if (reason === 'missing-baseline') delete title.baseline
  if (reason === 'nonfinite-baseline') title.baseline = NaN
  if (reason === 'detached-baseline') title.baseline -= 1
  if (reason === 'short-split-fragment') {
    f.tokens.splice(
      0,
      1,
      {
        ...title,
        text: 'a)',
        rect: [title.rect[0], title.rect[1], title.rect[0] + 8, title.rect[3]]
      },
      {
        ...title,
        text: 'Native panel',
        rect: [title.rect[0] + 10, title.rect[1], title.rect[2], title.rect[3] - 1]
      }
    )
  }
  expect(
    nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, f.frames, f.tokens)
      ?.graphicsCount
  ).not.toBe(8)
})

it.each([
  'missing-key',
  'duplicate-key',
  'nonserial-key',
  'missing-side',
  'foreign-caption',
  'foreign-table',
  'foreign-prose',
  'unpopulated-face',
  'misaligned-center'
])('requires complete independently keyed closed-grid ownership: %s', (reason) => {
  const f = titledGrid()
  if (reason === 'missing-key') {
    f.tokens.shift()
    f.page.lines.splice(1, 1)
  }
  if (reason === 'duplicate-key') f.tokens.push(structuredClone(f.tokens[0]))
  if (reason === 'nonserial-key') {
    f.tokens[0].text = 'j) Native panel'
    f.page.lines[1].text = f.tokens[0].text
  }
  if (reason === 'missing-side') {
    f.rules.splice(3, 1)
    f.frames.shift()
  }
  if (reason === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 4: Foreign panels.'], rect: [70, 185, 555, 197] })
  if (reason === 'foreign-prose')
    f.page.lines.push({
      text: 'A separate complete article paragraph crosses the claimed plot corridor.',
      x: 70,
      y: 185,
      width: 485,
      height: 10,
      fontSize: 10
    })
  if (reason === 'unpopulated-face') f.page.graphicsBounds.splice(0, 3)
  if (reason === 'misaligned-center') {
    f.tokens[0].rect[0] -= 25
    f.tokens[0].rect[2] -= 25
    f.page.lines[1].x -= 25
  }
  const result = nativeCaptionedPlotBand(
    f.page,
    f.caption,
    f.captions,
    reason === 'foreign-table' ? [[70, 185, 555, 210]] : [],
    f.rules,
    f.frames,
    f.tokens
  )
  expect(result?.graphicsCount).not.toBe(8)
})
