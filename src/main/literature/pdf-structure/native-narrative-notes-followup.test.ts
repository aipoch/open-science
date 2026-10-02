import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const {
  splitRuledComparisonSections,
  groupRuledComparisonSections,
  recoverSharedScoreTimepointGrid,
  recoverStudyParagraphGrid,
  recoverParallelCountLists
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-narrative-grid.mjs')).href
)
const {
  associateTableNotes,
  associateContinuedTableNotes,
  recoverRuledDoseNoteCrop,
  recoverRuledDefinitionNoteCrop
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const { groupTableParts } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-group.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('src/main/literature/pdf-structure/fixtures', name + '.jsonl'))

it('keeps a cited single equation as the terminal line of an accepted multi-key glossary', () => {
  const f = fixture('cited-single-equation-tail-after-multiple-glossary-definitions')
  const before = structuredClone(f)
  expect(associateTableNotes(f.page, f.tables, f.rules)[0]).toEqual([
    {
      text: 'LBCWS = low breast cancer-worry scale; SD = standard deviation; HBCWS = high breast cancer-worry scale.',
      rect: [321.4583, 694.1973, 528.0791, 713.1973]
    }
  ])
  expect(f).toEqual(before)
})

it.each([
  'different-font',
  'different-indent',
  'large-gap',
  'complete-prefix',
  'prose-prefix',
  'intervening-prose',
  'standalone-equation',
  'uncited-tail',
  'labeled-new-note'
])('does not extend an equation glossary across %s', (variant) => {
  const f = fixture('cited-single-equation-tail-after-multiple-glossary-definitions')
  const start = f.page.lines.at(-2),
    tail = f.page.lines.at(-1)
  if (variant === 'different-font') tail.fontSize += 2
  if (variant === 'different-indent') tail.x += 30
  if (variant === 'large-gap') tail.y += 20
  if (variant === 'complete-prefix') start.text = start.text.replace(/;$/, '.')
  if (variant === 'prose-prefix')
    start.text = 'LBCWS was evaluated in a model; SD described variability;'
  if (variant === 'intervening-prose')
    f.page.lines.push({ ...start, y: 703, text: 'Discussion starts here.', width: 100 })
  if (variant === 'standalone-equation') f.page.lines.splice(-2, 1)
  if (variant === 'uncited-tail')
    f.page.lines = f.page.lines.filter((l: { text: string }) => l.text !== 'HBCWS')
  if (variant === 'labeled-new-note') tail.text = 'Legend: ' + tail.text
  expect(
    associateTableNotes(f.page, f.tables, f.rules)[0].some((n: { text: string }) =>
      n.text.includes('high breast cancer-worry scale')
    )
  ).toBe(false)
})

const remainingNotes = [
  ['bold-statistics-note-with-raised-comparison-marker', 'Boldness indicate', 1],
  ['bold-statistics-note-with-group-definitions', 'Boldness indicate', 1],
  ['median-format-before-significance-and-symbol-definitions', 'Values are median', 6],
  ['single-cited-equation-below-guideline-table', 'ALND =', 1],
  ['labeled-single-cited-equation-below-guideline-table', 'Legend: ALND =', 1]
] as const

it.each(remainingNotes)('owns the complete native closing note: %s', (name, prefix, count) => {
  const f = fixture(name),
    before = structuredClone(f)
  const notes = associateTableNotes(f.page, f.tables, f.rules)[0]
  expect(notes).toHaveLength(count)
  expect(notes[0].text.startsWith(prefix)).toBe(true)
  if (name.includes('bold-statistics'))
    expect(notes[0].text.endsWith('relaxation control group.')).toBe(true)
  if (name.includes('raised-comparison'))
    expect(notes[0].text).toContain('† difference at baseline (P = 0.038);')
  if (name.includes('median-format'))
    expect(notes[0].text).toContain(
      'For other outcomes, a two-sided p<0.05 was regarded as statistically significant.'
    )
  expect(f).toEqual(before)
})

