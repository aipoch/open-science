import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable, hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )
const refine = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  refineTable(f.table, f.tokens, f.captions, [], f.rules)

it('recovers a compact record that crosses adjacent model bands', () => {
  const token = (text: string, x: number, y: number): Record<string, unknown> => ({
    text,
    rect: [x, y, x + Math.max(8, text.length * 4), y + 10],
    baseline: y + 10,
    height: 10,
    horizontal: true
  })
  const table = {
    cropRect: [0, 0, 500, 130],
    structure: {
      objects: [
        ...[0, 100, 200, 300, 400].map((x, index, columns) => ({
          label: 'table column',
          rect: [x, 0, columns[index + 1] ?? 500, 130]
        })),
        ...[
          [0, 20, 500, 35],
          [0, 35, 500, 55],
          [0, 53, 500, 70],
          [0, 70, 500, 90]
        ].map((rect) => ({ label: 'table row', rect }))
      ]
    }
  }
  const result = refineTable(
    table,
    [
      token('Characteristic', 10, 22),
      token('Grade 1', 110, 22),
      token('Grade 2', 210, 22),
      token('Grade 3', 310, 22),
      token('Myalgia', 10, 37),
      token('16 (29.6)', 210, 37),
      token('3 (5.5)', 310, 37),
      token('Alopecia', 10, 49),
      token('12 (23.0)', 210, 49),
      token('4 (7.6)', 310, 49),
      token('1 (1.8)', 410, 49),
      token('Dyspnea', 10, 72),
      token('15 (27.7)', 210, 72),
      token('5 (9.2)', 310, 72),
      token('2 (3.7)', 410, 72)
    ],
    [{ page: 1, lines: ['Table 1. Toxicity'], rect: [0, -15, 160, -5] }],
    [],
    []
  )
  expect(result.grid).toContainEqual(['Alopecia', '', '12 (23.0)', '4 (7.6)', '1 (1.8)'])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('compact-source-record-recovered')
})

it('recovers a detached confidence-interval parent above adjacent leaf headers', () => {
  const token = (text: string, x: number, y: number): Record<string, unknown> => ({
    text,
    rect: [x, y, x + Math.max(8, text.length * 4), y + 10],
    baseline: y + 10,
    height: 10,
    horizontal: true
  })
  const result = refineTable(
    {
      cropRect: [0, 0, 400, 100],
      structure: {
        objects: [
          ...[0, 100, 200, 300].map((x) => ({
            label: 'table column',
            rect: [x, 0, x + 100, 100]
          })),
          { label: 'table row', rect: [0, 30, 400, 58] },
          { label: 'table row', rect: [0, 58, 400, 78] },
          { label: 'table column header', rect: [0, 0, 400, 58] }
        ]
      }
    },
    [
      token('Characteristic', 10, 36),
      token('Value', 110, 36),
      token('Lower', 210, 36),
      token('Upper', 310, 36),
      token('95% CI', 245, 15),
      token('Study', 10, 62),
      token('1.0', 110, 62),
      token('0.8', 210, 62),
      token('1.2', 310, 62)
    ],
    [{ page: 1, lines: ['Table 1. Confidence intervals'], rect: [0, -15, 180, -5] }],
    [],
    []
  )
  expect(result.grid[0][2]).toBe('95% CI')
  expect(result.grid[1].slice(2, 4)).toEqual(['Lower', 'Upper'])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('detached-parent-header-recovered')
})

it('recovers the terminal diagonal row of a triangular correlation matrix', () => {
  const token = (text: string, x: number, y: number): Record<string, unknown> => ({
    text,
    rect: [x, y, x + Math.max(8, text.length * 4), y + 10],
    baseline: y + 10,
    height: 10,
    horizontal: true
  })
  const columns = Array.from({ length: 8 }, (_, column) => ({
    label: 'table column',
    rect: [column * 50, 0, (column + 1) * 50, 140]
  }))
  const result = refineTable(
    {
      cropRect: [0, 0, 400, 140],
      structure: {
        objects: [
          ...columns,
          { label: 'table column header', rect: [0, 0, 400, 35] },
          ...[20, 35, 55, 75, 95].map((top) => ({
            label: 'table row',
            rect: [0, top, 400, top + 20]
          }))
        ]
      }
    },
    [
      token('Processing', 105, 22),
      token('PAOFI', 155, 22),
      token('SM', 205, 22),
      token('MEM', 255, 22),
      token('LC', 305, 22),
      token('HCIF', 355, 22),
      token('Processing Speed', 5, 40),
      token('1', 105, 40),
      token('0.04', 155, 40),
      token('0.09', 205, 40),
      token('0.01', 255, 40),
      token('0.05', 305, 40),
      token('−0.09', 355, 40),
      token('SM', 55, 60),
      token('1', 205, 60),
      token('0.41', 255, 60),
      token('0.43', 305, 60),
      token('0.53', 355, 60),
      token('MEM', 55, 80),
      token('1', 255, 80),
      token('0.76', 305, 80),
      token('0.69', 355, 80),
      token('LC', 55, 100),
      token('1', 305, 100),
      token('0.75', 355, 100),
      token('HCIF', 55, 120),
      token('1', 355, 120)
    ],
    [{ page: 1, lines: ['Table 1. Correlations'], rect: [0, -15, 160, -5] }],
    [],
    []
  )
  expect(result.grid.at(-1)).toEqual(['', 'HCIF', '', '', '', '', '', '1'])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('terminal-triangular-record-recovered')
})

