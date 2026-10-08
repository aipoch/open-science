import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const {
  proveNativeOrdinalMetricHeader,
  proveNativeRepeatedLeafHeader,
  proveNativeUnruledPairedParentHeader
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const { proveCaptionedNativeDefinitionFrame, hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-evidence.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )

it('separates the printed ordinal from every scientific metric using complete native records', () => {
  const f = fixture('native-ordinal-scientific-lanes'),
    original = structuredClone(f)
  const p = proveNativeOrdinalMetricHeader(f.table, f.tokens, f.captions, f.rules)
  expect(p.columns).toHaveLength(9)
  expect(p.headerCells.map((c: { text: string }) => c.text)).toEqual([
    'ℓ',
    'Ebr',
    'Order',
    'Ebu',
    'Order',
    'Ebv',
    'Order',
    'Ebp',
    'Order'
  ])
  expect(p.bodyRecords).toHaveLength(4)
  expect(p.originalBody.every((i: unknown) => f.tokens.includes(i))).toBe(true)
  expect([...p.ownedTokens].every((i) => f.tokens.includes(i))).toBe(true)
  expect(f).toEqual(original)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules, f.measuredRuns)
  expect(r.grid).toHaveLength(5)
  expect(r.grid.map((row: string[]) => row[0])).toEqual(['ℓ', '0', '1', '2', '3'])
  expect(r.grid.every((row: string[]) => row.length === 9)).toBe(true)
  expect(r.unassigned).toEqual([])
})

it('refuses incomplete, nonsequential or unfenced ordinal records', () => {
  for (const mutation of ['missing-record-value', 'ordinal', 'closing', 'caption']) {
    const f = fixture('native-ordinal-scientific-lanes')
    if (mutation === 'missing-record-value')
      f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '420')
    if (mutation === 'ordinal')
      f.tokens.find(
        (i: { text: string; baseline: number }) => i.text === '0' && i.baseline > 458
      ).text = '7'
    if (mutation === 'closing') f.rules.pop()
    if (mutation === 'caption') f.captions = []
    expect(proveNativeOrdinalMetricHeader(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
})

it('owns separate repeated titles only through literal measured source gaps', () => {
  const f = fixture('native-repeated-literal-header-lanes'),
    original = structuredClone(f)
  const p = proveNativeRepeatedLeafHeader(f.table, f.tokens, f.captions, f.rules, f.measuredRuns)
  expect(p.headerCells.map((c: { text: string }) => c.text)).toEqual([
    'AaBb5',
    'Aa-MAE',
    'Bb-MAE',
    'MAE'
  ])
  expect(p.headerCells.every((c: { rect: number[] }) => c.rect[2] > c.rect[0])).toBe(true)
  expect(f).toEqual(original)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules, f.measuredRuns)
  expect(r.grid[0]).toEqual(['AaBb5', 'Aa-MAE', 'Bb-MAE', 'MAE'])
  expect(r.cells.every((c: { rect: number[] }) => c.rect[2] > c.rect[0])).toBe(true)
  expect(r.unassigned).toEqual([])
})

it('does not use text width estimates or cross-operator gaps to split repeated labels', () => {
  const f = fixture('native-repeated-literal-header-lanes')
  expect(proveNativeRepeatedLeafHeader(f.table, f.tokens, f.captions, f.rules, [])).toBeUndefined()
  for (const r of f.measuredRuns.filter((r: { text: string }) => r.text.includes('MAE ')))
    r.literalGlyphs[0] = 'Z'
  expect(
    proveNativeRepeatedLeafHeader(f.table, f.tokens, f.captions, f.rules, f.measuredRuns)
  ).toBeUndefined()
  const crossing = fixture('native-repeated-literal-header-lanes')
  crossing.tokens.find((i: { text: string }) => i.text.startsWith('13.1 [')).rect[0] = 710
  expect(
    proveNativeRepeatedLeafHeader(
      crossing.table,
      crossing.tokens,
      crossing.captions,
      crossing.rules,
      crossing.measuredRuns
    )
  ).toBeUndefined()
})

it('preserves printed independent parent labels and their exact two-plus-four leaf ownership', () => {
  const f = fixture('native-unruled-independent-parent-lanes'),
    original = structuredClone(f)
  const p = proveNativeUnruledPairedParentHeader(f.table, f.tokens)
  expect(
    p.headerCells
      .slice(0, 3)
      .map((c: { text: string; rowSpan: number; colSpan: number; column: number }) => [
        c.text,
        c.rowSpan,
        c.colSpan,
        c.column
      ])
  ).toEqual([
    ['Requirement', 2, 1, 0],
    ['PPI', 1, 2, 1],
    ['PHI', 1, 4, 3]
  ])
  expect(p.headerCells.slice(3).map((c: { text: string }) => c.text)).toEqual([
    'PHI1',
    'PHI2',
    'PPI1',
    'PPI2',
    'PPI3',
    'PPI4'
  ])
  expect(f).toEqual(original)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules, f.measuredRuns)
  expect(r.grid[0]).toEqual(['Requirement', 'PPI', '', 'PHI', '', '', ''])
  expect(r.grid[1]).toEqual(['', 'PHI1', 'PHI2', 'PPI1', 'PPI2', 'PPI3', 'PPI4'])
})

