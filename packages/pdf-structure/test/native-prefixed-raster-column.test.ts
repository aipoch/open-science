import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { nativeLetteredRasterArray } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-captioned-illustration.mjs')).href
)

function fixture(count = 3, scale = 1): ReturnType<typeof JSON.parse> {
  const rect = (r: number[]): number[] => r.map((v) => v * scale)
  const caption = {
    page: 2,
    lines: ['Figure 8: Comparison across conditions.'],
    rect: rect([40, 70 + count * 120, 280, 90 + count * 120])
  }
  const other = {
    page: 2,
    lines: ['Figure 9: Separate experiment.'],
    rect: rect([330, 160, 570, 180])
  }
  const tokens = Array.from({ length: count }, (_, index) => {
    const text = `(${String.fromCharCode(97 + index)}) Condition ${index + 1}`
    return {
      text,
      sourceItem: { pageNumber: 2, index, text },
      horizontal: true,
      height: 8 * scale,
      baseline: (168 + index * 120) * scale,
      rect: rect([100, 160 + index * 120, 220, 168 + index * 120])
    }
  })
  const image = (r: number[], operationIndex: number): unknown => ({
    kind: 'image',
    operationIndex,
    normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 600)),
    paintedNormalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 600))
  })
  const page = {
    pageNumber: 2,
    invalidGraphicsBounds: 0,
    width: 600 * scale,
    height: 800 * scale,
    lines: [caption, other].map((c) => ({
      text: c.lines[0],
      x: c.rect[0],
      y: c.rect[1],
      width: c.rect[2] - c.rect[0],
      height: 10 * scale,
      fontSize: 10 * scale
    })),
    graphicsBounds: [
      ...Array.from({ length: count }, (_, i) =>
        image([40, 50 + i * 120, 280, 150 + i * 120], i + 1)
      ),
      image([330, 50, 570, 150], 99)
    ]
  }
  return { page, caption, captions: [caption, other], tokens }
}
const match = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  nativeLetteredRasterArray(f.page, f.caption, f.captions, [], f.tokens)

it.each([
  [3, 1],
  [4, 1.3]
])(
  'joins %i native prefixed panels at scale %f without taking the neighboring figure',
  (count, scale) => {
    const f = fixture(count, scale)
    expect(match(f)).toMatchObject({ graphicsCount: count })
    const figures = associateFigures(f.page, f.captions, [], [], [], f.tokens)
    expect(figures[0].rect).toEqual([40, 50, 280, 168 + (count - 1) * 120].map((v) => v * scale))
    expect(figures[1].rect[0]).toBeGreaterThanOrEqual(330 * scale)
    expect(figures[1].graphicsCount).toBe(1)
  }
)

it.each([
  'duplicate-label',
  'duplicate-source',
  'duplicate-nonlabel-source',
  'duplicate-nonhorizontal-source',
  'missing-key',
  'missing-source',
  'truncated-source',
  'duplicate-image',
  'small-unpaired-image',
  'duplicate-operation',
  'invalid-operation',
  'invalid-image-geometry',
  'invalid-graphics',
  'foreign-caption',
  'intervening-prose',
  'short-prose'
])('refuses a column with %s evidence', (kind) => {
  const f = fixture()
  if (kind === 'duplicate-label')
    f.tokens.push({ ...f.tokens[1], sourceItem: { ...f.tokens[1].sourceItem, index: 99 } })
  if (kind === 'duplicate-source') f.tokens[1].sourceItem.index = f.tokens[0].sourceItem.index
  if (kind === 'duplicate-nonlabel-source' || kind === 'duplicate-nonhorizontal-source')
    f.tokens.push({
      ...f.tokens[0],
      text: 'Other',
      horizontal: kind === 'duplicate-nonlabel-source',
      sourceItem: { ...f.tokens[0].sourceItem, text: 'Other' },
      rect: [50, 60, 70, 68]
    })
  if (kind === 'missing-key') f.tokens.splice(1, 1)
  if (kind === 'missing-source') delete f.tokens[1].sourceItem
  if (kind === 'truncated-source') f.tokens[1].text = '(b) Condition'
  if (kind === 'duplicate-operation') f.page.graphicsBounds[1].operationIndex = 1
  if (kind === 'invalid-operation') delete f.page.graphicsBounds[1].operationIndex
  if (kind === 'invalid-image-geometry') f.page.graphicsBounds[1].paintedNormalizedRect[0] = NaN
  if (kind === 'invalid-graphics') f.page.invalidGraphicsBounds = 1
  if (kind === 'duplicate-image')
    f.page.graphicsBounds.push({ ...f.page.graphicsBounds[1], operationIndex: 100 })
  if (kind === 'small-unpaired-image')
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex: 100,
      normalizedRect: [50 / 600, 151 / 800, 60 / 600, 161 / 800],
      paintedNormalizedRect: [50 / 600, 151 / 800, 60 / 600, 161 / 800]
    })
  if (kind === 'foreign-caption')
    f.captions.push({ page: 2, lines: ['Figure 10: Another owner.'], rect: [40, 175, 280, 185] })
  if (kind === 'intervening-prose')
    f.tokens.push({
      text: 'A separate ordinary paragraph crosses the raster column.',
      horizontal: true,
      rect: [45, 151, 275, 158]
    })
  if (kind === 'short-prose')
    f.tokens.push({ text: 'Other paragraph.', horizontal: true, rect: [45, 151, 275, 158] })
  expect(match(f)).toBeUndefined()
})

it('ignores another column repeating the same subcaption keys with its own source identities', () => {
  const f = fixture()
  f.tokens.push(
    ...f.tokens.map((t: ReturnType<typeof JSON.parse>) => ({
      ...t,
      sourceItem: { ...t.sourceItem, index: t.sourceItem.index + 20 },
      rect: t.rect.map((v: number, i: number) => v + (i % 2 ? 0 : 300))
    }))
  )
  expect(match(f)).toMatchObject({ graphicsCount: 3, rect: [40, 50, 280, 408] })
})

it.each(['full-range', 'partial-range', 'nonhorizontal-range', 'dual-carrier'])(
  'refuses a prefixed label with competing original-source ownership: %s',
  (kind) => {
    const f = fixture()
    const label = f.tokens[0]
    const partial = kind === 'partial-range' || kind === 'nonhorizontal-range'
    const start = partial ? 4 : 0
    const end = partial ? 13 : label.text.length
    const rect = kind === 'dual-carrier' ? [...label.rect] : [400, 500, 460, 508]
    const sourceSegment = { ...label.sourceItem, start, end, rect }
    if (kind === 'dual-carrier') label.sourceSegment = sourceSegment
    else
      f.tokens.push({
        text: label.text.slice(start, end),
        horizontal: kind !== 'nonhorizontal-range',
        height: 8,
        baseline: 508,
        rect,
        sourceSegment
      })
    const before = structuredClone(f)
    expect(match(f)).toBeUndefined()
    expect(f).toEqual(before)
  }
)

it('ignores a measured segment outside the crop belonging to a different original item', () => {
  const f = fixture()
  const label = f.tokens[0]
  const rect = [400, 500, 460, 508]
  f.tokens.push({
    text: label.text,
    horizontal: true,
    height: 8,
    baseline: 508,
    rect,
    sourceSegment: { ...label.sourceItem, index: 99, start: 0, end: label.text.length, rect }
  })
  expect(match(f)).toMatchObject({ graphicsCount: 3, rect: [40, 50, 280, 408] })
})