it.each(
  remainingNotes.flatMap(([name, prefix]) =>
    ['missing-rule', 'distant-note', 'body-definition', 'intervening-prose'].map((v) => [
      name,
      prefix,
      v
    ])
  )
)('declines an external format/equation note %s with %s / %s', (name, prefix, variant) => {
  const f = fixture(name)
  const note = f.page.lines.find((l: { text: string }) => l.text.startsWith(prefix))
  if (variant === 'missing-rule') f.rules = []
  if (variant === 'distant-note')
    for (const l of f.page.lines.filter((l: { y: number }) => l.y >= note.y)) l.y += 40
  if (variant === 'body-definition') f.tables[0].rect[3] = note.y + note.height
  if (variant === 'intervening-prose')
    f.page.lines.push({
      text: 'The following results were observed.',
      x: note.x,
      y: f.tables[0].rect[3] + 0.1,
      width: 120,
      height: 1,
      fontSize: 7
    })
  expect(
    associateTableNotes(f.page, f.tables, f.rules)[0].some((n: { text: string }) =>
      n.text.startsWith(prefix)
    )
  ).toBe(false)
})

it.each([
  'single-cited-equation-below-guideline-table',
  'labeled-single-cited-equation-below-guideline-table',
  'bold-statistics-note-with-group-definitions'
])('requires cited keys inside the source table for %s', (name) => {
  const f = fixture(name)
  f.page.lines = f.page.lines.filter(
    (l: { y: number; height: number }) => l.y + l.height > f.tables[0].rect[3]
  )
  expect(associateTableNotes(f.page, f.tables, f.rules)[0]).toEqual([])
})

it.each([
  'single-cited-equation-below-guideline-table',
  'labeled-single-cited-equation-below-guideline-table'
])('rebases only the proved external equation crop: %s', (name) => {
  const f = fixture(name),
    before = structuredClone(f)
  const notes = associateTableNotes(f.page, f.tables, f.rules)[0].map((n: { rect: number[] }) => ({
    ...n,
    rect: n.rect.map((v) => v * 1.5)
  }))
  const crop = recoverRuledDefinitionNoteCrop(
    f.tables[0],
    notes,
    f.rules.map((r: number[]) => r.map((v) => v * 1.5))
  )
  expect(crop[3]).toBe(f.rules.at(-1)[1] * 1.5)
  expect(crop[3]).toBeLessThan(notes[0].rect[1])
  expect(f).toEqual(before)
})

it.each([
  'missing-rule',
  'uncited-equation',
  'unassigned-body',
  'clipped-body',
  'overlapping-body',
  'shifted-rule'
])('declines equation crop recovery with %s', (variant) => {
  const f = fixture('single-cited-equation-below-guideline-table')
  const notes = associateTableNotes(f.page, f.tables, f.rules)[0].map((n: { rect: number[] }) => ({
    ...n,
    rect: n.rect.map((v) => v * 1.5)
  }))
  if (variant === 'missing-rule') f.rules = []
  if (variant === 'uncited-equation')
    for (const c of f.tables[0].cells) c.text = c.text.replaceAll('ALND', 'OTHER')
  if (variant === 'unassigned-body') f.tables[0].unassigned.push('Unowned body')
  if (variant === 'clipped-body')
    f.tables[0].clipped.push({ text: 'Clipped body', rect: [64, 400, 84, 410] })
  if (variant === 'overlapping-body')
    f.tables[0].cells.at(-1).sourceRects.at(-1)[3] = notes[0].rect[1] + 1
  if (variant === 'shifted-rule')
    for (const r of f.rules) {
      r[0] += 20
      r[2] += 20
    }
  expect(
    recoverRuledDefinitionNoteCrop(
      f.tables[0],
      notes,
      f.rules.map((r: number[]) => r.map((v) => v * 1.5))
    )
  ).toBeUndefined()
})

it('completes an unfinished labeled glossary at its native closing with cited terminal keys', () => {
  const f = fixture('unfinished-labeled-glossary-before-cited-terminal-key')
  const before = structuredClone(f)
  const notes = associateTableNotes(f.page, f.tables, f.rules)
  expect(notes[0]).toHaveLength(1)
  expect(notes[0][0].text).toBe(
    'Abbreviations: 3D-CRT, 3-dimensional conformal radiotherapy; IMRT, intensity-modulated radiotherapy; CI, confidence interval.'
  )
  expect(notes[0][0].rect[3]).toBe(f.page.lines.at(-1).y + f.page.lines.at(-1).height)
  expect(f).toEqual(before)
})