it('refuses a displaced parent or a missing numbered leaf in the unruled layout', () => {
  const f = fixture('native-unruled-independent-parent-lanes')
  const parent = f.tokens.find((i: { text: string }) => i.text === 'PHI')
  parent.rect[0] += 15
  parent.rect[2] += 15
  expect(proveNativeUnruledPairedParentHeader(f.table, f.tokens)).toBeUndefined()
  const g = fixture('native-unruled-independent-parent-lanes')
  g.tokens = g.tokens.filter((i: { text: string }) => i.text !== 'PPI4')
  expect(proveNativeUnruledPairedParentHeader(g.table, g.tokens)).toBeUndefined()
})

it('recovers a centered single-source section only inside its own full native fences', () => {
  const f = fixture('native-fenced-source-section'),
    original = structuredClone(f)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules, f.measuredRuns)
  expect(r.unassigned).toEqual([])
  const section = r.cells.find(
    (c: { text: string }) => c.text === 'Models shown in source collection C'
  )
  expect(section.colSpan).toBe(7)
  expect(section.origin).toBe('source-fenced-section')
  expect(f).toEqual(original)
  const g = fixture('native-fenced-source-section')
  g.rules = g.rules.filter((r: number[]) => Math.abs(r[1] - 446.739) > 0.02)
  const noFence = refineTable(g.table, g.tokens, g.captions, [], g.rules, g.measuredRuns)
  expect(noFence.unassigned).toContain('Models shown in source collection C')
})

it('proves every parameter record inside the compact frame without borrowing the plot below', () => {
  const f = fixture('native-captioned-parameter-frame'),
    original = structuredClone(f)
  const p = proveCaptionedNativeDefinitionFrame(f.table, f.captions[0], f.tokens, f.rules)
  expect(p.kind).toBe('native-parameter-records')
  expect(p.rows).toHaveLength(6)
  expect(p.columns).toHaveLength(2)
  expect(p.cropRect[1]).toBeLessThan(123)
  expect(p.cropRect[3]).toBeCloseTo(205.2495)
  expect(p.sourceTokens).toHaveLength(
    f.tokens.filter(
      (i: { rect: number[] }) =>
        i.rect[0] >= p.cropRect[0] &&
        i.rect[2] <= p.cropRect[2] + 0.05 &&
        i.rect[1] >= p.cropRect[1] &&
        i.rect[3] <= p.cropRect[3] + 0.05
    ).length
  )
  expect(f).toEqual(original)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules, f.measuredRuns)
  expect(r.grid).toHaveLength(6)
  expect(r.grid.every((row: string[]) => row.length === 2)).toBe(true)
  expect(r.unassigned).toEqual([])
  const caption = { ...f.captions[0], rect: f.captions[0].rect.map((v: number) => v / 1.5) }
  expect(hasTableEvidence(r, caption, f.tokens, f.rules)).toBe(true)
  const g = fixture('native-captioned-parameter-frame')
  g.rules = g.rules.filter((r: number[]) => Math.abs(r[1] - p.cropRect[3]) > 0.02)
  expect(
    proveCaptionedNativeDefinitionFrame(g.table, g.captions[0], g.tokens, g.rules)
  ).toBeUndefined()
})

it('retains exact notation-frame ink as visual proof while refusing a damaged mathematical grid', () => {
  const f = fixture('native-captioned-notation-frame'),
    original = structuredClone(f)
  const p = proveCaptionedNativeDefinitionFrame(f.table, f.captions[0], f.tokens, f.rules)
  expect(p.kind).toBe('native-notation-visual')
  expect(p.headerTokens.map((i: { text: string }) => i.text)).toEqual([
    'Symbol',
    'Meaning',
    'Notes'
  ])
  expect(p.cropRect[3]).toBeCloseTo(387.1665)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules, f.measuredRuns)
  const caption = { ...f.captions[0], rect: f.captions[0].rect.map((v: number) => v / 1.5) }
  expect(hasTableEvidence(r, caption, f.tokens, f.rules)).toBe(false)
  expect(f).toEqual(original)
  const g = fixture('native-captioned-notation-frame')
  g.tokens.find((i: { text: string }) => i.text === 'Meaning').text = 'Equation'
  expect(
    proveCaptionedNativeDefinitionFrame(g.table, g.captions[0], g.tokens, g.rules)
  ).toBeUndefined()
  expect(proveCaptionedNativeDefinitionFrame(f.table, undefined, f.tokens, f.rules)).toBeUndefined()
})
