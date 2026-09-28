import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
const refine = (x: ReturnType<typeof load>): ReturnType<typeof JSON.parse> =>
  refineTable(x.table, x.tokens, x.captions, x.notes ?? [], x.rules)

it('keeps sample qualifiers with their repeated visit headings', () => {
  const t = refine(load('wrapped-visit-headers-with-sample-qualifiers'))
  expect(t.issues).toEqual([])
  expect(t.cells).toContainEqual(
    expect.objectContaining({ column: 1, rowSpan: 3, text: 'All Baseline (n = 245)' })
  )
  expect(t.grid[3].slice(0, 2)).toEqual(['% Insulin resistant', '51.4'])
})

it('uses repeated before/after records to bound overlapping stub predictions', () => {
  const t = refine(load('overlapping-stubs-in-repeated-visit-pairs'))
  expect(t.issues).toEqual([])
  expect(t.cells).toContainEqual(
    expect.objectContaining({ row: 7, column: 0, rowSpan: 2, text: 'Trophism reduction' })
  )
  expect(t.cells).toContainEqual(
    expect.objectContaining({ row: 9, column: 0, rowSpan: 2, text: 'Thinning of vulvar rugae' })
  )
})

it('separates a model rowspan at the native header boundary', () => {
  const t = refine(load('first-biomarker-span-crossing-header-rule'))
  expect(t.issues).toEqual([])
  expect(t.cells).toContainEqual(
    expect.objectContaining({ row: 1, column: 0, rowSpan: 4, text: 'CRP' })
  )
  expect(t.grid[0][0]).toBe('Inflammation Endpoint')
})

it('joins a wrapped shared stub only across a validated count subtotal', () => {
  const t = refine(load('omitted-method-headers-above-blank-stubs'))
  expect(t.cells).toContainEqual(
    expect.objectContaining({ row: 1, column: 0, rowSpan: 3, text: 'Training set' })
  )
  expect(t.grid[2].slice(0, 3)).toEqual(['', 'Invisible', '76'])
})

it('restores omitted method headers above two blank stub columns without consuming data', () => {
  const x = load('omitted-method-headers-above-blank-stubs')
  const original = structuredClone(x)
  const t = refine(x)
  expect(t.grid[0]).toEqual([
    '',
    '',
    'Number of images',
    'Rule-based method',
    'Rule-based method with texture analysis'
  ])
  expect(t.grid[1].slice(0, 3)).toEqual(['Training set', 'Visible', '301'])
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
  expect(x).toEqual(original)
  x.rules = []
  expect(refine(x).unassigned).toContain('Number of')
})

it('retains wrapped arm headings in a ruled header when the caption is beside the table', () => {
  const x = load('wrapped-arm-headers-without-top-caption')
  const t = refine(x)
  expect(t.grid[0]).toEqual([
    '',
    'Group 1 (control group)',
    'Group 2 (treatment group)',
    'P value between the two studied groups'
  ])
  expect(t.grid[2]).toEqual(['At baseline', '205.83±46.13', '205.62±52.12', '0.998'])
  expect(t.unassigned).toEqual([])
  x.rules = []
  expect(refine(x).unassigned).toContain('Group 1')
})

it('expands the crop for a natively ruled spanning title above nested headers', () => {
  const x = load('clipped-spanning-title-above-correlation-headers')
  const t = refine(x)
  expect(t.grid[0][0]).toBe('Pearson correlation (r) after 6 months of treatment')
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 0).colSpan
  ).toBe(6)
  expect(t.grid[2]).toEqual(['', '', 'r', 'P value', 'r', 'P value'])
  expect(t.cropRect[1]).toBeLessThan(x.table.cropRect[1])
  expect(t.clipped).toEqual([])
  expect(t.unassigned).toEqual([])
  x.rules = []
  expect(refine(x).unassigned).toContain('Pearson correlation (r) after 6 months of treatment')
})

it('preserves the complete final narrative cell up to its native closing rule', () => {
  const x = load('last-narrative-cell-below-model-row')
  const t = refine(x)
  expect(t.grid.at(-1)).toEqual([
    '7 to 10',
    'Severe pain',
    'Intense pain and intolerable, indicated for analgesic drugs, with severe disturbance of sleep, possible autonomic dysregulation or passive position'
  ])
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
})