it.each([
  'missing-rule',
  'rule-inside-body',
  'uncited-terminal-key',
  'uncited-parent-key',
  'changed-font',
  'wide-gap',
  'shifted-indent',
  'wide-tail',
  'completed-parent',
  'ordinary-prose-tail',
  'intervening-caption'
])('declines an unfinished glossary tail with %s', (variant) => {
  const f = fixture('unfinished-labeled-glossary-before-cited-terminal-key')
  const first = f.page.lines.at(-2),
    tail = f.page.lines.at(-1)
  if (variant === 'missing-rule') f.rules = []
  if (variant === 'rule-inside-body') f.tables[0].rect[3] = 392
  if (variant === 'uncited-terminal-key') f.page.lines[1].text = '(95% limits)'
  if (variant === 'uncited-parent-key') f.page.lines[0].text = '3D-CRT arm Other arm'
  if (variant === 'changed-font') tail.fontSize = 13
  if (variant === 'wide-gap') tail.y += 12
  if (variant === 'shifted-indent') tail.x += 4
  if (variant === 'wide-tail') tail.width = first.width
  if (variant === 'completed-parent') first.text += '.'
  if (variant === 'ordinary-prose-tail')
    tail.text = 'radiotherapy improved confidence in the treatment.'
  if (variant === 'intervening-caption')
    f.page.lines.push({
      text: 'Table 3',
      x: first.x,
      y: first.y + 16,
      width: 60,
      height: 12,
      fontSize: 12
    })
  const notes = associateTableNotes(f.page, f.tables, f.rules)
  expect(notes[0].some((n: { text: string }) => n.text.includes(tail.text))).toBe(false)
})

it('owns complete dose/target definitions and crops at the proved native table closings', () => {
  const f = fixture('ruled-dose-definitions-below-two-table-closings')
  const before = structuredClone(f)
  const notes = associateTableNotes(
    f.page,
    f.tables,
    f.rules.map((r: number[]) => r.map((v) => v / 1.5))
  )
  expect(notes.map((ns: object[]) => ns.length)).toEqual([3, 4])
  expect(notes[0][0].text).toContain(
    'calculating median DMean heart, as fraction doses are always very small.'
  )
  expect(notes[1][1].text).toContain(
    'DK patients, N = 210 for level I, N = 261 for the humeral head).'
  )
  expect(notes[1][2].text).toContain('SE Sweden.')
  expect(notes[1][3].text).toBe('* Wilcoxon rank sum test.')
  const crops = f.tables.map((table: object, n: number) =>
    recoverRuledDoseNoteCrop(
      table,
      notes[n].map((note: { rect: number[] }) => ({
        ...note,
        rect: note.rect.map((v) => v * 1.5)
      })),
      f.rules
    )
  )
  expect(crops.map((r: number[]) => r[3])).toEqual([431.11422764062513, 774.5752261757814])
  expect(f).toEqual(before)
})

it.each(['missing-closing-rule', 'dose-in-body', 'shifted-dose', 'isolated-target-definition'])(
  'declines dose note ownership with %s',
  (variant) => {
    const f = fixture('ruled-dose-definitions-below-two-table-closings')
    if (variant === 'missing-closing-rule') f.rules = []
    if (variant === 'dose-in-body') f.tables[1].rect[3] = 527
    if (variant === 'shifted-dose')
      f.page.lines.find((l: { text: string }) => l.text.startsWith('All doses given')).x += 100
    if (variant === 'isolated-target-definition')
      f.page.lines = f.page.lines.filter(
        (l: { text: string }) => !l.text.startsWith('All doses given')
      )
    const notes = associateTableNotes(
      f.page,
      f.tables,
      f.rules.map((r: number[]) => r.map((v) => v / 1.5))
    )
    expect(notes[1].some((n: { text: string }) => n.text.startsWith('All doses'))).toBe(false)
    expect(notes[1].some((n: { text: string }) => n.text.startsWith('Inclusion of level'))).toBe(
      false
    )
  }
)

