import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const {
  associateFigures,
  associateAdjacentFigure,
  resolveFigureCaption,
  associateGraphicalAbstract
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { excludeRepeatedMarginContent } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-graphics.mjs')).href
)
const page = {
  pageNumber: 1,
  width: 600,
  height: 800,
  rotation: 0,
  lines: [],
  invalidGraphicsBounds: 0
}
const graphic = (
  kind: string,
  normalizedRect: number[],
  imageHash?: string
): { kind: string; normalizedRect: number[]; imageHash?: string } => ({
  kind,
  normalizedRect,
  imageHash
})

it('keeps external labels when quantized raster bounds only graze the caption', () => {
  const source = {
    ...page,
    graphicsBounds: [graphic('image', [0.1, 0.1, 0.9, 0.6])],
    lines: [
      { text: 'a', x: 60, y: 64, width: 6, height: 10, fontSize: 10 },
      { text: '100', x: 540, y: 300, width: 12, height: 8, fontSize: 8 }
    ]
  }
  const caption = {
    page: 1,
    lines: ['Figure 1. ' + 'This long legend describes each of the composite panels. '.repeat(3)],
    rect: [50, 478, 550, 520]
  }
  expect(associateFigures(source, [caption])[0].rect).toEqual([60, 64, 552, 476])
  // A genuinely embedded legend must still preserve the full surrounding raster.
  expect(associateFigures(source, [{ ...caption, rect: [50, 400, 550, 460] }])[0].rect).toEqual([
    60, 80, 540, 480
  ])
})

it.each([false, true])(
  'includes tilted labels beside an adjacent-page legend (prose: %s)',
  (prose) => {
    const source = {
      ...page,
      graphicsBounds: [graphic('image', [0.1, 0.1, 0.9, 0.8])],
      lines: [
        { text: 'Group label', x: 180, y: 634, width: 24, height: 24, fontSize: 5 },
        ...(prose ? [658, 668, 678] : []).map((y) => ({
          text: 'This is a separate paragraph of ordinary article prose.',
          x: 300,
          y,
          width: 230,
          height: 8,
          fontSize: 8
        }))
      ]
    }
    const neighbor = { ...page, pageNumber: 2, graphicsBounds: [] }
    const [figure] = associateAdjacentFigure(
      source,
      [source, neighbor],
      [{ page: 2, lines: ['Figure 1. Results'], rect: [50, 60, 550, 90] }]
    )
    expect(figure.rect).toEqual([60, 80, 540, prose ? 656 : 658])
  }
)

it('keeps connected vector panels and outlined labels outside a composite raster plate', () => {
  // The left panels and their labels are paths; the large raster
  // contains only part of the composite figure. Text is anonymized.
  const source = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/mixed-vector-figure.jsonl')
  )
  const [figure] = associateFigures(source, findCaptionCandidates([source]))
  expect(figure.rect[0]).toBeCloseTo(44.180640625)
  expect(figure.rect[1]).toBeCloseTo(58.6970859375)
  expect(figure.rect[2]).toBeCloseTo(541.794171875)
  expect(figure.rect[3]).toBeCloseTo(571.5242578125)
})

it.each([false, true])(
  'recovers a vector chain without isolated marks (reversed: %s)',
  (reverse) => {
    const graphicsBounds = [
      graphic('image', [200 / 600, 0.25, 440 / 600, 0.75]),
      ...Array.from({ length: 13 }, (_, i) => 120 + i * 6).map((x) =>
        graphic('path', [x / 600, 0.25, (x + 5) / 600, 0.26])
      ),
      graphic('path', [60 / 600, 0.25, 70 / 600, 0.3]),
      graphic('path', [200 / 600, 0.1, 240 / 600, 0.11])
    ]
    const captions = [{ page: 1, lines: ['Figure 1. Results'], rect: [50, 620, 550, 640] }]
    expect(
      associateFigures(
        { ...page, graphicsBounds: reverse ? graphicsBounds.reverse() : graphicsBounds },
        captions
      )[0].rect.map(Math.round)
    ).toEqual([120, 200, 440, 600])
    // Pure-vector figures keep their existing pruning behavior.
    expect(
      associateFigures(
        { ...page, graphicsBounds: graphicsBounds.map((g) => ({ ...g, kind: 'path' })) },
        captions
      )[0].rect[0]
    ).toBe(174)
    // A separate caption or prose between a path and this legend still blocks ownership.
    for (const barrier of ['caption', 'prose']) {
      expect(
        associateFigures(
          {
            ...page,
            graphicsBounds,
            lines:
              barrier === 'prose'
                ? [{ text: 'Article prose. '.repeat(8), x: 110, y: 450, width: 40, height: 8 }]
                : []
          },
          barrier === 'caption'
            ? [...captions, { page: 1, lines: ['Table 1. Data'], rect: [110, 450, 150, 465] }]
            : captions
        )[0].rect[0]
      ).toBe(150)
    }
  }
)