it.each(['no-rule', 'new-record', 'different-font', 'large-gap'])(
  'does not extend a final narrative cell with %s evidence',
  (variant) => {
    const x = load('last-narrative-cell-below-model-row')
    const tail = x.tokens.find((i: { text: string }) => i.text.startsWith('autonomic'))
    if (variant === 'no-rule') x.rules = []
    if (variant === 'new-record') tail.text = 'Independent observation'
    if (variant === 'different-font') tail.height *= 1.5
    if (variant === 'large-gap') {
      tail.baseline += 15
      tail.rect[1] += 15
      tail.rect[3] += 15
    }
    expect(refine(x).grid.at(-1)[2]).not.toContain(tail.text)
  }
)

it('preserves a raised header note marker beside its proved native owner', () => {
  const x = load('raised-note-marker-beside-native-header')
  const t = refine(x)
  expect(t.grid[0][0]).toBe('Messages†')
  expect(t.unassigned).toEqual([])
})

it('does not infer subtotal stub scope from inconsistent counts', () => {
  const x = load('omitted-method-headers-above-blank-stubs')
  for (const token of x.tokens) if (token.text === '377') token.text = '378'
  expect(refine(x).cells).not.toContainEqual(
    expect.objectContaining({ row: 1, column: 0, rowSpan: 3, text: 'Training set' })
  )
})

it('requires a native boundary before shortening a model stub across the header', () => {
  const x = load('first-biomarker-span-crossing-header-rule')
  x.rules = []
  expect(refine(x).repairs).not.toContain('source-record-boundary-restored')
})

it('retains complete multiline cohort headings above their sample qualifiers', () => {
  const t = refine(load('multiline-cohort-headers-with-sample-qualifiers'))
  expect(t.issues).toEqual([])
  expect(t.grid[0][2]).toBe('Lower Fat Diet 12 Months (n = 33)')
})

it.each(['independent-label', 'detached-marker', 'independent-header'])(
  'does not merge or attach source text with %s evidence',
  (variant) => {
    if (variant === 'independent-label') {
      const x = load('first-biomarker-span-crossing-header-rule')
      const token = x.tokens.find((i: { text: string }) => i.text === 'CRP')
      const extra = structuredClone(token)
      extra.text = 'Independent endpoint'
      extra.baseline += 40
      extra.rect[1] += 40
      extra.rect[3] += 40
      x.tokens.push(extra)
      expect(refine(x).repairs).not.toContain('source-record-boundary-restored')
    } else if (variant === 'detached-marker') {
      const x = load('raised-note-marker-beside-native-header')
      const marker = x.tokens.find(
        (i: { text: string; rect: number[] }) => i.text === '†' && i.rect[1] < 900
      )
      marker.rect[0] += 20
      marker.rect[2] += 20
      expect(refine(x).grid[0][0]).not.toBe('Messages†')
    } else {
      const x = load('wrapped-visit-headers-with-sample-qualifiers')
      for (const token of x.tokens)
        if (/^\(n\s*=/.test(token.text)) token.text = 'Independent heading'
      expect(refine(x).cells).not.toContainEqual(
        expect.objectContaining({ column: 1, rowSpan: 2, text: 'Baseline Independent heading' })
      )
    }
  }
)

it.each([
  ['wrapped-visit-headers-with-sample-qualifiers', 'All Baseline (n = 245)', 1],
  ['multiline-cohort-headers-with-sample-qualifiers', 'Walnut-Rich Diet 12 Months (n = 35)', 4]
])('recovers the entire native cohort header in %s', (name, text, column) => {
  const t = refine(load(name as string))
  expect(t.cells).toContainEqual(expect.objectContaining({ row: 0, column, rowSpan: 3, text }))
})
it('extends the final top-aligned stub to its native section bottom', () => {
  const t = refine(load('first-biomarker-span-crossing-header-rule'))
  expect(t.cells).toContainEqual(expect.objectContaining({ text: 'VCAM-1', rowSpan: 4 }))
})

it.each([
  'ruled-baseline-groups-with-shared-probabilities',
  'ruled-risk-groups-with-centered-probabilities',
  'ruled-longitudinal-statistics-with-section-rows',
  'ruled-biomarker-followups-with-wrapped-intervals'
])('recovers native record faces independently of overlapping predictions: %s', (name) => {
  const t = refine(load(name))
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
  if (name.includes('longitudinal'))
    expect(t.grid).toContainEqual([
      'GWW (median; Q1–Q3; range)',
      '84 (68.5–108; 27–438)',
      '81 (48–125; 35–438)',
      '86 (70–106; 27–226)',
      '1.000'
    ])
  if (name.includes('risk-groups'))
    expect(t.cells).toContainEqual(
      expect.objectContaining({ text: '0.519', column: 3, rowSpan: 4 })
    )
})

it.each(['clipped-range-in-two-column-summary', 'long-questionnaire-label-between-category-rows'])(
  'restores source-owned two-column records in %s',
  (name) => {
    const t = refine(load(name))
    expect(t.issues).toEqual([])
    expect(t.unassigned).toEqual([])
    expect(t.clipped).toEqual([])
    if (name.startsWith('clipped'))
      expect(t.grid).toContainEqual(['BMI, mean (range), (kg/m2)', '33.5 (27-40)'])
    else
      expect(t.grid).toContainEqual([
        'Self-reported mammogram within the last 2 years',
        '634 (74.6)'
      ])
  }
)

it.each([
  'unmarked-statistical-preface-before-significance-notes',
  'unmarked-note-font-box-touching-closing-rule'
])('retains complete source note blocks in %s', async (name) => {
  const { associateTableNotes } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
  )
  const x = load(name),
    first = refine(x)
  const rect = [
    first.cropRect[0],
    Math.min(...first.rows.map((r: { rect: number[] }) => r.rect[1])),
    first.cropRect[2],
    Math.max(...first.rows.map((r: { rect: number[] }) => r.rect[3]))
  ].map((v) => v / 1.5)
  x.notes = associateTableNotes(
    x.page,
    [{ rect }],
    x.rules.map((r: number[]) => r.map((v) => v / 1.5))
  )[0].map((n: { rect: number[] }) => ({ ...n, rect: n.rect.map((v) => v * 1.5) }))
  const text = x.notes.map((n: { text: string }) => n.text).join(' ')
  expect(text).toContain(
    name.includes('statistical')
      ? 'Both slopes show significant linear, quadratic, and cubic shapes.'
      : 'The state of analgesia as a percentage'
  )
  expect(refine(x).issues).toEqual([])
})

