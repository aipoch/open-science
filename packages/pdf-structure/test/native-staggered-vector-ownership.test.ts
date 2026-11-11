import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { nativeCaptionedRasterVectorStrip } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-captioned-illustration.mjs')).href
)
const { nativeCaptionedVectorTableGrid } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-captioned-illustration.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)

function fixture(scale = 1): ReturnType<typeof JSON.parse> {
  const rect = (r: number[]): number[] => r.map((v) => v * scale)
  const captions = [
    { page: 1, lines: ['Fig. 1: Response summary.'], rect: rect([50, 210, 295, 240]) },
    { page: 1, lines: ['Fig. 2: Three response panels.'], rect: rect([310, 380, 560, 430]) }
  ]
  const graphic = (kind: string, operationIndex: number, r: number[]): unknown => ({
    kind,
    operationIndex,
    normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 600))
  })
  const tokens = captions.map((c, index) => ({
    text: c.lines[0],
    sourceItem: { pageNumber: 1, index, text: c.lines[0] },
    horizontal: true,
    height: 10 * scale,
    baseline: c.rect[1] + 10 * scale,
    rect: [c.rect[0], c.rect[1], c.rect[2], c.rect[1] + 10 * scale]
  }))
  const page = {
    pageNumber: 1,
    width: 600 * scale,
    height: 800 * scale,
    invalidGraphicsBounds: 0,
    lines: tokens.map((t) => ({
      text: t.text,
      x: t.rect[0],
      y: t.rect[1],
      width: t.rect[2] - t.rect[0],
      height: t.height,
      fontSize: t.height
    })),
    graphicsBounds: [
      graphic('image', 10, [70, 60, 270, 195]),
      graphic('path', 50, [340, 60, 550, 370]),
      ...Array.from({ length: 12 }, (_, i) =>
        graphic('path', 100 + i, [350, 60 + i * 11, 550, 70 + i * 11])
      ),
      graphic('path', 200, [350, 250, 550, 370])
    ]
  }
  return { page, captions, tokens }
}
const strip = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  nativeCaptionedRasterVectorStrip(f.page, f.captions[0], f.captions, [], [], f.tokens)

it.each([1, 1.5])(
  'leaves a separately captioned native vector packet outside the raster at scale %f',
  (scale) => {
    const f = fixture(scale),
      before = structuredClone(f)
    expect(strip(f)).toBeUndefined()
    const result = associateFigures(f.page, f.captions, [], [], [], f.tokens)
    expect(result[0].rect).toEqual([70, 60, 270, 195].map((v) => v * scale))
    expect(result[1].rect[0]).toBeGreaterThanOrEqual(340 * scale)
    expect(f).toEqual(before)
  }
)

it('keeps a tall vector packet separate when its caption uses several native words', () => {
  const f = fixture()
  f.page.graphicsBounds[1].normalizedRect[1] = 20 / 800
  const original = f.tokens.pop()
  f.tokens.push(
    {
      ...original,
      text: 'Fig. 2:',
      sourceItem: { pageNumber: 1, index: 1, text: 'Fig. 2:' },
      rect: [310, 380, 350, 390]
    },
    {
      ...original,
      text: 'Three response panels.',
      sourceItem: { pageNumber: 1, index: 2, text: 'Three response panels.' },
      rect: [355, 380, 550, 390]
    }
  )
  expect(strip(f)).toBeUndefined()
  expect(associateFigures(f.page, f.captions, [], [], [], f.tokens)[0].rect).toEqual([
    70, 60, 270, 195
  ])
})

it('uses the two source columns even when both lie beyond the page midpoint', () => {
  const f = fixture()
  f.page.width = 1200
  for (const g of f.page.graphicsBounds)
    g.normalizedRect = g.normalizedRect.map((v: number, n: number) =>
      n % 2 ? v : (v * 600 + 600) / 1200
    )
  for (const c of f.captions) c.rect = c.rect.map((v: number, n: number) => (n % 2 ? v : v + 600))
  for (const t of f.tokens) t.rect = t.rect.map((v: number, n: number) => (n % 2 ? v : v + 600))
  for (const l of f.page.lines) l.x += 600
  expect(strip(f)).toBeUndefined()
  const result = associateFigures(f.page, f.captions, [], [], [], f.tokens)
  expect(result[0].rect).toEqual([670, 60, 870, 195])
})