it('keeps detached vector subfigures alongside a raster panel under the same caption', () => {
  // The raster only covers the right-hand panels; text is anonymized.
  const source = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/detached-vector-panels.jsonl')
  )
  const [figure] = associateFigures(source, findCaptionCandidates([source]))
  expect(figure.rect[0]).toBeLessThan(55)
  expect(figure.rect[1]).toBeLessThan(63)
  expect(figure.rect[2]).toBeGreaterThan(550)
  expect(figure.rect[3]).toBeGreaterThan(638)
  expect(figure.rect[3]).toBeLessThan(figure.caption.rect[1])
})

it.each(['table', 'prose'])('does not recover a connected path intersecting %s', (barrier) => {
  const source = {
    ...page,
    graphicsBounds: [
      graphic('image', [200 / 600, 0.25, 440 / 600, 0.75]),
      graphic('path', [185 / 600, 0.25, 197 / 600, 212 / 800]),
      graphic('path', [167 / 600, 0.25, 179 / 600, 212 / 800])
    ],
    lines:
      barrier === 'prose'
        ? [{ text: 'Article prose. '.repeat(8), x: 150, y: 200, width: 25, height: 8 }]
        : []
  }
  const [figure] = associateFigures(
    source,
    [{ page: 1, lines: ['Figure 1. Results'], rect: [50, 620, 550, 640] }],
    barrier === 'table' ? [[150, 200, 175, 250]] : []
  )
  expect(figure.rect.map(Math.round)).toEqual([185, 200, 440, 600])
})

it('excludes a detached multi-column prose clipping path above photographs', () => {
  const lines = [60, 240, 420].flatMap((x) =>
    [200, 210, 220].map((y) => ({
      text: 'This line belongs to the preceding paragraph.',
      x,
      y,
      width: 130,
      height: 8,
      fontSize: 8
    }))
  )
  const source = {
    ...page,
    lines,
    graphicsBounds: [
      graphic('path', [50 / 600, 200 / 800, 560 / 600, 234 / 800]),
      graphic('image', [50 / 600, 246 / 800, 560 / 600, 426 / 800])
    ]
  }
  const captions = [{ page: 1, lines: ['Figure 1. Images'], rect: [50, 450, 560, 460] }]
  expect(associateFigures(source, captions)[0].rect).toEqual([50, 246, 560, 426])
  // A vector panel or a frame touching the image must remain a graphic.
  expect(associateFigures({ ...source, lines: [] }, captions)[0].rect[1]).toBe(200)
})

it('includes an external vertical axis title supported by adjacent numeric ticks', () => {
  const ticks = [
    { text: '100', x: 112, y: 200, width: 20.3, height: 8, fontSize: 8 },
    { text: '0', x: 120, y: 352, width: 12.3, height: 8, fontSize: 8 }
  ]
  const title = { text: 'Concentration', x: 94, y: 230, width: 8, height: 70, fontSize: 8 }
  const captions = [{ page: 1, lines: ['Figure 1. Results'], rect: [90, 390, 430, 402] }]
  const source = {
    ...page,
    graphicsBounds: [graphic('path', [132 / 600, 200 / 800, 400 / 600, 360 / 800])],
    lines: [...ticks, title]
  }
  expect(associateFigures(source, captions)[0].rect).toEqual([94, 200, 400, 360])
  const mirrored = {
    ...source,
    graphicsBounds: [graphic('path', [200 / 600, 200 / 800, 468 / 600, 360 / 800])],
    lines: source.lines.map((line) => ({ ...line, x: 600 - line.x - line.width }))
  }
  expect(associateFigures(mirrored, captions)[0].rect).toEqual([200, 200, 506, 360])
  // A margin label, distant watermark or ordinary horizontal text is not an axis title.
  for (const lines of [
    [title],
    [ticks[0], title],
    [...ticks, { ...title, x: 40 }],
    [...ticks, { ...title, y: 180 }],
    [...ticks, { ...title, width: 70, height: 8 }]
  ]) {
    expect(associateFigures({ ...source, lines }, captions)[0].rect[0]).toBeGreaterThan(94)
  }
})