it('preserves the final in-table regression summary and its superscript', () => {
  const t = refine(fixture('regression-summary'))
  expect(t.unassigned).toEqual([])
  expect(t.grid.at(-1)).toEqual(['', 'R2 = 0.47**', ''])
  expect(t.cells.find((c: { text: string }) => c.text === 'R2 = 0.47**').textRuns).toContainEqual({
    text: '2',
    position: 'superscript'
  })
})

it('recovers missing demographic sections and a complete category without filling blanks', () => {
  const t = refine(fixture('category-model-gaps'))
  expect(t.unassigned).toEqual([])
  expect(t.grid).toContainEqual(['Employment status, n (%)', ''])
  expect(t.grid).toContainEqual(['White', '53 (94.6%)'])
  expect(t.grid).toHaveLength(36)
})

it('recovers repeated treatment subrows when model bands miss the second arm', () => {
  const token = (text: string, x: number, y: number): Record<string, unknown> => ({
    text,
    rect: [x, y, x + Math.max(8, text.length * 4), y + 10],
    baseline: y + 10,
    height: 10,
    horizontal: true
  })
  const table = {
    cropRect: [0, 0, 400, 140],
    structure: {
      objects: [
        ...[
          [0, 0, 80, 140],
          [80, 0, 180, 140],
          [180, 0, 290, 140],
          [290, 0, 400, 140]
        ].map((rect) => ({ label: 'table column', rect })),
        ...[
          [0, 20, 400, 35],
          [0, 35, 400, 50],
          [0, 50, 400, 65],
          [0, 65, 400, 80],
          [0, 80, 400, 95],
          [0, 95, 400, 110]
        ].map((rect) => ({ label: 'table row', rect })),
        { label: 'table spanning cell', rect: [0, 35, 80, 65] }
      ]
    }
  }
  const tokens = [
    token('Treatment group', 10, 22),
    token('Mean', 210, 22),
    token('SD', 320, 22),
    token('After 8 h', 10, 36),
    token('Oxycodone', 100, 36),
    token('13.8', 210, 36),
    token('13.59', 320, 36),
    token('Tramadol', 100, 51),
    token('15.6', 210, 51),
    token('12.51', 320, 51),
    token('After 16 h', 10, 66),
    token('Oxycodone', 100, 66),
    token('8.5', 210, 66),
    token('8.34', 320, 66),
    token('Tramadol', 100, 81),
    token('8.1', 210, 81),
    token('6.81', 320, 81),
    token('After 24 h', 10, 96),
    token('Oxycodone', 100, 96),
    token('6.2', 210, 96),
    token('5.71', 320, 96),
    token('Tramadol', 100, 111),
    token('11.5', 210, 111),
    token('21.43', 320, 111)
  ]
  const result = refineTable(
    table,
    tokens,
    [{ page: 1, lines: ['Table 1. Treatment scores'], rect: [0, -20, 180, -10] }],
    [],
    []
  )
  expect(result.unassigned).toEqual([])
  expect(result.grid.filter((row: string[]) => row[1] === 'Tramadol')).toHaveLength(3)
  expect(result.grid).toContainEqual(['', 'Tramadol', '11.5', '21.43'])
})

