import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverEnrichmentGrid, recoverAlignedNumericGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-aligned-numeric-grid.mjs')).href
)
const { recoverEstimateIntervalGrid, recoverMixedCohortGrid, recoverStratifiedIntervalGrid } =
  await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-wrapped-summary-grid.mjs')).href
  )
const { recoverDeviationGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-deviation-grid.mjs')).href
)
const { recoverRuledEffectGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-effect-grid.mjs')).href
)
const { recoverRegressionGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-regression-grid.mjs')).href
)
type Fixture = {
  cropRect: number[]
  objects: { label: string; rect: number[] }[]
  caption: { lines: string[]; rect: number[] }
  rules: number[][]
  tokens: [string, number, number, number, number, number, number][]
}
function fixture(name: string): {
  table: { cropRect: number[]; structure: { objects: Fixture['objects'] } }
  tokens: { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }[]
  captions: Fixture['caption'][]
  rules: number[][]
} {
  const f: Fixture = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
  return {
    table: { cropRect: f.cropRect, structure: { objects: f.objects } },
    tokens: f.tokens.map(([text, l, t, r, b, baseline, height]) => ({
      text,
      rect: [l, t, r, b],
      baseline,
      height,
      horizontal: true
    })),
    captions: [f.caption],
    rules: f.rules
  }
}
const cases = [
  ['enrichment', recoverEnrichmentGrid, 9, 5, '7.092E-5'],
  ['estimate-interval', recoverEstimateIntervalGrid, 11, 9, 'GM'],
  ['mixed-cohort', recoverMixedCohortGrid, 36, 9, 'Mean'],
  ['stratified-interval', recoverStratifiedIntervalGrid, 8, 10, 'Control'],
  ['separate-deviation', recoverDeviationGrid, 25, 6, 'Vitamin A (retinol-mg/L)'],
  ['complete-numeric', recoverAlignedNumericGrid, 17, 8, 'cPP']
] as const
it.each(cases)(
  'recovers %s records from native geometry without dropping source text',
  (name, recover, rows, columns) => {
    const f = fixture(name),
      original = structuredClone(f)
    const recovered = recover(f.table, f.tokens, f.captions, f.rules)
    expect(recovered?.rows).toHaveLength(rows)
    expect(recovered?.columns).toHaveLength(columns)
    const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
    expect(t.grid).toHaveLength(rows)
    expect(t.grid[0]).toHaveLength(columns)
    expect(t.unassigned).toEqual([])
    const assigned = t.cells
      .flatMap((c: { sourceTokens: { text: string }[] }) => c.sourceTokens.map((i) => i.text))
      .sort()
    // All original tokens, including interval lines and literal zeroes, occur once.
    expect(assigned).toEqual(f.tokens.map((i) => i.text).sort())
    expect(f).toEqual(original)
  }
)
it.each(cases)('declines %s recovery without a table caption', (name, recover) => {
  const f = fixture(name)
  expect(recover(f.table, f.tokens, [], f.rules)).toBeUndefined()
})
it.each(cases.slice(0, -1))(
  'declines %s recovery when a body value is missing',
  (name, recover) => {
    const f = fixture(name)
    const grid = recover(f.table, f.tokens, f.captions, f.rules)
    const bounds = grid.columns[name === 'stratified-interval' ? 2 : 1]
    const value = f.tokens.findLastIndex(
      (i) =>
        i.rect[0] >= bounds[0] && i.rect[2] <= bounds[2] && /^\d+(?:\.\d+)?(?:E-\d+)?$/.test(i.text)
    )
    expect(value).toBeGreaterThan(-1)
    f.tokens.splice(value, 1)
    expect(recover(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)
it('preserves paired cohort counts above separate mean and standard-deviation columns', () => {
  const f = fixture('mixed-cohort'),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(
    t.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 2)
  ).toHaveLength(4)
  expect(
    t.cells.some(
      (c: { row: number; colSpan: number; text: string }) =>
        c.row > 0 && c.colSpan === 2 && /\d+\s*\(/.test(c.text)
    )
  ).toBe(true)
})
it('retains shared stratum labels and trend values across exactly three rows', () => {
  const f = fixture('stratified-interval'),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.cells.filter((c: { rowSpan: number }) => c.rowSpan === 3)).toHaveLength(6)
})

it('recovers repeated effect records above a ruled note boundary', () => {
  const f = fixture('ruled-effect'),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid).toHaveLength(7)
  expect(t.grid[0]).toHaveLength(4)
  expect(t.unassigned).toEqual([])
  expect(recoverRuledEffectGrid(f.table, f.tokens, f.captions, [])).toBeUndefined()
  expect(recoverRuledEffectGrid(f.table, f.tokens, [], f.rules)).toBeUndefined()
})
it('retains regression sections and deliberately empty model summaries', () => {
  const f = fixture('regression'),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid).toHaveLength(30)
  expect(t.unassigned).toEqual([])
  expect(
    t.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 4)
  ).toHaveLength(2)
  expect(t.grid[4].slice(7)).toEqual(['', ''])
  expect(recoverRegressionGrid(f.table, f.tokens, [])).toBeUndefined()
  const damaged = f.tokens.filter((i) => i.text !== '0.18')
  expect(recoverRegressionGrid(f.table, damaged, f.captions)).toBeUndefined()
})
it('restores ruled group headings and keeps a wrapped interval in its original record', () => {
  const f = fixture('grouped-interval'),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(
    t.cells
      .filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan > 1)
      .map((c: { colSpan: number }) => c.colSpan)
  ).toEqual([2, 2, 3])
  expect(t.grid[4][0]).toBe('PROG')
  expect(t.grid[4][6]).toBe('(− 12.95, − 4.84)')
  expect(t.grid[5][6]).toBe('(3.29, 10.73)')
  expect(t.unassigned).toEqual([])
  const unruled = refineTable(f.table, f.tokens, f.captions, [], [])
  expect(
    unruled.cells.some((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 3)
  ).toBe(false)
})
it('includes native header ascenders clipped by a predicted row boundary', () => {
  const f = fixture('clipped-header'),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid[0]).toEqual(['AE', '6 FEC (n = 1509)', '6 ED (n = 1480)', 'p'])
  expect(t.unassigned).toEqual([])
})