it('keeps the full right-edge legend text when a small adjacent marker belongs to the figure', () => {
  const label = { text: 'G2 - Milk protein', x: 403, y: 220, width: 70, height: 8, fontSize: 8 }
  const source = {
    ...page,
    lines: [label],
    graphicsBounds: [
      graphic('path', [0.2, 0.25, 400 / 600, 0.45]),
      graphic('path', [380 / 600, 218 / 800, 398 / 600, 232 / 800])
    ]
  }
  const captions = [{ page: 1, lines: ['Figure 1. Results'], rect: [90, 390, 500, 402] }]
  expect(associateFigures(source, captions)[0].rect[2]).toBe(473)
  expect(
    associateFigures({ ...source, graphicsBounds: source.graphicsBounds.slice(0, 1) }, captions)[0]
      .rect[2]
  ).toBe(400)
})

it('keeps ragged paragraph endings and adjacent headings out of figure label padding', () => {
  const line = (
    text: string,
    y: number,
    width: number
  ): { text: string; x: number; y: number; width: number; height: number; fontSize: number } => ({
    text,
    x: 60,
    y,
    width,
    height: 10,
    fontSize: 10
  })
  const source = {
    ...page,
    graphicsBounds: [graphic('image', [0.1, 0.3, 0.9, 0.6])],
    lines: [
      line('The preceding paragraph contains a full line of ordinary body text.', 196, 480),
      line('The next full line belongs to that same external paragraph.', 208, 480),
      line('The last line has a shorter ragged right edge.', 220, 280),
      line('A following paragraph starts with another long line of prose.', 490, 480),
      line('It continues below the figure in the ordinary body column.', 502, 480),
      line('The final matching line confirms the paragraph boundary.', 514, 480),
      { text: 'Results', x: 400, y: 492, width: 50, height: 10, fontSize: 10 }
    ]
  }
  const [match] = associateFigures(source, [
    { page: 1, lines: ['Figure 1. Results'], rect: [60, 80, 550, 100] }
  ])
  expect(match.rect).toEqual([60, 240, 540, 488])
})

it('does not absorb distant vector paths across a narrow body column', () => {
  const [match] = associateFigures(
    {
      ...page,
      graphicsBounds: [
        graphic('path', [0.1, 0.1, 0.45, 0.2]),
        graphic('path', [0.1, 0.5, 0.45, 0.7])
      ],
      lines: [
        {
          text: 'The preceding paragraph contains a full line of ordinary body text.',
          x: 60,
          y: 250,
          width: 210,
          height: 10,
          fontSize: 10
        }
      ]
    },
    [{ page: 1, lines: ['Figure 1. Results'], rect: [60, 580, 270, 600] }]
  )
  expect(match.rect).toEqual([60, 400, 270, 560])
})

it('keeps both centered lines of a chart title when its first line exceeds label padding', () => {
  const [match] = associateFigures(
    {
      ...page,
      graphicsBounds: [graphic('path', [0.1, 0.3, 0.9, 0.6])],
      lines: [
        { text: 'Survival by classification', x: 200, y: 208, width: 200, height: 8, fontSize: 8 },
        { text: 'at ten years', x: 250, y: 220, width: 100, height: 8, fontSize: 8 }
      ]
    },
    [{ page: 1, lines: ['Fig. 3 Survival'], rect: [60, 500, 540, 520] }]
  )
  expect(match.rect).toEqual([60, 208, 540, 480])
})

it('includes complete short legend labels beside a side-captioned plot', () => {
  const [match] = associateFigures(
    {
      ...page,
      graphicsBounds: [graphic('path', [0.4, 0.1, 0.8, 0.4])],
      lines: [
        { text: 'Total Mastectomy (2) 98.2%', x: 470, y: 150, width: 72, height: 6, fontSize: 6 }
      ]
    },
    [{ page: 1, lines: ['Fig. 6 Comparison of survival'], rect: [100, 120, 200, 180] }]
  )
  expect(match.rect).toEqual([240, 80, 542, 320])
})

