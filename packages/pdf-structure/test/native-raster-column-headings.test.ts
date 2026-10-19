import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { nativeOwnedRasterColumnHeadings } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-owned-figure-labels.mjs')).href
)
function fixture(columns = 3, rows = 2, scale = 1): ReturnType<typeof JSON.parse> {
  const width = 600 * scale,
    height = 700 * scale,
    em = 8 * scale,
    unit = 500 / columns
  const rect = [50 * scale, 100 * scale, 550 * scale, (100 + rows * 110 - 10) * scale]
  const token = (
    text: string,
    x: number,
    y: number,
    w: number,
    index: number
  ): {
    text: string
    horizontal: boolean
    height: number
    baseline: number
    fontDescent: number
    rect: number[]
    sourceItem: { pageNumber: number; index: number; text: string }
  } => ({
    text,
    horizontal: true,
    height: em,
    baseline: (y + 8) * scale,
    fontDescent: -0.2,
    rect: [x * scale, y * scale, (x + w) * scale, (y + 8) * scale],
    sourceItem: { pageNumber: 1, index, text }
  })
  const tokens = Array.from({ length: columns }, (_, i) =>
    token(
      `(${String.fromCharCode(97 + i)}) Metric ${i + 1}`,
      50 + i * unit + unit / 2 - 30,
      84,
      60,
      i
    )
  )
  const text =
    'Figure 3: Columns ' +
    tokens.map((t: { text: string }) => t.text.slice(0, 3)).join(', ') +
    ' compare the measured responses.'
  const caption = {
    page: 1,
    lines: [text],
    rect: [50 * scale, rect[3] + 10 * scale, 550 * scale, rect[3] + 18 * scale]
  }
  tokens.push(token(text, 50, rect[3] / scale + 10, 500, 20))
  const graphicsBounds = Array.from({ length: columns * rows }, (_, i) => {
    const col = i % columns,
      row = Math.floor(i / columns),
      r = [
        (50 + col * unit) / 600,
        (100 + row * 110) / 700,
        (50 + (col + 1) * unit - 6) / 600,
        (200 + row * 110) / 700
      ]
    return { kind: 'image', operationIndex: i + 30, normalizedRect: r, paintedNormalizedRect: r }
  })
  return {
    page: {
      pageNumber: 1,
      width,
      height,
      invalidGraphicsBounds: 0,
      graphicsBounds,
      lines: tokens.map((t: { text: string; rect: number[] }) => ({
        text: t.text,
        x: t.rect[0],
        y: t.rect[1],
        width: t.rect[2] - t.rect[0],
        height: em,
        fontSize: em
      }))
    },
    figure: { caption, rect, reason: 'native-raster-composite-grid' },
    captions: [caption],
    tables: [],
    tokens,
    foreignOwns: () => false
  }
}
const invoke = (f: ReturnType<typeof fixture>): number[][] | undefined =>
  nativeOwnedRasterColumnHeadings(f.page, f.figure, f.captions, f.tables, f.tokens, f.foreignOwns)
