import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { findCaptionCandidates, captionKind } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const { associateFigures, associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const fixture = (name: string): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )
const parse = (name: string, index = 0): ReturnType<typeof refineTable> => {
  const f = fixture(name),
    rules = f.rules.map((r: number[]) => r.map((v) => v / 1.5))
  const captions = findCaptionCandidates([f.page], new Map([[f.page.pageNumber, rules]]))
  const scaled = captions.map((c: { rect: number[] }) => ({
    ...c,
    rect: c.rect.map((v) => v * 1.5)
  }))
  const first = f.tables.map((t: object) => refineTable(t, f.tokens, scaled, [], f.rules))
  const rects = first.map((t: { cropRect: number[]; rows: { rect: number[] }[] }) => ({
    rect: [
      t.cropRect[0],
      Math.min(...t.rows.map((r) => r.rect[1])),
      t.cropRect[2],
      Math.max(...t.rows.map((r) => r.rect[3]))
    ].map((v) => v / 1.5)
  }))
  const notes = associateTableNotes(f.page, rects, rules)
  const result = refineTable(
    f.tables[index],
    f.tokens,
    scaled,
    notes[index].map((n: { rect: number[] }) => ({ ...n, rect: n.rect.map((v) => v * 1.5) })),
    f.rules
  )
  return {
    ...result,
    notes: notes[index],
    caption: associateTableCaptions(f.page, rects, captions, rules)[index]
  }
}