it('excludes table shading that extends beyond the model crop from a lower figure', () => {
  const source = {
    ...page,
    graphicsBounds: [
      graphic('path', [0.52, 0.25, 0.945, 0.273]),
      graphic('image', [0.1, 0.4, 0.94, 0.8])
    ]
  }
  const [match] = associateFigures(
    source,
    [{ page: 1, lines: ['Figure 3. Results'], rect: [50, 650, 550, 700] }],
    [[310, 185, 510, 300]]
  )
  expect(match.rect).toEqual([60, 320, 564, 640])
})

it('keeps both outer panels above a centered continuation label and resolves its following legend', () => {
  const caption = { page: 1, lines: ['Figure 2: Continued.'], rect: [250, 700, 350, 710] }
  const following = { page: 2, lines: ['Figure 2: Complete legend.'], rect: [50, 300, 550, 350] }
  const [match] = associateFigures(
    {
      ...page,
      graphicsBounds: [
        graphic('image', [0.1, 0.2, 0.4, 0.82]),
        graphic('image', [0.6, 0.2, 0.9, 0.82])
      ]
    },
    [caption, following]
  )
  expect(match.rect).toEqual([60, 160, 540, 656])
  expect(resolveFigureCaption(caption, [caption, following])).toBe(following)
  expect(resolveFigureCaption(caption, [caption])).toBe(caption)
})

it('retains removed margin rules as barriers instead of unioning two distant rules below a figure', () => {
  const source = {
    ...page,
    graphicsBounds: [
      graphic('path', [0.07, 0.04, 0.93, 0.05]),
      graphic('path', [0.07, 0.8, 0.93, 0.81]),
      graphic('path', [0.07, 0.94, 0.93, 0.95]),
      graphic('image', [0.2, 0.1, 0.8, 0.65])
    ]
  }
  const [clean] = excludeRepeatedMarginContent([source, { ...source, pageNumber: 2 }])
  expect(
    associateFigures(clean, [
      { page: 1, lines: ['Figure 1. Results'], rect: [50, 540, 550, 600] }
    ])[0].rect
  ).toEqual([120, 80, 480, 520])
})

it('removes facing-page raster logos and their path wrappers before adjacent caption matching', () => {
  const logo = graphic('image', [0.6, 0.02734375, 0.77, 0.0625], 'same-pixels')
  const wrapper = graphic('path', [...logo.normalizedRect])
  const target = { ...page, graphicsBounds: [graphic('image', [0.07, 0.05859375, 0.93, 0.9])] }
  const neighbor = { ...page, pageNumber: 2, graphicsBounds: [logo, wrapper] }
  const facing = {
    ...page,
    pageNumber: 3,
    graphicsBounds: [graphic('image', [0.22, 0.02734375, 0.39, 0.0625], 'same-pixels')]
  }
  const pages = excludeRepeatedMarginContent([target, neighbor, facing])
  const caption = { page: 2, lines: ['Figure 5. Results'], rect: [50, 60, 550, 180] }
  expect(pages[1].graphicsBounds).toEqual([])
  expect(associateAdjacentFigure(pages[0], pages, [caption])[0].caption).toBe(caption)
})

it('removes repeated footer logos, their clipping paths and isolated rules without dropping the figure', () => {
  const logo = graphic('image', [0.1, 0.94, 0.21, 0.98], 'footer-pixels')
  const source = {
    ...page,
    graphicsBounds: [
      logo,
      graphic('path', [0.1, 0.94, 0.24, 0.98]),
      graphic('path', [0, 0, 1, 1]),
      graphic('path', [0.1, 0.925, 0.93, 0.933]),
      graphic('path', [0.45, 0.99, 0.5, 1]),
      graphic('image', [0.1, 0.3, 0.93, 0.8])
    ]
  }
  const [clean] = excludeRepeatedMarginContent([source, { ...source, pageNumber: 2 }])
  expect(
    associateFigures(clean, [
      { page: 1, lines: ['Figure 1. Results'], rect: [60, 650, 550, 710] }
    ])[0].rect
  ).toEqual([60, 240, 558, 640])
})

it('keeps stacked figures together when the second graphic is nearer the preceding caption', () => {
  const source = {
    ...page,
    graphicsBounds: [graphic('image', [0.1, 0.1, 0.9, 0.4]), graphic('image', [0.1, 0.6, 0.9, 0.8])]
  }
  const captions = [
    { page: 1, lines: ['Figure 4. First'], rect: [50, 330, 550, 440] },
    { page: 1, lines: ['Figure 5. Second'], rect: [50, 720, 550, 750] }
  ]
  const matches = associateFigures(source, captions)
  expect(matches.map((m: { rect: number[] }) => m.rect)).toEqual([
    [60, 80, 540, 320],
    [60, 480, 540, 640]
  ])
})

