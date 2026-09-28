import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { associateTableNotes, associateContinuedTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/double-spaced-manuscript-captions-and-numbered-notes.jsonl'
    )
  )
it('retains short double-spaced title tails before a ruled manuscript table', () => {
  const f = load()
  for (const [page, tail] of [
    [30, 'progression in the ITT population'],
    [31, 'populations']
  ] as const) {
    const p = f.pages.find((p: { pageNumber: number }) => p.pageNumber === page)
    const captions = findCaptionCandidates([p], new Map([[page, f.rules[page]]]))
    expect(captions[0].lines.at(-1)).toBe(tail)
  }
})
it.each([30, 32])(
  'retains complete double-spaced glossary and numbered notes on page %s',
  (page) => {
    const f = load(),
      p = f.pages.find((p: { pageNumber: number }) => p.pageNumber === page),
      t = f.tables.find((t: { page: number }) => t.page === page)
    const notes = associateTableNotes(
      p,
      [{ rect: t.cropRect.map((v: number) => v / 1.5) }],
      f.rules[page]
    )[0]
    if (page === 30) {
      expect(notes).toHaveLength(3)
      expect(notes[0].text).toContain('They are excluded from the per protocol population')
      expect(notes[2].text).toContain('cauda equina (n=1).')
    } else {
      expect(notes).toHaveLength(5)
      expect(notes[0].text).toContain('SD: stable disease')
      expect(notes[4].text).toContain('treatment termination, mainly due to clinical progression')
    }
  }
)
it('associates sequential raised numeric notes on a following notes-only page without a repeated title', () => {
  const f = load(),
    p = f.pages.find((p: { pageNumber: number }) => p.pageNumber === 32),
    next = f.pages.find((p: { pageNumber: number }) => p.pageNumber === 33),
    t = f.tables.find((t: { page: number }) => t.page === 32)
  t.notes = associateTableNotes(
    p,
    [{ rect: t.cropRect.map((v: number) => v / 1.5) }],
    f.rules[32]
  )[0]
  const notes = associateContinuedTableNotes(t, p, next)
  expect(notes).toHaveLength(3)
  expect(notes.map((n: { text: string }) => n.text[0])).toEqual(['5', '6', '7'])
  expect(notes[1].text).toContain('negative or equivocal)')
  expect(notes[2]).toMatchObject({ page: 33 })
  for (const note of notes) {
    expect(note.rect.every(Number.isFinite)).toBe(true)
    expect(note.rect[2]).toBeGreaterThan(note.rect[0])
    expect(note.rect[3]).toBeGreaterThan(note.rect[1])
  }
})

it('retains the only remaining wrapped raised note below a continuation table', () => {
  const f = load(),
    p = f.pages.find((p: { pageNumber: number }) => p.pageNumber === 29),
    t = f.tables.find((t: { page: number }) => t.page === 29)
  const notes = associateTableNotes(
    p,
    [{ rect: t.cropRect.map((v: number) => v / 1.5) }],
    f.rules[29]
  )[0]
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toContain(
    'ductal and micro papillary, 3 breast cancers not otherwise specified'
  )
})

