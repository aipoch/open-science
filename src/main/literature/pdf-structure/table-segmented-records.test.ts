import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const runtime = (name: string): string =>
  pathToFileURL(resolve('resources/pdf-structure', name)).href
const { refineTable, hasTableEvidence } = await import(runtime('literature-pdf-table-refine.mjs'))
const { recoverSegmentedRecordGrid } = await import(
  runtime('literature-pdf-segmented-record-grid.mjs')
)
const { recoverSectionedCoefficientsGrid } = await import(
  runtime('literature-pdf-regression-grid.mjs')
)
const { findCaptionCandidates } = await import(runtime('literature-pdf-caption-group.mjs'))
const { associateGraphicalTables } = await import(runtime('literature-pdf-association.mjs'))
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
const refine = (x: ReturnType<typeof load>): ReturnType<typeof refineTable> =>
  refineTable(x.table, x.tokens, x.captions, [], x.rules)
it('separates demographic records inside tall native cells without changing percentages', () => {
  const x = load('segmented-demographics'),
    before = structuredClone(x),
    t = refine(x)
  expect(t.grid).toHaveLength(44)
  expect(t.unassigned).toEqual([])
  expect(x).toEqual(before)
  expect(t.grid.flat().filter((s: string) => s.includes('%')).length).toBeGreaterThan(30)
})
it('keeps all continuation records and does not append a raised footnote to the last measurement', () => {
  const t = refine(load('segmented-demographics-continuation'))
  expect(t.grid).toHaveLength(28)
  expect(t.grid.at(-1)).toEqual(['Median (minimum, maximum)', '270 (45, 1020)', '220 (0, 1020)'])
  expect(t.grid).toContainEqual(['Radiotherapy, n (%)', '21 (80.7%)', '23 (88.5%)'])
  expect(t.unassigned).toContain('Included volunteer or non')
})
it('preserves all ten dose-schedule columns including intentional empty intervals', () => {
  const t = refine(load('segmented-dose-schedule'))
  expect(t.grid[0]).toEqual([
    'Weeks since starting therapy',
    '0',
    '2',
    '4',
    '6',
    '8',
    '10',
    '12',
    '14',
    '16'
  ])
  expect(t.grid[1].slice(-2)).toEqual(['5', '10'])
  expect(t.grid).toHaveLength(3)
  expect(t.unassigned).toEqual([])
})
it.each(['missing-rule', 'shifted-rule', 'duplicate-token'])(
  'declines unsupported segmented records: %s',
  (kind) => {
    const x = load('segmented-demographics')
    if (kind === 'missing-rule') x.rules = []
    if (kind === 'shifted-rule') {
      const bands = x.rules.filter((r: number[]) => r[1] === r[3] && r[0] > 400)
      bands[Math.floor(bands.length / 2)][0] += 3
    }
    if (kind === 'duplicate-token')
      x.tokens.push(
        structuredClone(
          x.tokens.find(
            (i: { text: string; rect: number[] }) =>
              i.text.includes('%') &&
              i.rect[1] > x.table.cropRect[1] &&
              i.rect[3] < x.table.cropRect[3]
          )
        )
      )
    expect(recoverSegmentedRecordGrid(x.table, x.tokens, x.rules)).toBeUndefined()
  }
)
it.each(['sectioned-coefficients', 'sectioned-coefficients-header'])(
  'restores coefficient headings and ruled section spans: %s',
  (name) => {
    const x = load(name),
      before = structuredClone(x),
      t = refine(x)
    expect(t.grid[0]).toEqual(['Predictor', 'β', 'SEM', 'df', 't', 'p'])
    expect(t.cells.filter((c: { colSpan: number }) => c.colSpan === 6)).toHaveLength(3)
    expect(t.unassigned).toEqual([])
    expect(x).toEqual(before)
    expect(t.grid).toContainEqual(
      name === 'sectioned-coefficients'
        ? ['Time (days)', '-0.00', '0.01', '363', '-1.59', '.558']
        : ['Total Practice (10 minute units)', '-0.06', '0.02', '298', '-3.39', '.001**']
    )
  }
)
it.each(['missing-value', 'missing-header', 'missing-rules'])(
  'does not guess incomplete coefficients: %s',
  (kind) => {
    const x = load('sectioned-coefficients')
    if (kind === 'missing-value')
      x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '1.48')
    if (kind === 'missing-header')
      x.tokens = x.tokens.filter((i: { text: string }) => i.text !== 'SEM')
    if (kind === 'missing-rules') x.rules = []
    expect(recoverSectionedCoefficientsGrid(x.table, x.tokens, x.rules)).toBeUndefined()
  }
)
it('rejects a paragraph split into columns even when the detector adds an empty column', () => {
  const x = load('prose-empty-column')
  expect(hasTableEvidence(refine(x), null, x.tokens)).toBe(false)
  expect(hasTableEvidence(refine(x), { lines: ['Table 1. Narrative data'] }, x.tokens)).toBe(true)
})
it('recovers an outlined table image with detection evidence without fabricating a text grid', () => {
  const { page, input } = load('outlined-table-page'),
    caps = findCaptionCandidates([page])
  expect(associateGraphicalTables(page, caps)).toEqual([])
  const matches = associateGraphicalTables(
    page,
    caps,
    [],
    input.tables.map((t: { cropRect: number[] }) => t.cropRect.map((v) => v / 1.5))
  )
  expect(matches).toHaveLength(1)
  expect(matches[0].caption.lines[0]).toMatch(/^Table 3\./)
  expect(matches[0].rect[3]).toBeGreaterThan(420)
  expect(matches[0].rect[3]).toBeLessThan(460)
})
it('collects the complete double-spaced title bounded by the statistical table', () => {
  const { page, input } = load('double-spaced-caption-page')
  const captions = findCaptionCandidates(
    [page],
    new Map([[page.pageNumber, input.rules.map((r: number[]) => r.map((v) => v / 1.5))]])
  )
  expect(captions[0].lines).toHaveLength(4)
  expect(captions[0].lines.at(-1)).toMatch(/Two Preceeding Days\.$/)
  expect(captions[0].lines.join(' ')).not.toContain('Predictor')
})
it('retains the final wrapped comparison label instead of dropping its second time point', () => {
  const t = refine(load('trailing-comparison-label'))
  expect(t.grid.at(-1)).toEqual(['TP3 vs TP4', '4', '87', '87/87', '<0.001'])
  expect(t.unassigned).not.toContain('TP4')
})
it('restores the last complete classification record from its repeated column pattern', () => {
  const t = refine(load('trailing-classification-record'))
  expect(t.grid.at(-1)).toEqual(['', '', 'TP3', '87', '57', '26/88', '0.2210'])
  expect(t.unassigned).not.toContain('0.2210')
})
it('leaves an incomplete final classification record unassigned rather than guessing its missing field', () => {
  const x = load('trailing-classification-record')
  x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '0.2210')
  const t = refine(x)
  expect(t.repairs).not.toContain('trailing-numeric-record-recovered')
  expect(t.unassigned).toContain('26/88')
})
