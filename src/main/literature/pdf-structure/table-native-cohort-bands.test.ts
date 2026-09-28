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
const parse = (x: ReturnType<typeof load>): ReturnType<typeof JSON.parse> =>
  refineTable(x.table, x.tokens, x.captions, x.notes ?? [], x.rules)
it('uses native horizontal borders to separate cohort records and wide section labels', () => {
  const t = parse(load('fully-ruled-cohort-sections-with-wide-wrapped-labels'))
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
  expect(t.grid.find((r: string[]) => r[0] === 'Absence of mutation')).toEqual([
    'Absence of mutation',
    '30 (47.6%)',
    '34 (53.1%)',
    ''
  ])
  expect(t.grid.find((r: string[]) => r[0] === 'Unknown')).toEqual([
    'Unknown',
    '26 (41.2%)',
    '26 (40.6%)',
    ''
  ])
  expect(t.grid.find((r: string[]) => r[0].startsWith('Disease-free interval'))).toEqual([
    'Disease-free interval (% of recurrent)',
    '',
    '',
    'NT'
  ])
})
it('keeps the complete wrapped cohort headings inside one native header band', () => {
  const t = parse(load('fully-ruled-cohorts-with-wrapped-column-headings'))
  expect(t.grid[0][1]).toContain('(N = 63)')
  expect(t.grid[1][0]).toBe('Positivity by sample type')
  expect(t.issues).toEqual([])
})
it('keeps paired summary labels on their own records while preserving raised markers', () => {
  const t = parse(load('paired-summary-records-with-raised-stub-markers'))
  expect(t.grid[2][0]).toBe('')
  expect(t.grid[3][0]).toBe('Lesion size (mm)')
  expect(t.cells).toContainEqual(expect.objectContaining({ row: 3, column: 0, rowSpan: 2 }))
  expect(t.cells).toContainEqual(
    expect.objectContaining({ row: 9, column: 0, rowSpan: 2, text: 'Water/fat ratioa' })
  )
  expect(t.issues).toEqual([])
})
it('preserves each sectioned count and percentage record under its cohort pair', () => {
  const t = parse(load('sectioned-cohort-counts-with-paired-percentage-columns'))
  expect(t.grid.find((r: string[]) => r[0] === 'Invasive ductal carcinoma')).toEqual([
    'Invasive ductal carcinoma',
    '23',
    '62%',
    '23',
    '62%',
    '46',
    '63%'
  ])
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
  expect(t.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 5, colSpan: 2, text: 'All patients (N=73)' })
  )
})
it.each(['left', 'right'])('keeps %s-edge clipped text out of recovered cohort cells', (edge) => {
  const x = load('sectioned-cohort-counts-with-paired-percentage-columns')
  const source = x.tokens.find(
    (token: { text: string }) => token.text === 'Invasive ductal carcinoma'
  )
  const [left, , right] = x.table.cropRect
  const foreign = {
    ...source,
    text: 'Adjacent page text',
    rect: [
      edge === 'left' ? left - 5 : right - 15,
      source.rect[1],
      edge === 'left' ? left + 15 : right + 5,
      source.rect[3]
    ]
  }
  x.tokens.push(foreign)
  const table = parse(x)
  expect(table.grid.find((row: string[]) => row[0] === 'Invasive ductal carcinoma')).toEqual([
    'Invasive ductal carcinoma',
    '23',
    '62%',
    '23',
    '62%',
    '46',
    '63%'
  ])
  expect(table.cells.some((cell: { text: string }) => cell.text.includes(foreign.text))).toBe(false)
  expect(table.unassigned).toContain(foreign.text)
  expect(table.issues).toContain('unassigned-source-text')
})

it('recovers the terminal count record within matching native side borders', () => {
  const t = parse(load('continued-cohort-counts-with-terminal-record'))
  expect(t.grid.at(-1)).toEqual(['No neurological deficit', '11', '30%', '5', '14%', '16', '22%'])
  expect(t.grid.some((r: string[]) => r[0].includes('prior to randomization'))).toBe(true)
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
})
it('keeps a wrapped outcome label on its whole repeated visit cycle', () => {
  const t = parse(load('repeated-visits-with-wrapped-outcome-stubs'))
  expect(t.cells).toContainEqual(
    expect.objectContaining({
      row: 2,
      column: 0,
      rowSpan: 3,
      text: "Problem-focused coping' score (total score ranged between 0–100)"
    })
  )
  expect(t.grid[3][1]).toBe('Immediately after the intervention')
  expect(t.grid[4][1]).toBe('One month after the intervention')
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})
it('separates a shared unit band from repeated grade leaves and wrapped cohort titles', () => {
  const t = parse(load('paired-grade-headings-with-common-unit-band'))
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 5)
  ).toMatchObject({ colSpan: 2 })
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 2 && c.column === 1)
  ).toMatchObject({ colSpan: 6, text: 'Number of patients (%)' })
  expect(t.grid[1].slice(1)).toEqual([
    'All Grades',
    'Grade 3',
    'All Grades',
    'Grade 3',
    'All Grades',
    'Grade 3'
  ])
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})
it('retains the opening wrapped stub that crosses a continued table detector edge', () => {
  const t = parse(load('continued-count-table-with-clipped-opening-stub'))
  expect(t.grid[0]).toEqual([
    'Light functional neurological disorder, allowing useful work',
    '15',
    '41%',
    '14',
    '39%',
    '29',
    '40%'
  ])
  expect(t.unassigned).toEqual([])
  expect(t.issues).toEqual([])
})
it('uses partial row rules to preserve shared category and probability cells', () => {
  const t = parse(load('partial-row-rules-with-shared-category-and-probability'))
  expect(t.grid).toHaveLength(17)
  expect(t.grid[1].slice(3, 5)).toEqual(['Yes (N = 13)', 'No (N = 25)'])
  expect(t.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 0, rowSpan: 2, colSpan: 2 })
  )
  expect(t.cells).toContainEqual(
    expect.objectContaining({ row: 2, column: 0, rowSpan: 3, text: 'Arm Assigned' })
  )
  expect(t.cells).toContainEqual(
    expect.objectContaining({ row: 5, column: 5, rowSpan: 6, text: '0.007' })
  )
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})
it('joins segmented table rules without treating an explicit None count as a heading', () => {
  const t = parse(load('segmented-rules-with-explicit-none-in-count-column'))
  expect(t.grid).toHaveLength(28)
  expect(t.grid[3]).toEqual(['None', 'None', '1 (3.0)', '.552'])
  expect(t.grid.at(-1)).toEqual(['Right', '0.14 (0.04-0.23)', '0.24 (0.14-0.49)', '.001*'])
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
})
