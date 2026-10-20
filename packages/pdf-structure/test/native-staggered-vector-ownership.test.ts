import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { nativeCaptionedRasterVectorStrip } = await import(
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