it('keeps the whole plate above a short cross-page legend pointer', () => {
  const caption = {
    page: 1,
    lines: ['Fig. 2 (See legend on previous page.)'],
    rect: [60, 692, 185, 700]
  }
  const [match] = associateFigures(
    { ...page, graphicsBounds: [graphic('image', [0.24, 0.12, 0.84, 0.87])] },
    [caption]
  )
  expect(match.rect).toEqual([144, 96, 504, 690])
})

it('resolves an erroneous direction only to a unique adjacent legend with the same number', () => {
  const pointer = {
    page: 2,
    lines: ['Fig. 3 (See legend on previous page.)'],
    rect: [50, 700, 200, 710]
  }
  const actual = { page: 3, lines: ['Fig. 3 Full caption.'], rect: [50, 50, 550, 100] }
  expect(resolveFigureCaption(pointer, [pointer, actual])).toBe(actual)
})

it('excludes repeated isolated side banners from side-caption association', () => {
  const banner = graphic('path', [0.945, 0.34, 1, 0.44])
  const target = { ...page, graphicsBounds: [graphic('image', [0.06, 0.06, 0.66, 0.7]), banner] }
  const [clean] = excludeRepeatedMarginContent([
    target,
    { ...page, pageNumber: 2, graphicsBounds: [banner] }
  ])
  expect(
    associateFigures(clean, [
      { page: 1, lines: ['Fig. 1. Results'], rect: [400, 180, 540, 570] }
    ])[0].rect
  ).toEqual([36, 48, 396, 560])
})

it('allows a figure-only page to use a full caption at the end of the next page', () => {
  const source = { ...page, graphicsBounds: [graphic('image', [0.1, 0.07, 0.9, 0.92])] }
  const neighbor = { ...page, pageNumber: 2, graphicsBounds: [] }
  const caption = { page: 2, lines: ['Figure 4. A full legend'], rect: [40, 680, 550, 750] }
  expect(associateAdjacentFigure(source, [source, neighbor], [caption])[0]?.rect).toEqual([
    60, 56.00000000000001, 540, 736
  ])
})

it('recognizes paired vertical category banners without a repeated neighboring page', () => {
  const banners = [graphic('path', [0.945, 0.34, 1, 0.44]), graphic('path', [0.945, 0.45, 1, 0.55])]
  const source = {
    ...page,
    lines: [
      { text: 'CELL BIOLOGY', x: 570, y: 280, width: 5, height: 40 },
      { text: 'COMPUTATIONAL BIOLOGY', x: 570, y: 365, width: 5, height: 60 }
    ],
    graphicsBounds: banners
  }
  expect(excludeRepeatedMarginContent([source])[0].graphicsBounds).toEqual([])
  expect(excludeRepeatedMarginContent([source])[0].lines).toEqual([])
  // A lone axis label or a banner overlapping a chart is insufficient.
  expect(
    excludeRepeatedMarginContent([{ ...source, graphicsBounds: [banners[0]] }])[0].graphicsBounds
  ).toHaveLength(1)
  expect(
    excludeRepeatedMarginContent([
      { ...source, graphicsBounds: [...banners, graphic('image', [0.5, 0.3, 1, 0.6])] }
    ])[0].graphicsBounds
  ).toHaveLength(3)
})

it('associates a bare number above a plate with its separate multiline legend below', () => {
  const lines = [
    {
      text: 'Association of the measured variants with the overall survival of study participants.',
      x: 60,
      y: 330,
      width: 480,
      height: 8,
      fontSize: 8
    },
    {
      text: 'Curves were compared with the log-rank test in the original cohort.',
      x: 60,
      y: 340,
      width: 470,
      height: 8,
      fontSize: 8
    }
  ]
  const caption = { page: 1, lines: ['Fig. 1'], rect: [60, 50, 90, 58] }
  const [match] = associateFigures(
    { ...page, lines, graphicsBounds: [graphic('image', [0.1, 0.1, 0.9, 0.4])] },
    [caption]
  )
  expect(match.caption.lines).toEqual(['Fig. 1', ...lines.map((line) => line.text)])
  expect(match.rect[3]).toBeLessThan(330)
  const [single] = associateFigures(
    { ...page, lines: lines.slice(0, 1), graphicsBounds: [graphic('image', [0.1, 0.1, 0.9, 0.4])] },
    [caption]
  )
  expect(single.caption).toBe(caption)
})