it.each([
  'missing-rule',
  'note-over-owned-ink',
  'other-clipped-text',
  'unassigned-body',
  'incomplete-records'
])('keeps a padded dose crop diagnostic with %s', (variant) => {
  const f = fixture('ruled-dose-definitions-below-two-table-closings')
  const notes = associateTableNotes(
    f.page,
    f.tables,
    f.rules.map((r: number[]) => r.map((v) => v / 1.5))
  )
  const table = f.tables[1],
    dose = { ...notes[1][0], rect: notes[1][0].rect.map((v: number) => v * 1.5) }
  if (variant === 'missing-rule') f.rules = []
  if (variant === 'note-over-owned-ink') dose.rect[1] = 768
  if (variant === 'other-clipped-text')
    table.clipped.push({ text: 'Body label', rect: [55, 750, 80, 770] })
  if (variant === 'unassigned-body') table.unassigned.push('Unowned source')
  if (variant === 'incomplete-records')
    table.cells = table.cells.filter((c: { row: number }) => c.row === 1)
  expect(recoverRuledDoseNoteCrop(table, [dose], f.rules)).toBeUndefined()
})

it('owns a wrapped shared score heading above the highest-scored model header', () => {
  const f = fixture('wrapped-shared-score-header-over-two-timepoints')
  const before = structuredClone(f)
  const native = recoverSharedScoreTimepointGrid(f.table, f.tokens, f.captions, f.rules)
  expect(native.headerRows).toEqual([0, 1])
  expect(native.spans).toContainEqual({ row: 0, column: 1, rowSpan: 1, colSpan: 2 })
  expect(native.ownedTokens.size).toBe(14)
  expect(f).toEqual(before)
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid[0]).toEqual(['', 'Shared Symptom and Sign Score', ''])
  expect(result.grid[1]).toEqual(['', '3 mo', '6 mo'])
  expect(result.grid.slice(2).map((row: string[]) => row.slice(1))).toEqual([
    ['5.32 (2.85)', '3.68 (2.99)'],
    ['3.98 (2.86)', '2.56 (2.17)'],
    ['4.12 (2.84)', '2.80 (2.26)']
  ])
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
})

it.each([
  'missing-parent-rule',
  'missing-bottom-rule',
  'missing-maximum',
  'out-of-range-score',
  'uncentered-parent',
  'missing-paired-score',
  'competing-header',
  'different-time-units'
])('declines shared score ownership with %s', (variant) => {
  const f = fixture('wrapped-shared-score-header-over-two-timepoints')
  if (variant === 'missing-parent-rule') f.rules = f.rules.filter((r: number[]) => r[0] < 100)
  if (variant === 'missing-bottom-rule') f.rules = f.rules.filter((r: number[]) => r[1] < 280)
  if (variant === 'missing-maximum')
    f.tokens = f.tokens.filter((i: { text: string }) => !i.text.startsWith('Maximum score'))
  if (variant === 'out-of-range-score')
    f.tokens.find((i: { text: string }) => i.text === '5.32 (2.85)').text = '15.01 (2.85)'
  if (variant === 'uncentered-parent') {
    const parent = f.tokens.find((i: { text: string }) => i.text === 'and Sign Score')
    parent.rect[0] += 8
    parent.rect[2] += 8
  }
  if (variant === 'missing-paired-score')
    f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '3.68 (2.99)')
  if (variant === 'competing-header')
    f.tokens.push({ ...f.tokens[0], text: 'Unrelated heading', rect: [70, 162, 180, 174] })
  if (variant === 'different-time-units')
    f.tokens.find((i: { text: string }) => i.text === '6 mo').text = '6 weeks'
  expect(recoverSharedScoreTimepointGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})

it('owns unequal wrapped narrative paragraphs without moving aligned percentages to the next record', () => {
  const f = fixture('parallel-unequal-paragraphs-with-aligned-percentages')
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid.map((r: string[]) => [r[1], r[3]])).toEqual([
    ['(n = 292) %', '(n = 99) %'],
    ['92', '83'],
    ['93', '79'],
    ['75', '74']
  ])
  expect(result.grid[2][0]).toContain('courte dure')
  expect(result.grid[2][2]).toContain('domicile')
  expect(result.grid[3][2]).toContain('sociaux')
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
})