it('joins a leading wrapped stub line with its numeric record', () => {
  const token = (text: string, x: number, y: number): Record<string, unknown> => ({
    text,
    rect: [x, y, x + Math.max(8, text.length * 4), y + 10],
    baseline: y + 10,
    height: 10,
    horizontal: true
  })
  const table = {
    cropRect: [0, 0, 300, 80],
    structure: {
      objects: [
        { label: 'table column', rect: [0, 0, 80, 80] },
        { label: 'table column', rect: [80, 0, 180, 80] },
        { label: 'table column', rect: [180, 0, 300, 80] },
        { label: 'table row', rect: [0, 10, 300, 25] },
        { label: 'table row', rect: [0, 40, 300, 55] }
      ]
    }
  }
  const result = refineTable(
    table,
    [
      token('Variable', 10, 12),
      token('Mean', 100, 12),
      token('SD', 220, 12),
      token('Duration', 10, 28),
      token('of surgery', 25, 39),
      token('76.3', 100, 39),
      token('30.3', 220, 39)
    ],
    [{ page: 1, lines: ['Table 1. Duration'], rect: [0, -20, 120, -10] }],
    [],
    []
  )
  expect(result.unassigned).toEqual([])
  expect(result.grid).toContainEqual(['Duration of surgery', '76.3', '30.3'])
})

it('realigns a split code row without absorbing the next record', () => {
  const token = (
    text: string,
    x: number,
    y: number,
    width = 40
  ): { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean } => ({
    text,
    rect: [x, y, x + width, y + 10],
    baseline: y + 10,
    height: 10,
    horizontal: true
  })
  const table = {
    cropRect: [0, 0, 400, 140],
    structure: {
      objects: [
        { label: 'table column', rect: [0, 0, 200, 140] },
        { label: 'table column', rect: [200, 0, 400, 140] },
        ...[0, 20, 40, 60, 90, 110].map((y, index) => ({
          label: 'table row',
          rect: [0, y, 400, index === 3 ? 80 : y + 20]
        }))
      ]
    }
  }
  const result = refineTable(
    table,
    [
      token('Type', 10, 5),
      token('Code', 220, 5),
      token('Alpha', 10, 25),
      token('1000', 220, 25, 30),
      token('Beta', 10, 45),
      token('2000', 220, 45, 30),
      token('Gamma', 10, 65),
      token('3000', 220, 65, 30),
      token('Delta', 10, 82),
      token('4000', 220, 82, 30),
      token('carcinoma', 22, 95),
      token('Epsilon', 10, 112),
      token('5000', 220, 112, 30)
    ],
    [{ page: 1, lines: ['Table 1. Codes'], rect: [0, -15, 200, -5] }],
    [],
    []
  )
  expect(result.grid).toContainEqual(['Delta carcinoma', '4000'])
  expect(result.grid).toContainEqual(['Epsilon', '5000'])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('text-supported-row-realigned')
})

it('recovers a numeric range row crossing model bands', () => {
  const token = (text: string, x: number, y: number): Record<string, unknown> => ({
    text,
    rect: [x, y, x + Math.max(8, text.length * 4), y + 10],
    baseline: y + 10,
    height: 10,
    horizontal: true
  })
  const table = {
    cropRect: [0, 0, 460, 155],
    structure: {
      objects: [
        ...[
          [0, 0, 80, 155],
          [80, 0, 160, 155],
          [160, 0, 240, 155],
          [240, 0, 320, 155],
          [320, 0, 400, 155],
          [400, 0, 460, 155]
        ].map((rect) => ({ label: 'table column', rect })),
        ...[
          [0, 0, 460, 20],
          [0, 20, 460, 35],
          [0, 35, 460, 55],
          [0, 50, 460, 70],
          [0, 65, 460, 85],
          [0, 80, 460, 110],
          [0, 110, 460, 125],
          [0, 125, 460, 140],
          [0, 140, 460, 155]
        ].map((rect) => ({ label: 'table row', rect })),
        { label: 'table spanning cell', rect: [400, 35, 460, 85] }
      ]
    }
  }
  const tokens = [
    token('Agreed', 100, 5),
    token('Declined', 260, 5),
    token('p-value', 410, 5),
    token('Age group', 10, 23),
    token('40–49', 10, 40),
    token('107', 100, 40),
    token('40.2', 180, 40),
    token('40', 260, 40),
    token('37.4', 340, 40),
    token('0.859', 410, 40),
    token('50–59', 10, 49),
    token('72', 100, 49),
    token('27.1', 180, 49),
    token('27', 260, 49),
    token('25.2', 340, 49),
    token('60–69', 10, 67),
    token('81', 100, 67),
    token('30.5', 180, 67),
    token('37', 260, 67),
    token('34.6', 340, 67),
    token('70–74', 10, 82),
    token('6', 100, 82),
    token('2.3', 180, 82),
    token('3', 260, 82),
    token('2.8', 340, 82),
    token('Ethnic group', 10, 100),
    token('Malay', 10, 112),
    token('176', 100, 112),
    token('66.2', 180, 112),
    token('87', 260, 112),
    token('81.3', 340, 112),
    token('0.012', 410, 112),
    token('Chinese', 10, 127),
    token('85', 100, 127),
    token('32.0', 180, 127),
    token('18', 260, 127),
    token('16.8', 340, 127),
    token('Other', 10, 142),
    token('5', 100, 142),
    token('1.9', 180, 142),
    token('2', 260, 142),
    token('1.9', 340, 142)
  ]
  const result = refineTable(
    table,
    tokens,
    [{ page: 1, lines: ['Table 7. Profile'], rect: [0, -20, 120, -10] }],
    [],
    []
  )
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.grid).toContainEqual(['50–59', '72', '27.1', '27', '25.2', ''])
  expect(result.repairs).toContain('complete-source-record-recovered')
  expect(result.repairs).toContain('standalone-section-row-recovered')
  // An unrelated value-column conflict must stay visible after repairing age
  // records and the section boundary elsewhere in the same table.
  table.structure.objects.push({ label: 'table spanning cell', rect: [80, 110, 160, 140] })
  const conflicted = refineTable(
    table,
    tokens,
    [{ page: 1, lines: ['Table 7. Profile'], rect: [0, -20, 120, -10] }],
    [],
    []
  )
  expect(conflicted.issues).toContain('span-conflicts-with-source-rows')
})

