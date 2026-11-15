import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { nativeRasterPeerOwnership, nativeRasterCaptionPacket } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-raster-peer-ownership.mjs')).href
)
function fixture(): ReturnType<typeof JSON.parse> {
  const captions = [
    { page: 1, lines: ['Fig. 1: First independent plate.'], rect: [30, 330, 280, 340] },
    { page: 1, lines: ['Fig. 2: Second independent plate.'], rect: [320, 350, 570, 360] }
  ]
  const tokens = captions.map((c, index) => ({
    text: c.lines[0],
    sourceItem: { pageNumber: 1, index, text: c.lines[0] },
    horizontal: true,
    height: 10,
    rect: c.rect
  }))
  const graphicsBounds = [0, 1].flatMap((side) =>
    [0, 1, 2].flatMap((row) =>
      [0, 1].map((col) => ({
        kind: 'image',
        imageHash: 'anonymous-carrier',
        operationIndex: 10 + side * 100 + row * 2 + col,
        normalizedRect: [
          40 + side * 290 + col * 110,
          150 + row * 55,
          140 + side * 290 + col * 110,
          200 + row * 55
        ].map((v, n) => v / (n % 2 ? 800 : 600))
      }))
    )
  )
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    graphicsBounds,
    lines: tokens.map((t) => ({
      text: t.text,
      x: t.rect[0],
      y: t.rect[1],
      width: t.rect[2] - t.rect[0],
      height: 10,
      fontSize: 10
    }))
  }
  return { page, captions, tokens, tables: [[30, 40, 280, 120]] }
}
const associate = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  associateFigures(f.page, f.captions, f.tables, [], [], f.tokens)
it('keeps complete disjoint native raster packets with their independent captions', () => {
  const f = fixture(),
    before = structuredClone(f),
    result = associate(f)
  expect(result.map((r: { rect: number[] }) => r.rect)).toEqual([
    [40, 150, 250, 310],
    [330, 150, 540, 310]
  ])
  expect(f).toEqual(before)
})

it('does not assign one native gutter label to both completed peer crops', () => {
  const f = fixture()
  f.captions[0].rect = [30, 330, 300, 340]
  f.captions[1].rect = [315, 350, 585, 360]
  f.tokens.forEach((token: ReturnType<typeof JSON.parse>, index: number) => {
    token.rect = f.captions[index].rect
  })
  expect(nativeRasterPeerOwnership(f.page, f.captions, f.tables, f.tokens)).toBeDefined()
  f.tokens.push({
    text: 'i',
    horizontal: true,
    height: 10,
    rect: [306, 170, 309, 180],
    sourceItem: { pageNumber: 1, index: 2, text: 'i' }
  })
  expect(nativeRasterPeerOwnership(f.page, f.captions, f.tables, f.tokens)).toBeUndefined()
})

it.each([
  'missing-caption-row',
  'duplicate-origin',
  'stale-source',
  'interleaved-images',
  'shared-frame',
  'table-crossing',
  'shared-caption',
  'unknown-operator',
  'unbounded-paint'
])('abstains from independent ownership when native closure is absent: %s', (kind) => {
  const f = fixture()
  if (kind === 'missing-caption-row') f.tokens.pop()
  if (kind === 'duplicate-origin') f.tokens.push(structuredClone(f.tokens[0]))
  if (kind === 'stale-source') f.tokens[0].sourceItem.text += ' A stale suffix.'
  if (kind === 'interleaved-images') f.page.graphicsBounds[1].operationIndex = 112
  if (kind === 'unknown-operator') delete f.page.graphicsBounds[0].operationIndex
  if (kind === 'unbounded-paint') f.page.invalidGraphicsBounds = 1
  if (kind === 'shared-caption') f.captions[0].rect[2] = 550
  if (kind === 'table-crossing') f.tables[0] = [30, 140, 280, 180]
  if (kind === 'shared-frame')
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: 300,
      normalizedRect: [30 / 600, 140 / 800, 550 / 600, 320 / 800]
    })
  expect(nativeRasterPeerOwnership(f.page, f.captions, f.tables, f.tokens)).toBeUndefined()
})