it('retains two supported at-risk rows below the plot without absorbing a single numeric line', () => {
  const label = {
    text: 'No. of patients at risk',
    x: 80,
    y: 320,
    width: 110,
    height: 8,
    fontSize: 8
  }
  const row = (text: string, y: number): object => ({
    text,
    x: 80,
    y,
    width: 310,
    height: 8,
    fontSize: 8
  })
  const source = {
    ...page,
    graphicsBounds: [graphic('path', [120 / 600, 100 / 800, 400 / 600, 300 / 800])],
    lines: [label, row('Treatment 42 30 20 10', 342), row('Control 40 29 18 9', 356)]
  }
  const captions = [{ page: 1, lines: ['Fig 2. Cumulative incidence'], rect: [80, 380, 450, 390] }]
  expect(associateFigures(source, captions)[0].rect[3]).toBe(364)
  expect(
    associateFigures({ ...source, lines: source.lines.slice(0, 2) }, captions)[0].rect[3]
  ).toBeLessThan(342)
})

it('includes a detached aligned definition key below an above-captioned diagram', () => {
  const captions = [{ page: 1, lines: ['Figure 1. Study design'], rect: [90, 60, 350, 72] }]
  const lines = [
    'R = randomization',
    'FSH = stimulating hormone',
    'OPU = collection',
    '^ = sample'
  ].map((text, n) => ({ text, x: 90, y: 320 + n * 18, width: 200, height: 10, fontSize: 10 }))
  const source = {
    ...page,
    graphicsBounds: [graphic('image', [90 / 600, 100 / 800, 450 / 600, 300 / 800])],
    lines
  }
  expect(associateFigures(source, captions)[0].rect[3]).toBe(384)
  for (const invalid of [
    lines.slice(0, 2),
    lines.map((l) => ({ ...l, y: l.y + 100 })),
    [lines[0], { ...lines[1], text: 'This is an unrelated paragraph.' }, ...lines.slice(2)]
  ]) {
    expect(associateFigures({ ...source, lines: invalid }, captions)[0].rect[3]).toBeLessThan(360)
  }
})

it('excludes a matching running author header and divider above a flowchart', () => {
  const source = {
    ...page,
    pageNumber: 5,
    lines: [{ text: 'Smith et al. 5', x: 60, y: 43, width: 480, height: 10, fontSize: 10 }],
    graphicsBounds: [
      graphic('path', [0.1, 54 / 800, 0.9, 58 / 800]),
      graphic('image', [0.1, 65 / 800, 0.9, 550 / 800])
    ]
  }
  const captions = [{ page: 5, lines: ['Figure 1. Flow diagram'], rect: [60, 560, 350, 572] }]
  expect(associateFigures(source, captions)[0].rect[1]).toBe(65)
  expect(
    associateFigures(
      { ...source, lines: [{ ...source.lines[0], text: 'Panel response 5' }] },
      captions
    )[0].rect[1]
  ).toBe(43)
})

it('keeps a framed flowchart connected across its own explanatory note', () => {
  const box = (rect: number[]): object =>
    graphic(
      'path',
      rect.map((v, i) => v / (i % 2 ? 800 : 600))
    )
  const lines = [220, 300, 380].map((y) => ({
    text: 'Participants allocated to treatment',
    x: 110,
    y,
    width: 220,
    height: 9,
    fontSize: 9
  }))
  const note = {
    text: 'Note: Participants in both arms received the assigned treatment and were included in the analysis population.',
    x: 60,
    y: 440,
    width: 480,
    height: 8,
    fontSize: 8
  }
  const source = {
    ...page,
    lines: [...lines, note],
    graphicsBounds: [
      box([50, 200, 51, 462]),
      box([549, 200, 550, 462]),
      box([50, 461, 550, 462]),
      ...lines.map((l) => box([100, l.y - 5, 360, l.y + 20]))
    ]
  }
  const captions = [{ page: 1, lines: ['Figure 1. CONSORT flowchart'], rect: [50, 465, 550, 477] }]
  const complete = associateFigures(source, captions)[0]
  expect(complete.rect?.[1]).toBeLessThanOrEqual(215)
  const unframed = associateFigures(
    { ...source, graphicsBounds: source.graphicsBounds.slice(3) },
    captions
  )[0]
  expect(unframed.rect).toBeUndefined()
})