it.each([
  'missing-native-caption',
  'duplicate-source-index',
  'duplicate-source-segment',
  'partial-source-segment',
  'dual-source-carriers',
  'truncated-source-text',
  'nonhorizontal-caption',
  'duplicate-caption',
  'other-page',
  'distant-caption',
  'missing-envelope',
  'duplicate-envelope',
  'invalid-operator',
  'duplicate-operator',
  'unbounded-graphics',
  'shared-path',
  'own-column-path',
  'interleaved-foreign-operator'
])('keeps the legacy strip when independent ownership is unproved: %s', (kind) => {
  const f = fixture()
  if (kind === 'missing-native-caption') f.tokens.pop()
  if (kind === 'duplicate-source-index')
    f.tokens.push({
      ...f.tokens[1],
      text: 'Other',
      sourceItem: { ...f.tokens[1].sourceItem, text: 'Other' }
    })
  if (kind === 'duplicate-source-segment' || kind === 'partial-source-segment') {
    const origin = f.tokens[1]
    f.tokens.push({
      text: 'Other',
      horizontal: false,
      rect: [0, 0, 20, 10],
      sourceSegment: {
        ...origin.sourceItem,
        start: 0,
        end: kind === 'partial-source-segment' ? 2 : origin.text.length,
        rect: [0, 0, 20, 10]
      }
    })
  }
  if (kind === 'dual-source-carriers')
    f.tokens[1].sourceSegment = {
      ...f.tokens[1].sourceItem,
      start: 0,
      end: 2,
      rect: f.tokens[1].rect
    }
  if (kind === 'truncated-source-text') f.tokens[1].sourceItem.text += ' Continued text.'
  if (kind === 'nonhorizontal-caption') f.tokens[1].horizontal = false
  if (kind === 'duplicate-caption') f.captions.push(structuredClone(f.captions[1]))
  if (kind === 'other-page') f.captions[1].page = 2
  if (kind === 'distant-caption') f.captions[1].rect[1] += 80
  if (kind === 'missing-envelope') f.page.graphicsBounds.splice(1, 1)
  if (kind === 'duplicate-envelope')
    f.page.graphicsBounds.push({ ...f.page.graphicsBounds[1], operationIndex: 51 })
  if (kind === 'invalid-operator') f.page.graphicsBounds[1].operationIndex = -1
  if (kind === 'duplicate-operator') f.page.graphicsBounds[2].operationIndex = 50
  if (kind === 'unbounded-graphics') f.page.invalidGraphicsBounds = 1
  if (kind === 'shared-path')
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: 300,
      normalizedRect: [60 / 600, 50 / 800, 550 / 600, 200 / 800]
    })
  if (kind === 'own-column-path')
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: 20,
      normalizedRect: [80 / 600, 70 / 800, 100 / 600, 100 / 800]
    })
  if (kind === 'interleaved-foreign-operator')
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: 150,
      normalizedRect: [80 / 600, 500 / 800, 100 / 600, 520 / 800]
    })
  const before = structuredClone(f)
  expect(strip(f)?.rect[2]).toBeGreaterThan(500)
  expect(f).toEqual(before)
})

it('keeps existing calls without native source tokens compatible', () => {
  const f = fixture()
  expect(nativeCaptionedRasterVectorStrip(f.page, f.captions[0], f.captions, [])?.rect[2]).toBe(550)
})

it('keeps a neighboring vector packet with separate raised plot labels outside the raster', () => {
  const f = fixture()
  f.page.graphicsBounds.push(
    ...[0, 1].map((n) => ({
      kind: 'path',
      operationIndex: 1 + n,
      normalizedRect: [(350 + n * 60) / 600, 35 / 800, (360 + n * 60) / 600, 45 / 800]
    }))
  )
  expect(strip(f)).toBeUndefined()
})

