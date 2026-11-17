import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { recoverCaptionSeparatedHeaderCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-header-grid.mjs')).href
)
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids', `${name}.jsonl`))

it('excludes a grazing caption inside the proved gap above complete underlined count headings', () => {
  const f = load('clipped-probabilities-inside-native-count-footer')
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.cropRect[1]).toBeCloseTo(717.77985, 5)
  expect(r.cropRect[1]).toBeGreaterThan(f.captions[0].rect[3])
  expect(r.cropRect[1]).toBeLessThan(
    Math.min(...f.tokens.map((i: { rect: number[] }) => i.rect[1]))
  )
  expect(r.grid).toHaveLength(19)
  expect(r.clipped).toEqual([])
  expect(r.unassigned).toEqual([])
})

it.each([
  ['caption-tail-above-segmented-native-frame', 139.78325],
  ['caption-tail-above-wide-native-frame', 126.97805],
  ['short-caption-tail-above-double-stroke-frame', 112.27846409082045]
] as const)('keeps every header glyph above the closing frame for %s', (name, expected) => {
  const f = load(name)
  const crop = recoverCaptionSeparatedHeaderCrop(f.table, f.tokens, f.captions, f.rules)
  expect(crop?.[1]).toBeCloseTo(expected, 5)
  expect(crop?.[1]).toBeGreaterThan(f.captions[0].rect[3])
  expect(crop?.[1]).toBeLessThan(Math.min(...f.tokens.map((i: { rect: number[] }) => i.rect[1])))
  expect(crop?.filter((_: number, n: number) => n !== 1)).toEqual(
    f.table.cropRect.filter((_: number, n: number) => n !== 1)
  )
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.cropRect[1]).toBeCloseTo(expected, 5)
})

it.each(['ambiguous', 'overlap', 'caption', 'footer', 'header', 'body'])(
  'declines caption cropping without complete %s proof',
  (kind) => {
    const f = load('caption-tail-above-segmented-native-frame')
    if (kind === 'ambiguous') f.captions.push(structuredClone(f.captions[0]))
    if (kind === 'overlap') f.captions[0].rect[3] = 140
    if (kind === 'caption') f.captions = []
    if (kind === 'footer') f.rules = f.rules.filter((r: number[]) => r[1] < 700)
    if (kind === 'header') f.rules = f.rules.filter((r: number[]) => r[1] > 150)
    if (kind === 'body')
      f.tokens = f.tokens.filter((i: { text: string }) => !/^[<>≤≥−-]?\d/.test(i.text))
    expect(
      recoverCaptionSeparatedHeaderCrop(f.table, f.tokens, f.captions, f.rules)
    ).toBeUndefined()
  }
)

it('requires the footer and complete count leaves when no full-width top stroke exists', () => {
  const f = load('clipped-probabilities-inside-native-count-footer')
  f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '%')
  expect(recoverCaptionSeparatedHeaderCrop(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})

it('retains the native segmented top stroke and every paired-cohort source record', () => {
  const f = readPdfFixture(
    resolve('test/fixtures/paired-cohort-summary-with-source-parent-rules.jsonl')
  )
  const crop = recoverCaptionSeparatedHeaderCrop(f.table, f.items, f.captions, f.rules)
  expect(crop?.[1]).toBeGreaterThan(f.captions[0].rect[3])
  expect(crop?.[1]).toBeLessThan(141.0150315)
  const result = refineTable(f.table, f.items, f.captions, f.notes, f.rules)
  expect(result.grid).toHaveLength(54)
  expect(result.grid).toContainEqual(['Anti-hormonal therapy, %', '', '', '', '', '0.558'])
  expect(result.unassigned).toEqual([])
})

it.each(['closed', 'missing leaf', 'missing value', 'competing caption'] as const)(
  'recovers an inset two-group table only with complete native evidence (%s)',
  (kind) => {
    const table = { cropRect: [20, 195, 565, 300], structure: { objects: [] } }
    const rect = [330, 170, 592, 195]
    const captions = [{ rect, lines: ['Table 1: Trial quality across datasets.'] }]
    if (kind === 'competing caption')
      captions.push({ rect: [331, 346, 591, 365], lines: ['Table 2: Another experiment.'] })
    const rules = [
      [334, 213, 587, 213],
      [375, 252, 463, 252],
      [482, 252, 587, 252],
      [334, 277, 587, 277],
      [334, 364, 587, 364]
    ]
    const token = (
      text: string,
      x: number,
      baseline: number,
      height = 10
    ): {
      text: string
      horizontal: boolean
      height: number
      baseline: number
      rect: number[]
    } => ({
      text,
      horizontal: true,
      height,
      baseline,
      rect: [x, baseline - height, x + 24, baseline]
    })
    const xs = [379, 425, 490, 549]
    const items = [
      token('Trial', 343, 254),
      token('Training', 408, 247),
      token('Testing', 517, 247),
      ...xs.flatMap((x, n) =>
        kind === 'missing leaf' && n === 3 ? [] : [token(n % 2 ? 'High' : 'Low', x, 267)]
      ),
      ...[301, 323, 345].flatMap((y, row) => [
        token(String.fromCharCode(65 + row), 343, y, 20),
        ...xs.flatMap((x, col) =>
          kind === 'missing value' && row === 2 && col === 3 ? [] : [token('1.25', x, y, 20)]
        )
      ])
    ]
    const crop = recoverCaptionSeparatedHeaderCrop(table, items, captions, rules)
    expect(crop).toEqual(kind === 'closed' ? [333.5, 212.5, 587.5, 364.5] : undefined)
  }
)