it('preserves the final qualitative record and both preceding wrapped clinical labels', () => {
  const t = refine(fixture('trailing-urine-row'))
  expect(t.unassigned).toEqual([])
  expect(t.grid.at(-1)).toEqual(['Urine analysis', 'Normal', 'Normal'])
  expect(t.grid).toContainEqual(['Leukopenia/ thrombocytopenia', '0', '0'])
  expect(t.grid).toContainEqual(['Potassium (mmol/L), mean ± SD', '4.2 ± 0.25', '4.1 ± 0.5'])
  expect(t.grid).toHaveLength(19)
})

it.each(['cropped-prose', 'cropped-disclosure', 'cropped-doi'])(
  'rejects non-table source content in %s',
  (name) => {
    const f = fixture(name),
      t = refine(f)
    expect(hasTableEvidence(t, undefined, f.tokens)).toBe(false)
    expect(hasTableEvidence(t, { lines: ['Table 1. Narrative comparison'] }, f.tokens)).toBe(true)
  }
)

it.each(['shifted-risk-columns', 'category-count-overlap'])(
  'uses closed native faces and preserves source tokens in %s',
  (name) => {
    const f = fixture(name),
      original = structuredClone(f),
      t = refine(f)
    expect(t.unassigned).toEqual([])
    expect(t.issues).toEqual([])
    expect(t.grid.every((row: string[]) => row.length === 4)).toBe(true)
    const tokens = t.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
    const signature = (i: { text: string; rect: number[] }): string =>
      JSON.stringify([i.text, i.rect])
    expect(new Set(tokens.map(signature)).size).toBe(tokens.length)
    expect(f).toEqual(original)
    if (name === 'shifted-risk-columns') {
      expect(t.grid[8].slice(1)).toEqual(['55 (89%) 7 (11%)', '108 (92%) 9 (8%)', '0.58'])
      expect(t.grid[11].slice(1)).toEqual(['57 (92%) 5 (8%)', '106 (92%) 9 (8%)', '1.00'])
      // The source itself omits the opening parenthesis; do not silently repair its value.
      expect(t.grid[10][1]).toBe('34 56%) 27 (44%)')
    } else {
      expect(t.grid[5].at(-1)).toBe('0.72')
      expect(t.cells.find((c: { text: string }) => c.text === 'Masood Score')).toMatchObject({
        colSpan: 4
      })
      expect(t.cells.find((c: { text: string }) => c.text === 'Frequencies')).toMatchObject({
        colSpan: 2
      })
      expect(t.cells.find((c: { text: string }) => c.text === '0.92')).toMatchObject({ rowSpan: 3 })
    }
  }
)