it('restores a standalone stub header bounded by native horizontal rules', () => {
  const f = fixture('stub-header'),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid[0][0]).toBe('Characteristic')
  expect(t.unassigned).toEqual([])
  const unruled = refineTable(f.table, f.tokens, f.captions, [], [])
  expect(unruled.unassigned).toContain('Characteristic')
})

it('uses separate dotted group leaders while retaining literal missing-value dots', () => {
  const f = fixture('dotted-header'),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid[0]).toEqual([
    '',
    'Statin (n = 53)',
    '',
    'Placebo (n = 55)',
    '',
    'Between Groups',
    ''
  ])
  expect(
    t.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 2)
  ).toHaveLength(3)
  expect(t.grid[1][1]).toBe('Pre- anthracycline')
})
it('keeps an overhanging mean/SD heading above its paired numeric column', () => {
  const f = fixture('overhanging-header'),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid[0].slice(0, 3)).toEqual(['', 'Mean (SD) AGD (mGy)', 'Mean (SD) AGD (mGy)'])
  const different = f.tokens.map((i) =>
    i.text === 'Mean (SD) AGD (mGy)' && i.rect[0] > 400 ? { ...i, text: 'Other statistic' } : i
  )
  expect(refineTable(f.table, different, f.captions, [], f.rules).grid[0][0]).toBe(
    'Mean (SD) AGD (mGy)'
  )
})

it('retains native header evidence when numeric record rows are reconstructed', () => {
  const f = fixture('sample-size-header'),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid[0]).toEqual(['Characteristics', 'FEC arm (n = 1515)', 'ED arm (n = 1494)'])
  expect(t.grid[1]).toEqual(['Median age, years (range)', '50 (23–65)', '50 (22–66)'])
  expect(t.repairs).toContain('text-supported-numeric-rows-recovered')
  expect(t.unassigned).toEqual([])
})