it.each([
  ['cohort-age-ranges', 0],
  ['demographics-side-continuation', 0],
  ['omitted-interaction-coefficient', 0],
  ['overlapping-stage-counts', 0],
  ['mixed-cohort-statistics', 0],
  ['boxed-cohort-continuation', 0],
  ['parallel-header-prefix', 0],
  ['clinical-timepoint-contrasts', 0],
  ['adherence-bin-distribution', 0],
  ['graded-expression-notes', 0],
  ['graded-expression-notes', 1]
])('preserves source ownership in %s (%s)', (name, index) => {
  const result = parse(String(name), Number(index))
  expect(result.issues).toEqual([])
  expect(result.unassigned).toEqual([])
})
it('restores age ranges and keeps endocrine therapy separate from axillary treatment', () => {
  const { grid, notes } = parse('cohort-age-ranges')
  expect(grid.some((r: string[]) => r[0] === 'Endocrine therapy')).toBe(true)
  expect(grid.flat().some((s: string) => /\(\d+[–-]\d+\)/.test(s))).toBe(true)
  expect(notes.some((n: { text: string }) => n.text.startsWith('Bold indicates'))).toBe(true)
})
it('keeps the omitted interaction coefficients together and leaves the second model empty', () => {
  expect(
    parse('omitted-interaction-coefficient').grid.find((r: string[]) => r[1] === 'SE × C')
  ).toEqual(['', 'SE × C', '−0.072', '−0.013 (−0.040, 0.015)', '−0.745', '.456', '', '', '', ''])
})
it('restores both stage-zero counts beneath the correct follow-up heading', () => {
  const grid = parse('overlapping-stage-counts').grid
  expect(grid).toContainEqual(['0', '6 (33.3%)', '2 (11.8%)', ''])
  expect(grid.filter((r: string[]) => r[0] === '0')).toHaveLength(2)
})
it('alternates independent summary subcolumns and merged categorical counts', () => {
  const result = parse('mixed-cohort-statistics')
  expect(result.grid).toHaveLength(65)
  expect(result.grid).toContainEqual([
    'Age, yr, mean ± SD',
    '174 (0)',
    '58 ± 13',
    '178 (0)',
    '58 ± 14'
  ])
  expect(result.cells).toContainEqual(expect.objectContaining({ text: '94 (54.3)', colSpan: 2 }))
  expect(result.notes.map((n: { text: string }) => n.text).join(' ')).toContain(
    'excluding missing data'
  )
})
it('keeps all boxed continuation rows and the full note outside data cells', () => {
  const r = parse('boxed-cohort-continuation')
  expect(r.grid).toHaveLength(21)
  expect(r.grid.at(-1)).toEqual([
    'Circulating tumor cells positivity, cut-off value: ≥5 cell/7.5ml blood',
    '18 (17.1)',
    '15 (15.2)'
  ])
  expect(r.notes.map((n: { text: string }) => n.text).join(' ')).toContain(
    'European Group on Tumor Markers.'
  )
  expect(r.grid.flat().join(' ')).not.toContain('Data are mean')
})
it('preserves all clinical timepoints and literal source punctuation', () => {
  const r = parse('clinical-timepoint-contrasts')
  expect(r.grid).toHaveLength(53)
  expect(r.grid.filter((row: string[]) => row[0] === '8 week Intervention')).toHaveLength(7)
  expect(r.grid.flat()).toContain('3.5 (1.8; (2.9 to 4.1)')
})
it('keeps each adherence distribution and its shared outcome label', () => {
  const r = parse('adherence-bin-distribution')
  expect(r.grid).toHaveLength(42)
  expect(r.cells.filter((c: { rowSpan: number }) => c.rowSpan === 4)).toHaveLength(9)
  expect(r.grid.flat().join(' ')).toContain('≥5% of increase')
})
it.each([
  'mixed-cohort-statistics',
  'clinical-timepoint-contrasts',
  'adherence-bin-distribution',
  'boxed-cohort-continuation'
])('declines source reconstruction with missing structural evidence in %s', (name) => {
  const f = fixture(name),
    original = structuredClone(f)
  const r = refineTable(f.tables[0], f.tokens, [], [], [])
  expect(r.repairs).not.toContain('closed-record-grid-recovered')
  expect(f).toEqual(original)
})
it('does not close a cohort face across a missing side border', () => {
  const f = fixture('boxed-cohort-continuation')
  const rules = f.rules.filter((r: number[]) => !(r[0] === r[2] && r[0] > 810))
  const r = refineTable(f.tables[0], f.tokens, f.captions, [], rules)
  expect(r.repairs).not.toContain('closed-record-grid-recovered')
  expect(r.unassigned.length).toBeGreaterThan(0)
})
it('requires the declared pair of statistical formats before merging cohort values', () => {
  const f = fixture('mixed-cohort-statistics')
  const r = refineTable(
    f.tables[0],
    f.tokens.filter((i: { text: string }) => i.text !== 'Nominal and ordinal data'),
    f.captions,
    [],
    f.rules
  )
  expect(r.grid).not.toHaveLength(65)
})
it.each([
  'inset-conceptual-figure',
  'clinical-panel-and-trial-notes',
  'ruled-forest-panel',
  'appendix-continued-plate',
  'unnumbered-figure-label'
])('associates the source figure in %s', (name) => {
  const f = fixture(name),
    rules = f.rules.map((r: number[]) => r.map((v) => v / 1.5))
  const cs = findCaptionCandidates([f.page], new Map([[f.page.pageNumber, rules]]))
  const figures = associateFigures(f.page, cs, [], rules)
  expect(figures).toHaveLength(1)
  expect(figures[0].rect).toBeDefined()
  expect(figures[0].ambiguity).toBeUndefined()
})
it.each(['Figure 3—Continued.', 'Appendix Figure 3—Continued.', 'Figure. Outcome trends'])(
  'recognizes %s without changing its displayed text',
  (text) => expect(captionKind(text)).toBe('figure')
)
it.each([
  'Figure 3 but the effect was small',
  'Figure 2 (available online)',
  'Appendix Figure 3 shows the result'
])('rejects inline reference %s', (text) => expect(captionKind(text)).toBeUndefined())