it('declines open native faces and text-bearing strips between parallel rules', async () => {
  const { recoverRuledHeaderGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-stub-grid.mjs')).href
  )
  const f = fixture('category-count-overlap')
  expect(
    recoverRuledHeaderGrid(
      f.table,
      f.tokens,
      f.captions,
      f.rules.filter((r: number[]) => r[0] < 760)
    )
  ).toBeUndefined()
  f.tokens.push({
    text: 'I',
    rect: [350.5, 300, 351.5, 310],
    baseline: 310,
    height: 10,
    horizontal: true
  })
  expect(recoverRuledHeaderGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})

it('does not turn a separated footnote or a different statistic into an in-table R-squared row', () => {
  const f = fixture('regression-summary')
  f.rules.push([183, 236, 632, 236])
  expect(refine(f).unassigned).toContain('R')
  const g = fixture('regression-summary')
  g.tokens.find((i: { text: string }) => i.text === 'R').text = 'T'
  expect(refine(g).unassigned).toContain('T')
})

it('declines incomplete clinical pairs and preserves numeric or captioned tables in prose guards', () => {
  const f = fixture('trailing-urine-row')
  f.tokens = f.tokens.filter(
    (i: { text: string; rect: number[] }) => i.text !== 'Normal' || i.rect[0] < 700
  )
  expect(refine(f).unassigned).toContain('Normal')
  const g = fixture('cropped-prose'),
    t = refine(g)
  t.grid[0][1] = '12 (34%)'
  expect(hasTableEvidence(t, undefined, g.tokens)).toBe(true)
})

it('requires repeated section and count evidence before adding demographic rows', async () => {
  const { recoverCountedCategoryGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
  )
  const f = fixture('category-model-gaps')
  expect(recoverCountedCategoryGrid(f.table, f.tokens, f.captions, [])).toBeUndefined()
  f.tokens.find((i: { text: string }) => i.text === '53 (94.6%)').text = 'Unknown'
  expect(recoverCountedCategoryGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})

it.each([
  'regression-summary',
  'category-model-gaps',
  'trailing-urine-row',
  'shifted-risk-columns',
  'category-count-overlap',
  'clipped-treatment-header'
])('accounts for every enclosed source token once in %s', (name) => {
  const f = fixture(name),
    original = structuredClone(f),
    t = refine(f)
  const rects = t.cells.map((c: { rect: number[] }) => c.rect)
  const left = Math.min(...rects.map((r: number[]) => r[0]))
  const top = Math.min(...rects.map((r: number[]) => r[1]))
  const right = Math.max(...rects.map((r: number[]) => r[2]))
  const bottom = Math.max(...rects.map((r: number[]) => r[3]))
  const source = f.tokens.filter(
    (i: { rect: number[] }) =>
      i.rect[0] >= left &&
      i.rect[2] <= right &&
      (i.rect[1] + i.rect[3]) / 2 >= top &&
      (i.rect[1] + i.rect[3]) / 2 <= bottom
  )
  const signature = (i: { text: string; rect: number[] }): string =>
    JSON.stringify([i.text, i.rect])
  expect(
    t.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(signature)
      .sort()
  ).toEqual(source.map(signature).sort())
  expect(f).toEqual(original)
})

it('recovers a bracket-wrapped source row while preserving malformed source values', () => {
  const f = fixture('clipped-treatment-header'),
    original = structuredClone(f),
    t = refine(f)
  // The PDF itself renders count/percentage concatenations and displaced
  // closing brackets. Source distance alone cannot establish the scientific pairs.
  expect(t.unassigned).toEqual([])
  expect(t.grid).toContainEqual(['ET treatment', '[14 (45.2) ]', '[51 (65.4) ]', ''])
  expect(t.issues).toContain('text-crosses-crop-boundary')
  expect(t.grid.flat()).toContain('(41.9)18')
  expect(f).toEqual(original)
})

it.each(['missing-bracket', 'separating-rule', 'incomplete-values', 'missing-peers'])(
  'does not recover bracket-wrapped source records with %s',
  (mode) => {
    const f = fixture('clipped-treatment-header')
    if (mode === 'missing-bracket')
      f.tokens = f.tokens.filter(
        (i: { text: string; rect: number[] }) =>
          !(i.text === ']' && i.rect[1] > 750 && i.rect[1] < 765 && i.rect[0] < 300)
      )
    if (mode === 'separating-rule') f.rules.push([55, 750, 433, 750])
    if (mode === 'incomplete-values')
      f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '[51 (65.4)')
    if (mode === 'missing-peers')
      for (const i of f.tokens)
        if (i.text === 'ET treatment' && i.rect[1] > 800) i.text = 'Other treatment'
    expect(refine(f).unassigned).toContain('ET treatment')
  }
)