it.each([
  'section-labels-between-before-after-records',
  'repeated-visits-with-sparse-section-statistics',
  'digit-prefixed-section-before-visit-records'
])('keeps repeated visit records and section headings separate in %s', (name) => {
  const t = refine(load(name))
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
  expect(t.grid.flat()).not.toContain('t1 t2')
  if (name.startsWith('section')) {
    expect(t.grid.flat()).toContain('Stroma')
    expect(t.grid.flat()).toContain('Epithelium')
    expect(t.grid.flat()).not.toContain('Reduced, n (%) Stroma')
  } else if (name.startsWith('repeated')) {
    expect(t.grid.flat()).toContain('Emotional Functioning')
    expect(t.grid.flat()).toContain('Functional Domains')
    expect(t.cells).toContainEqual(
      expect.objectContaining({
        text: 'Between-Group Difference in Mean Change from Baseline',
        colSpan: 3
      })
    )
  } else expect(t.grid.flat()).toContain('30-s Chair sit-to-stand test (repetitions)')
})

it.each([
  'wrapped-parent-heading-above-visit-columns',
  'third-level-parent-above-paired-column-headings'
])('restores the complete native parent hierarchy in %s', (name) => {
  const t = refine(load(name))
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
  if (name.startsWith('wrapped'))
    expect(t.cells).toContainEqual(
      expect.objectContaining({ text: 'Between-Group differenced', colSpan: 3 })
    )
  else {
    expect(t.cells).toContainEqual(
      expect.objectContaining({ text: 'Service', row: 0, column: 2, colSpan: 6 })
    )
    expect(t.cells).toContainEqual(
      expect.objectContaining({ text: 'Operator Error', row: 1, column: 2, colSpan: 2 })
    )
    expect(t.grid[2].slice(2, 8)).toEqual(['PQCC', 'Tech', 'PQCC', 'Tech', 'PQCC', 'Tech'])
  }
})