it.each([
  [2, 2, 1],
  [3, 2, 1],
  [4, 3, 1.5]
])(
  'includes complete native column headings on a %s by %s raster grid at scale%s',
  (columns, rows, scale) => {
    const f = fixture(columns, rows, scale)
    expect(invoke(f)).toHaveLength(columns)
  }
)
it.each([
  'missing-source',
  'duplicate-item',
  'segment-alias',
  'partial-segment-alias',
  'nonhorizontal-alias',
  'missing-operator',
  'duplicate-operator',
  'invalid-operator',
  'extra-small-raster',
  'extra-path',
  'foreign-text',
  'missing-label',
  'repeated-key',
  'misaligned-label',
  'missing-raster',
  'overlapping-caption',
  'overlapping-table',
  'other-owner',
  'unknown-paint',
  'unreferenced-keys',
  'not-grid',
  'invalid-glyph-metrics',
  'caption-source-mismatch',
  'caption-source-alias',
  'label-dual-carrier',
  'caption-dual-carrier',
  'label-source-token',
  'caption-source-token'
])('refuses new heading ownership with %s', (variant) => {
  const f = fixture(),
    t = f.tokens[0]
  if (variant.includes('dual-carrier') || variant.includes('source-token')) {
    const target = variant.startsWith('caption-') ? f.tokens.at(-1) : t
    target[variant.includes('dual-carrier') ? 'sourceSegment' : 'sourceToken'] = {
      ...target.sourceItem,
      start: 0,
      end: target.text.length
    }
  }
  if (variant === 'caption-source-mismatch')
    f.tokens.at(-1).sourceItem.text = 'Unrelated description'
  if (variant === 'caption-source-alias') {
    const original = f.tokens.at(-1)
    f.tokens.push({
      ...original,
      rect: [0, 0, 20, 8],
      sourceItem: undefined,
      sourceSegment: { ...original.sourceItem, start: 0, end: 3 }
    })
  }
  if (variant === 'missing-source') delete t.sourceItem
  if (variant === 'duplicate-item') f.tokens.push({ ...t, rect: [0, 0, 20, 8] })
  if (['segment-alias', 'partial-segment-alias', 'nonhorizontal-alias'].includes(variant)) {
    const alias = {
      ...t,
      rect: [0, 0, 20, 8],
      sourceSegment: {
        ...t.sourceItem,
        start: 0,
        end: variant === 'partial-segment-alias' ? 3 : t.text.length,
        rect: [0, 0, 20, 8]
      }
    }
    delete alias.sourceItem
    if (variant === 'nonhorizontal-alias') alias.horizontal = false
    f.tokens.push(alias)
  }
  if (variant === 'missing-operator') delete f.page.graphicsBounds[0].operationIndex
  if (variant === 'duplicate-operator') f.page.graphicsBounds[1].operationIndex = 30
  if (variant === 'invalid-operator') f.page.graphicsBounds[0].operationIndex = -1
  if (variant === 'extra-small-raster')
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex: 99,
      normalizedRect: [0.49, 0.127, 0.5, 0.14],
      paintedNormalizedRect: [0.49, 0.127, 0.5, 0.14]
    })
  if (variant === 'extra-path')
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: 99,
      normalizedRect: [0.49, 0.127, 0.5, 0.14]
    })
  if (variant === 'foreign-text')
    f.tokens.push({
      ...t,
      text: 'Unrelated prose',
      sourceItem: { pageNumber: 1, index: 99, text: 'Unrelated prose' },
      rect: [280, 85, 320, 93]
    })
  if (variant === 'missing-label') f.tokens.splice(1, 1)
  if (variant === 'repeated-key') {
    f.tokens[1].text = '(a) Another metric'
    f.tokens[1].sourceItem.text = f.tokens[1].text
  }
  if (variant === 'misaligned-label') {
    t.rect[0] += 60
    t.rect[2] += 60
  }
  if (variant === 'missing-raster') f.page.graphicsBounds.pop()
  if (variant === 'overlapping-caption')
    f.captions.push({ page: 1, lines: ['Figure 4: Other'], rect: [50, 85, 100, 93] })
  if (variant === 'overlapping-table') f.tables.push([50, 85, 100, 93])
  if (variant === 'other-owner') f.foreignOwns = () => true
  if (variant === 'unknown-paint') f.page.invalidGraphicsBounds = 1
  if (variant === 'unreferenced-keys') f.figure.caption.lines = ['Figure 3: Unrelated description.']
  if (variant === 'not-grid') f.figure.reason = 'generic'
  if (variant === 'invalid-glyph-metrics') t.fontDescent = 2
  expect(invoke(f)).toBeUndefined()
})

it('keeps captions on adjacent pages outside this page ownership', () => {
  const f = fixture()
  f.captions.push({ page: 2, lines: ['Figure 4: Other'], rect: [50, 85, 100, 93] })
  expect(invoke(f)).toHaveLength(3)
})

it('requires the proved native caption source to contain the claimed keys', () => {
  const f = fixture()
  f.tokens.at(-1).text = 'Figure 3: Unrelated description.'
  f.tokens.at(-1).sourceItem.text = f.tokens.at(-1).text
  expect(invoke(f)).toBeUndefined()
})

it.each([
  ['label', 'direct'],
  ['label', 'sourceItem'],
  ['label', 'sourceSegment'],
  ['caption', 'direct'],
  ['caption', 'sourceItem'],
  ['caption', 'sourceSegment']
])('rejects external sourceToken aliases of a %s source through %s', (kind, carrier) => {
  const f = fixture()
  const original = kind === 'caption' ? f.tokens.at(-1) : f.tokens[0]
  const source = { ...original.sourceItem, start: 0, end: 3 }
  f.tokens.push({
    text: 'Other',
    horizontal: false,
    rect: [0, 0, 20, 8],
    sourceToken: carrier === 'direct' ? source : { [carrier]: source }
  })
  expect(invoke(f), carrier).toBeUndefined()
})