it('retains independent native leaf counts and parent spans beneath one comparison caption', () => {
  const f = fixture('changing-leaf-count-beneath-one-cohort-comparison-caption')
  const regions = splitRuledComparisonSections(f.table, f.tokens, f.captions, f.rules)
  expect(regions).toHaveLength(2)
  const results = regions.map((r: object) => refineTable(r, f.tokens, f.captions, [], f.rules))
  expect(results.map((r: { grid: string[][] }) => r.grid[0].length)).toEqual([7, 5])
  for (const [n, r] of results.entries()) {
    const span = n ? 2 : 3
    for (const c of [1, span + 1]) {
      expect(
        r.cells.find((cell: { row: number; column: number }) => cell.row === 0 && cell.column === c)
      ).toMatchObject({ rowSpan: 1, colSpan: span })
      expect(r.grid[0][c]).toMatch(/\(n = \d+[a-z,]*\) %$/)
    }
    expect(
      r.cells.find((cell: { row: number; column: number }) => cell.row === 0 && cell.column === 0)
    ).toMatchObject({ rowSpan: 2, colSpan: 1 })
    expect(r.unassigned).toEqual([])
  }
  expect(results[1].grid.slice(2)).toEqual([
    ['Format du dossier', '74', '26', '82', '18'],
    ['Contenu du dossier', '93', '7', '100', '0']
  ])
})