it.each([
  'missing-prior-notes',
  'missing-citations',
  'ordinary-digits',
  'broken-number-sequence',
  'extra-body',
  'misaligned',
  'not-at-page-end',
  'skipped-page'
])('declines cross-page manuscript ownership with %s', (variant) => {
  const f = load(),
    p = f.pages.find((p: { pageNumber: number }) => p.pageNumber === 32),
    next = f.pages.find((p: { pageNumber: number }) => p.pageNumber === 33),
    t = f.tables.find((t: { page: number }) => t.page === 32)
  t.notes = associateTableNotes(
    p,
    [{ rect: t.cropRect.map((v: number) => v / 1.5) }],
    f.rules[32]
  )[0]
  if (variant === 'missing-prior-notes') t.notes = []
  if (variant === 'missing-citations') t.cells = []
  if (variant === 'ordinary-digits')
    for (const line of next.lines.filter((l: { text: string }) => /^\d$/.test(l.text))) {
      line.fontSize = 12
      line.height = 12
    }
  if (variant === 'broken-number-sequence')
    next.lines.find((l: { text: string }) => l.text === '6').text = '8'
  if (variant === 'extra-body')
    next.lines.push({
      text: 'Discussion of the results begins here.',
      x: 70.86,
      y: 360,
      width: 310,
      height: 12,
      fontSize: 12
    })
  if (variant === 'misaligned') for (const line of next.lines) line.x += 40
  if (variant === 'not-at-page-end') t.notes.at(-1).rect[3] = p.height * 0.7
  if (variant === 'skipped-page') next.pageNumber++
  expect(associateContinuedTableNotes(t, p, next)).toEqual([])
})
it('does not extend a short title tail without its opening table rule', () => {
  const f = load(),
    p = f.pages.find((p: { pageNumber: number }) => p.pageNumber === 31)
  expect(findCaptionCandidates([p])[0].lines).toHaveLength(1)
})
it('does not treat ordinary manuscript prose as an isolated raised-note continuation', () => {
  const f = load(),
    p = f.pages.find((p: { pageNumber: number }) => p.pageNumber === 29),
    t = f.tables.find((t: { page: number }) => t.page === 29)
  p.lines.push({
    text: 'Another paragraph follows with the same typeface.',
    x: 70.86,
    y: 240,
    width: 360,
    height: 12,
    fontSize: 12
  })
  const notes = associateTableNotes(
    p,
    [{ rect: t.cropRect.map((v: number) => v / 1.5) }],
    f.rules[29]
  )[0]
  expect(notes[0].text).not.toContain('ductal and micro papillary')
  expect(notes[0].text).not.toContain('Another paragraph')
})
it('keeps original native pages and table references unchanged', () => {
  const f = load(),
    before = structuredClone(f)
  for (const p of f.pages) {
    findCaptionCandidates([p], new Map([[p.pageNumber, f.rules[p.pageNumber] ?? []]]))
    const t = f.tables.find((t: { page: number }) => t.page === p.pageNumber)
    if (t)
      associateTableNotes(
        p,
        [{ rect: t.cropRect.map((v: number) => v / 1.5) }],
        f.rules[p.pageNumber]
      )
  }
  expect(f).toEqual(before)
})

it('preserves grouped populations and separates ratios from probability lines on a short continuation', async () => {
  const { refineTable } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
  )
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/continued-paired-outcomes-with-separate-probability-lines.jsonl'
    )
  )
  const t = refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
  expect(t.grid).toHaveLength(19)
  expect(t.grid[0]).toEqual(['', 'ITT population', '', 'Per Protocol population 1', ''])
  expect(t.grid[15]).toEqual([
    'Unadjusted HR (95% CI)',
    '1 (ref)',
    '0.85 (0.53 -1.36)',
    '1 (ref)',
    '0.81 (0.50-1.32)'
  ])
  expect(t.grid[16]).toEqual(['P-value', 'P=0.51', '', 'P=0.40', ''])
  expect(t.grid[17][0]).toBe('Adjusted HR (95% CI) 6')
  expect(t.grid[18]).toEqual(['P-value', 'P=0.057', '', 'P=0.04', ''])
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 1)
  ).toMatchObject({ colSpan: 2 })
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
})

it('separates complete treatment records within ruled sections while retaining centered wrapped labels', async () => {
  const { refineTable } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
  )
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/ruled-treatment-sections-with-centered-values-and-wrapped-labels.jsonl'
    )
  )
  const t = refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
  expect(t.grid).toHaveLength(22)
  expect(t.grid[3]).toEqual([
    'Duration of treatment, months, median (range)',
    '11.3',
    '3.1 (0.4 ; 31.4)'
  ])
  expect(t.grid[8]).toEqual([
    'Systemic treatment, n (%) 1 until LM progression or end of study',
    '36 (97%)',
    '33 (92%)'
  ])
  expect(t.grid[10]).toEqual(['Type of systemic treatment (sometimes in combination)', '', ''])
  expect(t.grid[11]).toEqual(['Chemotherapy 2', '33', '33'])
  expect(t.grid.at(-1)).toEqual(['Systemic therapy', '19', '10'])
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})

it.each(['missing-rule', 'incomplete-values', 'ambiguous-value', 'unindented-section'])(
  'declines sectioned centered records with %s',
  async (variant) => {
    const { recoverRuledRecordFaces } = await import(
      pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-record-faces.mjs')).href
    )
    const x = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/source-grids/ruled-treatment-sections-with-centered-values-and-wrapped-labels.jsonl'
      )
    )
    if (variant === 'missing-rule') x.rules = []
    if (variant === 'incomplete-values')
      x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '11.3')
    if (variant === 'ambiguous-value') {
      const i = x.tokens.find((i: { text: string }) => i.text === '11.3')
      i.baseline += 10
      i.rect[1] += 10
      i.rect[3] += 10
    }
    if (variant === 'unindented-section') {
      for (const i of x.tokens.filter(
        (i: { rect: number[] }) => i.rect[0] > 80 && i.rect[2] < 400 && i.rect[1] > 535
      )) {
        i.rect[0] -= 14
        i.rect[2] -= 14
      }
    }
    expect(recoverRuledRecordFaces(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
  }
)