it('recovers a terminal categorical record while preserving empty statistic columns', () => {
  const f = fixture('sparse-terminal')
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid.at(-1)).toEqual(['Not assessed', '214', '209', '196', '', '', '', '', '', ''])
  expect(t.unassigned).toEqual([])
  const assigned = t.cells
    .flatMap((c: { sourceTokens: { text: string }[] }) => c.sourceTokens.map((i) => i.text))
    .sort()
  expect(assigned).toEqual(f.tokens.map((i) => i.text).sort())
})

it('declines a terminal record without repeated source labels or a caption', () => {
  const f = fixture('sparse-terminal')
  const ambiguous = f.tokens.map((i, index) =>
    i.text === 'Not assessed' && index !== f.tokens.findLastIndex((t) => t.text === 'Not assessed')
      ? { ...i, text: 'Other category' }
      : i
  )
  expect(refineTable(f.table, ambiguous, f.captions, [], f.rules).repairs).not.toContain(
    'terminal-categorical-record-recovered'
  )
  expect(refineTable(f.table, f.tokens, [], [], f.rules).repairs).not.toContain(
    'terminal-categorical-record-recovered'
  )
})

it('uses native comparison headers to separate a displaced validation column from P', () => {
  const f = fixture('rotated-comparison')
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid[0]).toEqual([
    'Parameter',
    'All patients (Percent)',
    'Training Cohort (Percent)',
    'Validation Cohort (Percent)',
    'P'
  ])
  expect(t.grid[1]).toEqual([
    'Total number of cases (1975-2018)',
    '323 (100)',
    '226 (100)',
    '97 (100)',
    ''
  ])
  expect(t.grid.find((row: string[]) => row[0] === 'Surgery')).toEqual([
    'Surgery',
    '',
    '',
    '',
    '0.253'
  ])
  expect(t.repairs).toContain('source-comparison-columns-recovered')
  const ambiguous = f.tokens.map((i) => (i.text === 'P' ? { ...i, text: 'Unclear' } : i))
  expect(refineTable(f.table, ambiguous, f.captions, [], f.rules).repairs).not.toContain(
    'source-comparison-columns-recovered'
  )
})

it('does not detach a raised section footnote while recovering numeric rows', () => {
  const f = fixture('boundary-footnote')
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  const row = t.grid.find((row: string[]) => row[0].startsWith('Intrinsic molecular subtype'))
  expect(row?.[0]).toBe('Intrinsic molecular subtypec')
  expect(row?.slice(1).every((text: string) => !text)).toBe(true)
})

it('does not discard boundary section text when realigning the preceding numeric record', () => {
  const f = fixture('boundary-section')
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.unassigned).not.toContain('Stage of Cancer')
  expect(t.grid.flat().join(' ')).toContain('Stage of Cancer')
})

it('keeps a continuous section sentence containing a threshold and treatment plus sign', () => {
  const f = fixture('threshold-section')
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  const c = t.cells.find((c: { text: string }) => c.text.startsWith('Non-hematologic'))
  expect(c?.text).toBe('Non-hematologic AEs occurring in >10% of the ENT + EXE group')
  expect(c?.colSpan).toBe(5)
  expect(t.grid.find((r: string[]) => r[0] === 'Hypophosphatemia')).toEqual([
    'Hypophosphatemia',
    '5 (7.6)',
    '2 (3.0)',
    '48 (73.8)',
    '16 (24.6)'
  ])
})

it('does not merge an independent number or separated text into a section sentence', () => {
  const f = fixture('threshold-section')
  for (const tokens of [
    f.tokens.map((i) => (i.text === '10% of the ENT' ? { ...i, text: '10' } : i)),
    f.tokens.map((i) =>
      i.text === 'EXE group'
        ? { ...i, rect: [i.rect[0] + 20, i.rect[1], i.rect[2] + 20, i.rect[3]] }
        : i
    )
  ]) {
    const t = refineTable(f.table, tokens, f.captions, [], f.rules)
    expect(
      t.cells.find((c: { text: string }) => c.text.startsWith('Non-hematologic'))?.colSpan
    ).toBe(1)
  }
})

