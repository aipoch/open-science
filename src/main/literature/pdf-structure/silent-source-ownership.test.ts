import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/' + name + '.jsonl')
  )
const refine = (name: string): ReturnType<typeof JSON.parse> => {
  const x = load(name)
  return refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
}
it('keeps separately ruled treatment parents above repeated grade columns', () => {
  const t = refine('ruled-adverse-events-with-separated-treatment-parents')
  expect(t.grid[0]).toEqual([
    'Adverse events',
    'PUFA Ω-3 (n = 26)',
    '',
    'Placebo (n = 26)',
    '',
    'p value'
  ])
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 1)
  ).toMatchObject({ colSpan: 2 })
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 3)
  ).toMatchObject({ colSpan: 2 })
})
it.each([
  [0, 'Adverse events'],
  [5, 'p value']
])(
  'recovers a vertically centered header enclosed across both tiers, column %s',
  (column, text) => {
    const t = refine('ruled-adverse-events-with-separated-treatment-parents')
    expect(t.cells.find((c: { text: string }) => c.text === text)).toMatchObject({
      row: 0,
      column,
      rowSpan: 2,
      colSpan: 1
    })
  }
)
it.each(['partial divider', 'missing side'])(
  'does not infer a merged header with %s',
  (variant) => {
    const x = load('ruled-adverse-events-with-separated-treatment-parents')
    const title = x.tokens.find((i: { text: string }) => i.text === 'p value')
    const boundary = Math.min(
      ...x.rules
        .filter((r: number[]) => r[1] === r[3] && r[1] > title.rect[1] && r[1] < title.baseline)
        .map((r: number[]) => r[1])
    )
    if (variant === 'partial divider')
      x.rules.push([title.rect[0] - 2, boundary, title.rect[2] - 2, boundary])
    else {
      const right = Math.min(
        ...x.rules
          .filter((r: number[]) => r[0] === r[2] && r[0] > title.rect[2])
          .map((r: number[]) => r[0])
      )
      x.rules = x.rules.filter((r: number[]) => r[0] !== right || r[2] !== right)
    }
    const t = refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
    expect(t.cells.find((c: { text: string }) => c.text === 'p value')).toMatchObject({
      rowSpan: 1
    })
  }
)
it('separates paired treatment measurements and preserves both shared test columns', () => {
  const t = refine('ruled-measures-with-paired-treatments-and-shared-tests')
  expect(t.grid).toHaveLength(19)
  expect(t.grid[2].slice(0, 4)).toEqual([
    'PUFA Ω-3',
    '68 ± 1.8 (64-71)',
    '66.6 ± 1.8 (62.7-70.4)',
    '66.2 ± 1.7 (62.7-69.8)'
  ])
  expect(t.grid[3][0]).toBe('Placebo')
  expect(
    t.cells.filter((c: { rowSpan: number; column: number }) => c.rowSpan === 3 && c.column >= 4)
  ).toHaveLength(12)
  expect(t.grid[4][4]).toBe('0.64')
  expect(t.grid[4][5]).toBe('0.70')
  expect(t.issues).toEqual([])
})
it('keeps wrapped demographic labels and deviation tails in their source columns', () => {
  const t = refine('wrapped-demographics-with-detached-deviation-tails')
  // The source repeats one education label with different counts; retain both.
  expect(t.grid).toHaveLength(27)
  expect(t.grid.find((r: string[]) => r[0].startsWith('Depression score'))).toEqual([
    'Depression score (M ± SD)',
    '6.74/21.00 (4.61)',
    '6.93/21.00 (4.19)',
    '.891'
  ])
  expect(t.grid.find((r: string[]) => r[0].startsWith('Number of children'))?.[0]).toBe(
    'Number of children (M ± SD)'
  )
  expect(t.grid.filter((r: string[]) => r[0] === 'Upper from high school')).toHaveLength(2)
  expect(t.issues).toEqual([])
})
it('does not attach a new numeric value as a deviation continuation', () => {
  const x = load('wrapped-demographics-with-detached-deviation-tails')
  const tail = x.tokens.find((i: { text: string }) => i.text === '(4.19)')
  tail.text = '99'
  const t = refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
  expect(t.grid.find((r: string[]) => r[0].includes('Depression score'))?.[2]).toBe('6.93/21.00')
  expect(t.issues).toContain('unresolved-spanning-cells')
})
it('does not join a bracketed label across a native record boundary', () => {
  const x = load('cardiac-event-label-with-bracketed-continuation')
  const tail = x.tokens.find((i: { text: string }) => i.text.includes('[NYHA'))
  const y = tail.rect[1] - 1
  x.rules.push([x.table.cropRect[0], y, x.table.cropRect[2], y])
  const t = refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
  expect(t.grid).toHaveLength(34)
})
it('does not recover an overlapping raised note without a closing rule', () => {
  const x = load('statistical-method-notes-with-raised-or-unmarked-openings').cases[1]
  const notes = associateTableNotes(x.page, x.tables, []).flat()
  expect(notes.map((n: { text: string }) => n.text)).not.toContain(
    'a The results of the Mann–Whitney U test.'
  )
})
it('does not merge complete numeric cohort records into projected section spans', () => {
  const t = refine('numeric-cohort-rows-misread-as-section-spans')
  expect(t.grid[11]).toEqual(['Taxanes only', '3 (7%)', '1 (7%)', '0', '2 (13%)'])
  expect(t.grid[19]).toEqual(['BRCA1/2', '3 (7%)', '2 (17%)', '1 (8%)', '0'])
  expect(t.grid[22]).toEqual(['I', '13 (29%)', '5 (33%)', '6 (40%)', '2 (13%)'])
})
it('joins a bracketed continuation of a clinical event label', () => {
  const t = refine('cardiac-event-label-with-bracketed-continuation')
  expect(t.grid).toHaveLength(33)
  expect(t.grid[30]).toEqual([
    'Primary cardiac events (heart failure [NYHA functional classification III or IV] and significant LVEF declineb)',
    '0',
    '0'
  ])
})
it.each([0, 1])('retains statistical-method notes below the table, case %s', (index) => {
  const x = load('statistical-method-notes-with-raised-or-unmarked-openings').cases[index]
  const notes = associateTableNotes(x.page, x.tables, x.rules).flat()
  if (index === 0)
    expect(notes.map((n: { text: string }) => n.text).join(' ')).toContain(
      'CTCAE (version 4.03, June 2010)'
    )
  else
    expect(notes.map((n: { text: string }) => n.text)).toContain(
      'a The results of the Mann–Whitney U test.'
    )
})
it('retains a spelled-out statistical note with an unfamiliar parenthesized abbreviation', () => {
  const x = load('statistical-method-notes-with-raised-or-unmarked-openings').cases[2]
  const notes = associateTableNotes(x.page, x.tables, x.rules).flat()
  expect(notes.map((n: { text: string }) => n.text)).toEqual([
    'Data reported as mean ± standard error (ESM). PUFA Ω-3: omega 3 polyunsaturated fatty acids; CI: 95% confidence interval. Analyzed by the ANOVA test of repeated measures. Statistically significant difference at p < 0.05).'
  ])
})