it.each(['missing-rules', 'incomplete-percentages', 'misaligned-percentage'])(
  'declines paragraph ownership with %s',
  (variant) => {
    const f = fixture('parallel-unequal-paragraphs-with-aligned-percentages')
    if (variant === 'missing-rules') f.rules = []
    if (variant === 'incomplete-percentages')
      f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '79')
    if (variant === 'misaligned-percentage') {
      const i = f.tokens.find((i: { text: string }) => i.text === '79')
      i.rect[0] += 20
      i.rect[2] += 20
    }
    expect(recoverParallelCountLists(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)

it.each(['missing-captions', 'missing-parent-rule', 'incomplete-body'])(
  'keeps a comparison together without sufficient section witnesses: %s',
  (variant) => {
    const f = fixture('changing-leaf-count-beneath-one-cohort-comparison-caption')
    if (variant === 'missing-captions') f.captions = []
    if (variant === 'missing-parent-rule') f.rules = f.rules.filter((r: number[]) => r[1] < 950)
    if (variant === 'incomplete-body')
      f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '100')
    expect(splitRuledComparisonSections(f.table, f.tokens, f.captions, f.rules)).toEqual([f.table])
  }
)

it.each([
  ['wrapped-frequency-note-after-double-column-table', 'as frequency (n).'],
  ['score-definition-and-following-statistics-below-closing-rule', '(P < 0.001).']
])('retains the complete native statistical note: %s', (name, tail) => {
  const f = fixture(name)
  const notes = associateTableNotes(
    f.page,
    [{ rect: f.cropRect.map((v: number) => v / 1.5) }],
    f.rules.map((r: number[]) => r.map((v) => v / 1.5))
  )[0]
  expect(notes[0].text.endsWith(tail)).toBe(true)
})

it('owns a notes-only glossary page through cited acronym keys and a raised symbol', () => {
  const f = fixture('cited-acronym-glossary-on-notes-only-continuation-page')
  const notes = associateContinuedTableNotes(f.table, f.page, f.nextPage)
  expect(notes).toHaveLength(2)
  expect(notes[0].text).toContain('CMF, cyclophosphamide/methotrexate/fluorouracil')
  expect(notes[1].text).toContain('equivocal FISH in IHC score 2+.')
  expect(notes.every((n: { page: number }) => n.page === f.nextPage.pageNumber)).toBe(true)
})

it.each(['missing-keys', 'ordinary-marker', 'extra-body', 'misaligned', 'different-font'])(
  'declines notes-only glossary ownership with %s',
  (variant) => {
    const f = fixture('cited-acronym-glossary-on-notes-only-continuation-page')
    if (variant === 'missing-keys') f.table.cells = [{ text: 'HER2' }]
    if (variant === 'ordinary-marker')
      for (const c of f.table.cells)
        c.textRuns = c.textRuns?.map((r: object) => ({ ...r, position: 'normal' }))
    if (variant === 'extra-body')
      f.nextPage.lines.push({
        text: 'Discussion starts below these paragraphs.',
        x: 70.9,
        y: 380,
        width: 280,
        height: 12,
        fontSize: 12
      })
    if (variant === 'misaligned') for (const l of f.nextPage.lines) l.x += 40
    if (variant === 'different-font')
      f.nextPage.lines.find((l: { text: string }) => /CMF/.test(l.text)).fontSize += 2
    expect(associateContinuedTableNotes(f.table, f.page, f.nextPage)).toEqual([])
  }
)

it('uses the complete last-page glossary to own a cited volume formula on the next notes-only page', () => {
  const f = fixture('cited-volume-formula-on-notes-only-continuation-page')
  f.table.notes = associateTableNotes(
    f.page,
    [{ rect: f.table.cropRect.map((v: number) => v / 1.5) }],
    f.rules
  )[0]
  expect(f.table.notes[0].text.endsWith('SD, standard deviation.')).toBe(true)
  const before = structuredClone(f)
  expect(associateContinuedTableNotes(f.table, f.page, f.nextPage)).toEqual([
    expect.objectContaining({
      text: '* Vx, percent volume receiving ≥x Gy.',
      page: f.nextPage.pageNumber
    })
  ])
  expect(f).toEqual(before)
})

it.each([
  'extra-body',
  'misaligned',
  'skipped-page',
  'missing-citations',
  'ordinary-marker',
  'short-table',
  'missing-prior-glossary'
])('declines notes-only formula ownership with %s', (variant) => {
  const f = fixture('cited-volume-formula-on-notes-only-continuation-page')
  f.table.notes = associateTableNotes(
    f.page,
    [{ rect: f.table.cropRect.map((v: number) => v / 1.5) }],
    f.rules
  )[0]
  if (variant === 'extra-body')
    f.nextPage.lines.push({
      text: 'Discussion begins with the following paragraph.',
      x: 70.9,
      y: 125,
      width: 250,
      height: 12,
      fontSize: 12
    })
  if (variant === 'misaligned') for (const l of f.nextPage.lines) l.x += 40
  if (variant === 'skipped-page') f.nextPage.pageNumber++
  if (variant === 'missing-citations') f.table.cells = []
  if (variant === 'ordinary-marker')
    for (const c of f.table.cells)
      c.textRuns = c.textRuns?.map((r: object) => ({ ...r, position: 'normal' }))
  if (variant === 'short-table') f.table.cropRect[3] = f.page.height * 0.6 * 1.5
  if (variant === 'missing-prior-glossary') f.table.notes = []
  expect(associateContinuedTableNotes(f.table, f.page, f.nextPage)).toEqual([])
})

it('exposes complete parent spans in the comparison helper', () => {
  const f = fixture('changing-leaf-count-beneath-one-cohort-comparison-caption')
  for (const region of splitRuledComparisonSections(f.table, f.tokens, f.captions, f.rules)) {
    const recovered = recoverStudyParagraphGrid(region, f.tokens, f.captions, f.rules)
    expect(recovered.spans.every((s: { rowSpan: number }) => s.rowSpan >= 1)).toBe(true)
  }
})

it('bounds the split grid before a clipped raised note and groups both source-owned regions under their original caption', () => {
  const f = fixture('changing-leaf-count-beneath-one-cohort-comparison-caption')
  const regions = splitRuledComparisonSections(f.table, f.tokens, f.captions, f.rules)
  const first = regions.map((r: object) => refineTable(r, f.tokens, f.captions, [], f.rules))
  const notes = associateTableNotes(
    f.page,
    first.map((t: { cropRect: number[] }) => ({ rect: t.cropRect.map((v) => v / 1.5) })),
    f.rules.map((r: number[]) => r.map((v) => v / 1.5))
  )
  expect(notes[0]).toEqual([])
  expect(notes[1].map((n: { text: string }) => n.text[0])).toEqual(['a', 'b', 'c'])
  const tables = regions.map((r: object, n: number) => ({
    ...refineTable(
      r,
      f.tokens,
      f.captions,
      notes[n].map((note: { rect: number[] }) => ({
        ...note,
        rect: note.rect.map((v) => v * 1.5)
      })),
      f.rules
    ),
    page: 5,
    notes: notes[n],
    ...(n
      ? {}
      : {
          caption: {
            text: 'Tableau 4 Satisfaction des utilisateurs du dossier',
            page: 5,
            rect: f.captions.at(-1).rect.map((v: number) => v / 1.5)
          }
        })
  }))
  for (const t of tables) {
    expect(t.unassigned).toEqual([])
    expect(t.issues).toEqual([])
  }
  const before = structuredClone(tables)
  const groups = groupRuledComparisonSections(groupTableParts([...tables].reverse(), f.page))
  expect(groups).toHaveLength(1)
  expect(groups[0].parts.map((p: { grid: string[][] }) => p.grid[0].length)).toEqual([7, 5])
  expect(groups[0].notes).toHaveLength(3)
  expect(groups[0].parts.every((p: { notes: unknown[] }) => !p.notes.length)).toBe(true)
  expect(groups[0].cropRect[3]).toBeLessThan(notes[1][0].rect[1] * 1.5)
  expect(tables).toEqual(before)
})

it.each(['unrelated-id', 'own-caption', 'same-columns', 'gap', 'overlap', 'first-has-notes'])(
  'does not group independent comparison candidates with %s',
  (variant) => {
    const first = {
      id: 'native-comparison-section-1',
      page: 1,
      cropRect: [0, 0, 300, 100],
      caption: { text: 'Table 1' },
      grid: [['Impact', 'One', 'Two']],
      notes: []
    }
    const next = {
      id: 'native-comparison-section-2',
      page: 1,
      cropRect: [0, 110, 300, 180],
      grid: [['Satisfaction', 'One', 'Two', 'Three']],
      notes: []
    } as ReturnType<typeof JSON.parse>
    if (variant === 'unrelated-id') next.id = 'unrelated-section-2'
    if (variant === 'own-caption') next.caption = { text: 'Table 2' }
    if (variant === 'same-columns') next.grid = structuredClone(first.grid)
    if (variant === 'gap') next.cropRect[1] = 150
    if (variant === 'overlap') next.cropRect[1] = 90
    if (variant === 'first-has-notes')
      (first as ReturnType<typeof JSON.parse>).notes = [{ text: '* Note' }]
    expect(groupRuledComparisonSections([first, next])).toEqual([first, next])
  }
)

const { associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)

it('retains the original caption through a complete count-percent intermediate page', () => {
  const f = fixture('count-percent-table-through-captionless-intermediate-page')
  const before = structuredClone(f)
  expect(associateTableCaptions(f.page, f.tables, f.captions, [], f.pages)).toEqual([
    { caption: f.captions[0] }
  ])
  expect(f).toEqual(before)
})

it.each([
  'missing-origin',
  'intervening-caption',
  'extra-prose',
  'different-count-total',
  'shifted-lanes',
  'incomplete-bridge',
  'competing-origin',
  'multiple-tables'
])('declines a two-page caption chain with %s', (variant) => {
  const f = fixture('count-percent-table-through-captionless-intermediate-page')
  const middle = f.pages[1]
  if (variant === 'missing-origin') f.pages.shift()
  if (variant === 'intervening-caption')
    f.captions.push({ page: 2, lines: ['Table 2'], rect: [70, 40, 120, 52] })
  if (variant === 'extra-prose')
    middle.lines.push({
      text: 'Discussion begins with the following results.',
      x: 108.3,
      y: 400,
      width: 300,
      height: 12,
      fontSize: 12
    })
  if (variant === 'different-count-total')
    f.pages[0].lines.find((l: { text: string }) => /Cohort-A/.test(l.text)).text =
      'Cohort-A (n = 200) Cohort-B (n = 344)'
  if (variant === 'shifted-lanes')
    for (const l of middle.lines) {
      l.x += 30
      l.width += 30
    }
  if (variant === 'incomplete-bridge') middle.lines.pop()
  if (variant === 'competing-origin')
    f.captions.push({ page: 1, lines: ['Table 2'], rect: [70, 180, 120, 192] })
  if (variant === 'multiple-tables') f.tables.push({ rect: [0, 0, 40, 40] })
  expect(
    associateTableCaptions(f.page, f.tables, f.captions, [], f.pages).every(
      (r: { caption?: unknown }) => !r.caption
    )
  ).toBe(true)
})

it('owns an explicit uncorrected P note before the adjacent raised-symbol definitions', () => {
  const f = fixture('uncorrected-statistical-note-before-symbol-definitions')
  const notes = associateTableNotes(f.page, [{ rect: f.cropRect.map((v: number) => v / 1.5) }])[0]
  expect(notes.map((n: { text: string }) => n.text)).toEqual([
    'Uncorrected p values.',
    '*The Mann-Whitney U test was used if not stated otherwise.',
    '†Only significant p value (0.01) when Bonferroni corrected by a factor 26.'
  ])
})