function pairedRasterNeighbor(): ReturnType<typeof JSON.parse> {
  const f = fixture()
  f.captions = [
    { page: 1, lines: ['Figure 1: Native panel summary.'], rect: [88, 197, 260, 207] },
    { page: 1, lines: ['Figure 2: Native vector summary.'], rect: [335, 174, 540, 184] }
  ]
  f.page.graphicsBounds = [
    ...[
      [53, 84, 179, 167],
      [182, 84, 296, 167]
    ].map((r, n) => ({
      kind: 'image',
      operationIndex: 10 + n * 20,
      normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 600))
    })),
    {
      kind: 'path',
      operationIndex: 100,
      normalizedRect: [318 / 600, 84 / 800, 562 / 600, 179 / 800]
    },
    ...Array.from({ length: 12 }, (_, n) => ({
      kind: 'path',
      operationIndex: 110 + n,
      normalizedRect: [340 / 600, (90 + n * 5) / 800, 550 / 600, (94 + n * 5) / 800]
    }))
  ]
  const raw = [
    ['(a)', 54, 167, 10],
    ['Measured values remain', 65, 167, 110],
    ['independently described.', 54, 180, 120],
    ['(b)', 183, 167, 10],
    ['A separate native panel', 194, 167, 100],
    ['is independently described.', 183, 180, 110],
    ['Figure 1: Native panel', 88, 197, 100],
    ['summary.', 190, 197, 70],
    ['Figure 2: Native vector summary.', 335, 174, 205]
  ]
  f.tokens = raw.map(([text, x, y, width], index) => ({
    text,
    rect: [x, y, Number(x) + Number(width), Number(y) + 10],
    height: 10,
    horizontal: true,
    sourceItem: { pageNumber: 1, index, text }
  }))
  f.page.lines = f.tokens.map((t: ReturnType<typeof JSON.parse>) => ({
    text: t.text,
    x: t.rect[0],
    y: t.rect[1],
    width: t.rect[2] - t.rect[0],
    height: 10,
    fontSize: 10
  }))
  return f
}

it('does not lend a natively captioned raster pair to a staggered vector neighbor', () => {
  const f = pairedRasterNeighbor(),
    before = structuredClone(f)
  expect(
    nativeCaptionedRasterVectorStrip(f.page, f.captions[1], f.captions, [], [], f.tokens)
  ).toBeUndefined()
  expect(f).toEqual(before)
})

it.each(['missing-marker', 'aliased-source', 'shared-paint', 'missing-native-caption'])(
  'retains the mixed fallback when the raster pair has incomplete ownership: %s',
  (kind) => {
    const f = pairedRasterNeighbor()
    if (kind === 'missing-marker') f.tokens.splice(3, 1)
    if (kind === 'aliased-source') f.tokens.push({ ...f.tokens[0] })
    if (kind === 'missing-native-caption') f.tokens.splice(7, 1)
    if (kind === 'shared-paint')
      f.page.graphicsBounds.push({
        kind: 'path',
        operationIndex: 130,
        normalizedRect: [53 / 600, 90 / 800, 550 / 600, 150 / 800]
      })
    expect(
      nativeCaptionedRasterVectorStrip(f.page, f.captions[1], f.captions, [], [], f.tokens)
    ).toBeDefined()
  }
)

it('does not mistake repeated baseline bars for table rules connecting every row', () => {
  const caption = { page: 1, lines: ['Figure 1: Native measurements.'], rect: [50, 220, 550, 230] }
  const rects = [
    ...[110, 140, 170, 200].map((y) => [100, y, 500, y + 4]),
    ...[150, 220, 290, 360, 430].flatMap((x, n) => [
      [x, 145 + n * 3, x + 4, 204],
      [x + 6, 165 - n * 3, x + 10, 204]
    ])
  ]
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: caption.lines[0], x: 50, y: 220, width: 500, height: 10, fontSize: 10 },
      { text: 'Measured values', x: 110, y: 150, width: 100, height: 10, fontSize: 10 }
    ],
    graphicsBounds: rects.map((r) => ({
      kind: 'path',
      normalizedRect: r.map((v, n) => v / (n % 2 ? 800 : 600))
    }))
  }
  expect(nativeCaptionedVectorTableGrid(page, caption, [caption], [])).toBeUndefined()
})