function completePacket(): ReturnType<typeof fixture> {
  const f = fixture(),
    caption = {
      page: 1,
      lines: ['Figure 1. One complete native plate.'],
      rect: [30, 330, 570, 340]
    }
  f.captions = [caption]
  f.tokens = [
    {
      text: caption.lines[0],
      horizontal: true,
      height: 10,
      rect: caption.rect,
      sourceItem: { pageNumber: 1, index: 0, text: caption.lines[0] }
    },
    {
      text: 'Panel title',
      horizontal: true,
      height: 10,
      rect: [60, 130, 140, 140],
      sourceItem: { pageNumber: 1, index: 1, text: 'Panel title' }
    },
    {
      text: 'axis',
      horizontal: false,
      height: 10,
      rect: [20, 170, 30, 210],
      sourceItem: { pageNumber: 1, index: 2, text: 'axis' }
    }
  ]
  f.page.lines = f.tokens.map((t: ReturnType<typeof JSON.parse>) => ({
    text: t.text,
    x: t.rect[0],
    y: t.rect[1],
    width: t.rect[2] - t.rect[0],
    height: t.rect[3] - t.rect[1],
    fontSize: 10
  }))
  f.tables = []
  return f
}
it('retains native reference carriers, header fonts and a rotated axis in one complete dense packet', () => {
  const f = completePacket(),
    before = structuredClone(f)
  expect(associate(f)[0].rect).toEqual([20, 130, 540, 310])
  expect(f).toEqual(before)
})
it.each([
  'stale-header',
  'duplicate-axis',
  'foreign-paragraph',
  'caption-barrier',
  'shared-paint',
  'foreign-table',
  'short-exterior-prose'
])('abstains from a single packet without complete native ownership: %s', (kind) => {
  const f = completePacket()
  if (kind === 'short-exterior-prose')
    f.tokens.push({
      text: 'Another paragraph.',
      horizontal: true,
      height: 10,
      rect: [50, 315, 250, 325],
      sourceItem: { pageNumber: 1, index: 9, text: 'Another paragraph.' }
    })
  if (kind === 'stale-header') f.tokens[1].sourceItem.text += ' Stale.'
  if (kind === 'duplicate-axis') f.tokens.push(structuredClone(f.tokens[2]))
  if (kind === 'foreign-paragraph')
    f.tokens.push({
      text: 'A separate ordinary paragraph explains a different result in this interval.',
      horizontal: true,
      height: 10,
      rect: [50, 220, 540, 230],
      sourceItem: {
        pageNumber: 1,
        index: 3,
        text: 'A separate ordinary paragraph explains a different result in this interval.'
      }
    })
  if (kind === 'caption-barrier')
    f.captions.push({ page: 1, lines: ['Figure 2. Earlier plate.'], rect: [30, 215, 570, 225] })
  if (kind === 'shared-paint')
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: 400,
      normalizedRect: [0, 140 / 800, 1, 320 / 800]
    })
  if (kind === 'foreign-table') f.tables.push([30, 140, 280, 200])
  expect(
    nativeRasterCaptionPacket(f.page, f.captions[0], f.captions, f.tables, f.tokens)
  ).toBeUndefined()
})

it.each(['same-page-table', 'neighbor-page', 'both'])(
  'keeps native peer ownership with complete production caption scope: %s',
  (scope) => {
    const f = fixture()
    if (scope !== 'neighbor-page')
      f.captions.push({
        page: 1,
        lines: ['TABLE I'],
        rect: [30, 40, 280, 60]
      })
    if (scope !== 'same-page-table')
      f.captions.push({
        page: 2,
        lines: ['Figure 3. A different page.'],
        rect: [30, 150, 570, 310]
      })
    const original = structuredClone(f)
    expect(
      nativeRasterPeerOwnership(f.page, f.captions, f.tables, f.tokens)?.map(
        (peer: { rect: number[] }) => peer.rect
      )
    ).toEqual([
      [40, 150, 250, 310],
      [330, 150, 540, 310]
    ])
    expect(associate(f).map((peer: { rect: number[] }) => peer.rect)).toEqual([
      [40, 150, 250, 310],
      [330, 150, 540, 310]
    ])
    expect(f).toEqual(original)
  }
)
it('retains a same-page foreign table caption as a physical ownership barrier', () => {
  const f = fixture()
  f.captions.push({ page: 1, lines: ['TABLE I'], rect: [50, 230, 250, 240] })
  expect(nativeRasterPeerOwnership(f.page, f.captions, f.tables, f.tokens)).toBeUndefined()
})

it('does not discard an invalid local non-figure caption boundary', () => {
  const f = fixture()
  f.captions.push({ page: 1, lines: ['TABLE I'], rect: [30, Number.NaN, 280, 60] })
  expect(nativeRasterPeerOwnership(f.page, f.captions, f.tables, f.tokens)).toBeUndefined()
})