it('retains sparse reference rows under repeated regression effect headings', () => {
  const t = refine(load('binary-baselines-under-grouped-effect-headings'))
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
  expect(t.grid).toContainEqual(['Control group', '0', '', '1', '0', '', '1'])
  expect(t.grid).toContainEqual(['Time:Cycle 1', '0', '', '1', '0', '', '1'])
  expect(t.cells).toContainEqual(
    expect.objectContaining({ text: 'Unadjusted intervention effect', colSpan: 3 })
  )
})

it('separates the first trend record from the native column headings', () => {
  const t = refine(load('unmarked-statistical-preface-before-significance-notes'))
  expect(t.grid).toHaveLength(5)
  expect(t.grid[2]).toEqual(['Linear', '−3.85a', '−4.26 to −3.43', '−5.52a,b', '−5.93 to −5.10'])
})
it('recovers every numbered correlation column without completing the unprinted triangle', () => {
  const t = refine(load('numbered-triangle-with-merged-final-columns'))
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
  expect(t.grid[0]).toEqual(['Variable', 'Mean', 'SD', '1', '2', '3', '4', '5', '6', '7', '8', '9'])
  expect(t.grid.at(-1).slice(-2)).toEqual(['0.10***', '0.10**'])
  expect(t.grid[1].slice(3)).toEqual(Array(9).fill(''))
})

it('attaches a raised full-em letter only to its adjacent statistic', async () => {
  const x = load('full-em-raised-marker-beside-statistic'),
    t = refine(x)
  expect(t.unassigned).toEqual([])
  const cell = t.cells.find((c: { sourceTokens: { text: string }[] }) =>
    c.sourceTokens.some((i) => i.text === 'd')
  )
  expect(cell?.text).toBe('Friends with cancer, median (IQR)d')
  const { isAdjacentTableScript } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-geometry.mjs')).href
  )
  const marker = x.tokens.find((i: { text: string }) => i.text === 'd'),
    anchor = x.tokens.find((i: object) => isAdjacentTableScript(marker, i))
  expect(anchor).toBeDefined()
  expect(isAdjacentTableScript({ ...marker, baseline: anchor.baseline }, anchor)).toBe(false)
  expect(
    isAdjacentTableScript(
      { ...marker, rect: marker.rect.map((v: number, n: number) => v + (n % 2 ? 0 : 15)) },
      anchor
    )
  ).toBe(false)
})
it.each(['no-bottom-rule', 'conflicting-statistic'])(
  'retains uncertainty when native record faces have %s',
  async (variant) => {
    const x = load('ruled-risk-groups-with-centered-probabilities')
    if (variant === 'no-bottom-rule') {
      const y = Math.max(
        ...x.rules
          .filter((r: number[]) => r[1] === r[3] && r[1] < x.table.cropRect[3] + 16)
          .map((r: number[]) => r[1])
      )
      x.rules = x.rules.filter((r: number[]) => r[1] !== y)
    }
    const { recoverRuledRecordFaces } = await import(
      pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-record-faces.mjs')).href
    )
    if (variant === 'conflicting-statistic') {
      const row = x.tokens.find((i: { text: string }) => i.text === '0.519')
      row.text = 'unresolved statistic'
    }
    expect(recoverRuledRecordFaces(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
  }
)
it('rejects reordered native visits instead of filling missing measurements', async () => {
  const x = load('digit-prefixed-section-before-visit-records')
  x.tokens.find((i: { text: string }) => i.text === 't1').text = 't3'
  const { recoverRepeatedVisitGrid } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-repeated-visit-grid.mjs')).href
  )
  expect(recoverRepeatedVisitGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})
it('requires consecutive printed matrix headers before adding a missing column', async () => {
  const x = load('numbered-triangle-with-merged-final-columns')
  x.tokens.find((i: { text: string }) => i.text === '9').text = '11'
  const { recoverNumberedMatrix } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-numbered-matrix.mjs')).href
  )
  expect(recoverNumberedMatrix(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})

it('joins fragmented parent underlines without merging a statistic heading into its child', () => {
  const t = refine(load('fragmented-underline-above-three-statistic-columns'))
  expect(t.issues).toEqual([])
  expect(t.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 5, colSpan: 3, rowSpan: 1, text: 'P-value' })
  )
  expect(t.grid[1].slice(5)).toEqual(['Time', 'Group', 'Group × Time'])
  expect(t.grid[2].slice(5)).toEqual(['<.001', '.009', '.003'])
})