it('recovers a labelled graphical abstract above ordinary two-column article prose', () => {
  const source = {
    ...page,
    lines: [
      { text: 'Graphical Abstract', x: 45, y: 60, width: 100, height: 10 },
      { text: 'Introduction', x: 45, y: 350, width: 70, height: 12 }
    ],
    graphicsBounds: [graphic('image', [0.1, 0.1, 0.9, 0.3])]
  }
  expect(associateGraphicalAbstract(source)?.rect).toEqual([60, 80, 540, 240])
  expect(associateGraphicalAbstract(source)?.caption.lines).toEqual(['Graphical Abstract'])
  expect(associateGraphicalAbstract({ ...source, lines: source.lines.slice(1) })).toBeUndefined()
  expect(associateGraphicalAbstract({ ...source, pageNumber: 5 })).toBeUndefined()
  expect(
    associateGraphicalAbstract({
      ...source,
      graphicsBounds: [...source.graphicsBounds, ...source.graphicsBounds]
    })
  ).toBeUndefined()
  expect(
    associateGraphicalAbstract({
      ...source,
      graphicsBounds: [graphic('image', [0.1, 0.2, 0.9, 0.4])]
    })
  ).toBeUndefined()
})

it('associates a centered inset raster with an immediate short margin caption', () => {
  const caption = { page: 1, lines: ['Figure 1. Patient enrollment.'], rect: [50, 700, 237, 707] }
  const source = {
    ...page,
    graphicsBounds: [graphic('image', [184 / 600, 481 / 800, 414 / 600, 692 / 800])]
  }
  expect(associateFigures(source, [caption])[0].rect).toBeDefined()
  expect(
    associateFigures(source, [{ ...caption, rect: [50, 755, 237, 762] }])[0].rect
  ).toBeUndefined()
  expect(associateFigures(source, [caption], [[180, 480, 415, 693]])[0].rect).toBeUndefined()
})

it('keeps captioned flowchart frames containing explanatory text and nested drawing operations', () => {
  const caption = { page: 1, lines: ['Figure 1. Trial schema.'], rect: [90, 680, 350, 690] }
  const source = {
    ...page,
    lines: [100, 115, 130].map((y) => ({
      text: 'Eligibility criteria and treatment instructions inside the trial diagram, with a long source line.',
      x: 100,
      y,
      width: 390,
      height: 9,
      fontSize: 9
    })),
    graphicsBounds: [
      graphic('path', [90 / 600, 70 / 800, 530 / 600, 675 / 800]),
      ...[200, 350, 500].map((y) =>
        graphic('path', [200 / 600, y / 800, 220 / 600, (y + 15) / 800])
      )
    ]
  }
  expect(associateFigures(source, [caption])[0].rect).toBeDefined()
  expect(
    associateFigures({ ...source, graphicsBounds: source.graphicsBounds.slice(0, 1) }, [caption])[0]
      .rect
  ).toBeUndefined()
})

it('keeps a continuous raster plate stored as thin overlapping image strips', () => {
  const captions = [
    { page: 1, lines: ['Fig. 1. Molecular structures.'], rect: [220, 410, 380, 420] }
  ]
  const strips = Array.from({ length: 100 }, (_, n) =>
    graphic('image', [100 / 600, (100 + n * 3) / 800, 500 / 600, (106 + n * 3) / 800])
  )
  expect(associateFigures({ ...page, graphicsBounds: strips }, captions)[0].rect).toEqual([
    100, 100, 500, 403
  ])
  expect(
    associateFigures({ ...page, graphicsBounds: strips.filter((_, n) => n % 5 === 0) }, captions)[0]
      .rect
  ).toBeUndefined()
  expect(
    associateFigures(
      { ...page, graphicsBounds: strips.map((g) => ({ ...g, kind: 'path' })) },
      captions
    )[0].rect
  ).toBeUndefined()
})

it('keeps a connector spanning multiple panels on the same side of a flowchart caption', () => {
  const source = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/side-flowchart.jsonl')
  )
  const captions = findCaptionCandidates([source])
  expect(associateFigures(source, captions)[0].rect).toEqual([
    183.698453125, 55.607765625, 548.7700625, 469.5766875
  ])
})