it.each([
  ['paired-risk-records', 0],
  ['repeated-event-headers', 0],
  ['section-heading-alternatives', 0],
  ['sectioned-outcome-records', 0],
  ['numeric-record-span-conflict', 0],
  ['wrapped-quartile-records', 0],
  ['appendix-cohort-counts', 0],
  ['single-acronym-note', 0],
  ['open-top-group-header', 2],
  ['trailing-score-counts', 0]
])('resolves independently verified native structure in %s', (name, index) => {
  const result = parse(String(name), Number(index))
  expect(result.issues).toEqual([])
  expect(result.unassigned).toEqual([])
})
it('retains a cited single-acronym note outside the table body', () => {
  const r = parse('single-acronym-note')
  expect(r.notes[0].text).toBe(
    "ASA, American Society of Anaesthesiologists' physical status grade."
  )
  expect(r.grid.flat().join(' ')).not.toContain('American Society')
})
it('recovers the native open-top header and its shared stub', () => {
  const r = parse('open-top-group-header', 2)
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 0, text: 'Month', colSpan: 2 })
  )
  expect(r.grid.at(-1)).toEqual(['', 'NRS ≥ 4 (yes/no)', '5 (16%)', '2 (6%)', '0.228'])
  expect(r.grid[0].at(-1)).toBe('P-valuea')
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 1, column: 0, text: '1', rowSpan: 2 })
  )
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 3, column: 0, text: '6', rowSpan: 2 })
  )
})
it('keeps median headings, quartile continuations and P markers in their source columns', () => {
  const r = parse('wrapped-quartile-records')
  expect(r.grid).toHaveLength(10)
  expect(r.cells).toContainEqual(expect.objectContaining({ row: 0, column: 1, colSpan: 2 }))
  expect(r.grid[1].slice(7)).toEqual(['Pa', 'Pb,c', 'Pb,d', 'Pb,e'])
  expect(r.grid.find((v: string[]) => v[0] === 'Cmax (ng/mL)')?.[1]).toBe('0.35 (0.31–0.49)')
  expect(r.grid.find((v: string[]) => v[0] === 't1/2')?.[5]).toBe('329.34 (154.19–624.51)')
})
it('does not rebuild quartile records without native parent underlines', () => {
  const f = fixture('wrapped-quartile-records')
  const r = refineTable(f.tables[0], f.tokens, f.captions, [], [])
  expect(r.repairs).not.toContain('quartile-comparison-grid-recovered')
})
it('does not reconstruct an open-top header from disconnected vertical endpoints', () => {
  const f = fixture('open-top-group-header')
  const rules = f.rules.filter(
    (r: number[]) => !(r[0] === r[2] && r[0] > 460 && r[0] < 470 && r[1] < 380)
  )
  const r = refineTable(f.tables[2], f.tokens, f.captions, [], rules)
  expect(r.cropRect[2]).toBe(f.tables[2].cropRect[2])
})
it('does not attach an uncited single-acronym definition', () => {
  const f = fixture('single-acronym-note')
  for (const line of f.page.lines) line.text = line.text.replace(/^ASA,/, 'XYZ,')
  const r = parse('single-acronym-note')
  const tables = [
    {
      rect: [r.cropRect[0], r.rows[0].rect[1], r.cropRect[2], r.rows.at(-1).rect[3]].map(
        (v: number) => v / 1.5
      )
    }
  ]
  expect(
    associateTableNotes(
      f.page,
      tables,
      f.rules.map((r: number[]) => r.map((v) => v / 1.5))
    )
  ).toEqual([[]])
})
it('matches repeated full captions to the explicit legend section only in order', async () => {
  const { matchFigureSequence } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-sequence.mjs')).href
  )
  const f = fixture('repeated-plate-legends')
  const pages = f.pages.map(
    (p: {
      pageNumber: number
      lines: { text: string; x: number; y: number; width: number; height: number }[]
    }) => ({
      ...p,
      lines: p.lines
        .filter((l) => !/^\d+$/.test(l.text.trim()) || l.y >= 45)
        .map((l) => ({ ...l, right: l.x + l.width, bottom: l.y + l.height }))
    })
  )
  expect([...matchFigureSequence(pages).keys()]).toEqual([31, 32, 33])
  expect([
    ...matchFigureSequence([pages[0], pages[2], pages[1], ...pages.slice(3)]).keys()
  ]).toEqual([])
})
it('retains both cohort children under the appendix BSO heading', () => {
  const r = parse('appendix-cohort-counts')
  expect(r.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 1, text: 'BSO Status', colSpan: 2 })
  )
  expect(r.grid[1].slice(1, 3)).toEqual(['Yes (n = 4049)', 'No (n = 5890)'])
  expect(
    r.grid.some(
      (row: string[]) =>
        row[0].startsWith('Age when ovaries removed') && row[0].includes('(no-BSO group)')
    )
  ).toBe(true)
  expect(r.grid.some((row: string[]) => row[0].startsWith('(no-BSO'))).toBe(false)
})
it.each([
  ['publication-cover-metadata', 0],
  ['protocol-resource-links', 2],
  ['prose-overhang-fragment', 0]
])('rejects non-table source evidence in %s', async (name, index) => {
  const { hasTableEvidence } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-evidence.mjs')).href
  )
  const f = fixture(String(name)),
    t = refineTable(f.tables[Number(index)], f.tokens, [], [], f.rules)
  expect(hasTableEvidence(t, undefined, f.tokens)).toBe(false)
})
it('deduplicates a nested partial table only with a single shared caption and full source coverage', async () => {
  const { deduplicateTableRegions } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-regions.mjs')).href
  )
  const f = fixture('nested-partial-table')
  const captions = f.captions.filter(
    (c: { lines: string[] }) => captionKind(c.lines[0]) === 'table'
  )
  expect(deduplicateTableRegions(f.tables, f.tokens, captions)).toEqual([f.tables[0]])
  expect(deduplicateTableRegions(f.tables, f.tokens, [...captions, ...captions])).toHaveLength(2)
  expect(deduplicateTableRegions(f.tables, [], captions)).toHaveLength(2)
})
const figuresOf = (name: string): ReturnType<typeof associateFigures> => {
  const f = fixture(name),
    rules = f.rules.map((r: number[]) => r.map((v) => v / 1.5))
  return associateFigures(
    f.page,
    findCaptionCandidates([f.page], new Map([[f.page.pageNumber, rules]])),
    [],
    rules
  )
}
it('keeps stacked marginal plots inside their separate complete native frames', () => {
  const f = figuresOf('stacked-marginal-plots')
  expect(f).toHaveLength(2)
  expect(f[0].rect[3]).toBeLessThan(f[1].rect[1])
  expect(f[1].rect[1]).toBeGreaterThan(390)
})
it('retains the upper randomization frame beside a top figure number', () => {
  const f = figuresOf('top-numbered-flow-plate')[0]
  expect(f.rect[1]).toBeLessThan(15)
  expect(f.rect[3]).toBeGreaterThan(520)
})
it('preserves the full ruled figure legend and a title close to its number', () => {
  const f = figuresOf('ruled-figure-legend')[0]
  expect(f.rect[3]).toBeGreaterThan(730)
  expect(f.caption.lines.join(' ')).toContain('37%')
  expect(figuresOf('close-figure-title')[0].rect[1]).toBeLessThan(79)
})
it.each([
  ['raster-side-prose', 300, 58],
  ['raster-tagging-header', 37, 50],
  ['raster-page-decoration', 55, 85]
])('excludes external text or page decoration in %s', (name, x, y) => {
  const r = figuresOf(String(name))[0].rect
  expect(r[0]).toBeGreaterThan(Number(x))
  expect(r[1]).toBeGreaterThan(Number(y))
})

it('keeps owned table notes and publisher tags out of an adjacent photograph panel', () => {
  const f = fixture('reported-summary-notes'),
    rules = f.rules.map((r: number[]) => r.map((v) => v / 1.5)),
    tableNotes = f.tables.flatMap(
      (_: object, index: number) => parse('reported-summary-notes', index).notes
    ),
    result = associateFigures(
      f.page,
      findCaptionCandidates([f.page]),
      tableNotes.map((n: { rect: number[] }) => n.rect),
      rules
    )
  expect(result).toHaveLength(1)
  expect(result[0].rect[0]).toBeGreaterThan(54)
  expect(result[0].rect[1]).toBeGreaterThan(478)
  expect(result[0].rect[3]).toBeGreaterThan(732)
})
it('excludes a full-width journal header with a year before its author list', () => {
  const r = figuresOf('prose-overhang-fragment')[0].rect
  expect(r[1]).toBeGreaterThan(65)
})