it('recovers an omitted enumerated section between repeated numeric record blocks', () => {
  const f = fixture('enumerated-section')
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  const heading = t.cells.find((c: { text: string }) => c.text === 'b. Per-protocol')
  expect(heading?.colSpan).toBe(4)
  expect(t.unassigned).not.toContain('b. Per-protocol')
  expect(t.grid[6]).toEqual(['pPROs', '6 (8.8%)', '37 (56.9%)', ''])
  expect(t.grid[8].slice(1)).toEqual(['5 (1)', '5 (1)', '0.796d'])
})

it('requires both the preceding section letter and repeated record text', () => {
  const f = fixture('enumerated-section')
  const recovered = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  for (const tokens of [
    f.tokens.map((i) => (i.text.startsWith('a. ') ? { ...i, text: i.text.slice(3) } : i)),
    f.tokens.map((i) =>
      i.text === 'Perception on PRO Importance and Attitude' && i.baseline < 300
        ? { ...i, text: 'A different questionnaire record' }
        : i
    )
  ]) {
    const t = refineTable(f.table, tokens, f.captions, [], f.rules)
    expect(t.unassigned).toContain('b. Per-protocol')
  }
  const withoutPriorLetter = refineTable(
    f.table,
    f.tokens.map((i) => (i.text.startsWith('a. ') ? { ...i, text: i.text.slice(3) } : i)),
    f.captions,
    [],
    f.rules
  )
  expect(recovered.grid.slice(1).filter((r: string[]) => r[0] !== 'b. Per-protocol')).toEqual(
    withoutPriorLetter.grid.slice(1)
  )
})

it('restores a terminal section and its P value inside the closing source rule', () => {
  const f = fixture('terminal-section-statistic')
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid.at(-1)).toEqual(['Overall staging (AJCC)', '', '', '', '0.107'])
  expect(t.unassigned).toEqual([])
  expect(t.grid.at(-2)).toEqual(['Unknown', '174 (53.9)', '127 (56.2)', '47 (48.5)', ''])
})

it('rejects model merges across independent values whose glyphs cross the row edge', () => {
  const f = fixture('terminal-section-statistic')
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid).toContainEqual(['Unknown', '168 (52.0)', '124 (54.9)', '44 (45.4)', ''])
  expect(t.grid).toContainEqual(['N-stage', '', '', '', '0.173'])
})

it('does not recover a terminal statistic without its border or P heading', () => {
  const f = fixture('terminal-section-statistic')
  const noBorder = refineTable(f.table, f.tokens, f.captions, [], [])
  const noP = refineTable(
    f.table,
    f.tokens.map((i) => (i.text === 'P' ? { ...i, text: 'Value' } : i)),
    f.captions,
    [],
    f.rules
  )
  for (const t of [noBorder, noP]) {
    expect(t.unassigned).toContain('Overall staging (AJCC)')
    expect(t.unassigned).toContain('0.107')
  }
})

it('assigns a displaced projected span to the continuous section title that owns its text', () => {
  const f = fixture('displaced-section-span')
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  const title = 'Weakness in arm/hand on non-affected side (protocol-specific item1)'
  const titleRow = t.grid.findIndex((row: string[]) => row[0] === title)
  expect(titleRow).toBeGreaterThan(0)
  expect(t.cells.find((c: { text: string }) => c.text === title)?.colSpan).toBe(9)
  expect(t.unassigned).toEqual([])
  expect(t.grid[titleRow + 1]).toEqual([
    'Not at all',
    '62 (86)',
    '97 (91)',
    '74 (83)',
    '80 (91)',
    '35 (85)',
    '58 (87)',
    '39 (83)',
    '52 (93)'
  ])
})

it('preserves section text when overlapping rows do not establish a unique owner', () => {
  const f = fixture('overlapping-section-span')
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid[36][0]).toBe(
    'Pins and needles in arm/hand on non-affected side (protocol-specific itema'
  )
  expect(t.grid[35].every((text: string) => text === '')).toBe(true)
})

it('requires projected-section evidence to recover a clipped section span', () => {
  const f = fixture('displaced-section-span')
  f.table.structure.objects = f.table.structure.objects.filter(
    (o) => o.label !== 'table projected row header'
  )
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.unassigned).toContain(
    'Weakness in arm/hand on non-affected side (protocol-specific item'
  )
})
