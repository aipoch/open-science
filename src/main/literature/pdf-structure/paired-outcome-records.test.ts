import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledComparisonRecords } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/paired-outcome-records-in-column-continuations.jsonl'
    )
  )

it('preserves each paired count and percentage record in a continuation column', () => {
  const x = fixture().cases[1]
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.unassigned).toEqual([])
  expect(r.grid).toContainEqual(['%', '2.5', '3.2', '5.2', '', ''])
  expect(r.grid).toContainEqual(['No.', '383', '385', '372', '.867', '.118'])
  expect(r.grid).toContainEqual(['Clinical response at surgery', '', '', '', '', ''])
  expect(r.grid).toContainEqual(['Tumor resection (lumpectomy)', '', '', '', '', ''])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    x.tokens.map((i: { rect: number[] }) => i.rect).sort()
  )
})

it('preserves sparse section labels, separate cohorts and raised significance markers', () => {
  const x = fixture().cases[0]
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid).toContainEqual(['Grade 0', '', '', '', '', ''])
  expect(r.grid).toContainEqual(['No.', '32', '39', '29', '', ''])
  expect(r.grid).toContainEqual([
    'Grade in patients with locally advanced stages only',
    '',
    '',
    '',
    '',
    ''
  ])
  expect(r.grid).toContainEqual(['No.', '2', '5', '9', '.446†', '.305'])
  expect(r.grid.every((row: string[]) => row.some(Boolean))).toBe(true)
  expect(r.unassigned).toEqual(['(continued in next column)'])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    x.tokens
      .filter((i: { text: string }) => i.text !== '(continued in next column)')
      .map((i: { rect: number[] }) => i.rect)
      .sort()
  )
})

it('retains the continuation cue as a note during the production second refinement', () => {
  const cases = fixture().cases
  const results = cases.map((x: ReturnType<typeof JSON.parse>) =>
    refineTable(x.table, x.tokens, x.captions, [], x.rules)
  )
  const noteFixture = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/centered-next-column-continuation-note.jsonl'
    )
  )
  const tables = results.map((r: ReturnType<typeof JSON.parse>) => ({
    rect: [r.cropRect[0], r.rows[0].rect[1], r.cropRect[2], r.rows.at(-1).rect[3]].map(
      (v) => v / 1.5
    )
  }))
  const notes = associateTableNotes(noteFixture.page, tables, noteFixture.rules)
  const x = cases[0]
  const r = refineTable(
    x.table,
    x.tokens,
    x.captions,
    notes[0].map((n: { text: string; rect: number[] }) => ({
      ...n,
      rect: n.rect.map((v) => v * 1.5)
    })),
    x.rules
  )
  expect(notes[0].map((n: { text: string }) => n.text)).toEqual(['(continued in next column)'])
  expect(r.unassigned).toEqual([])
  expect(r.grid.flat()).not.toContain('(continued in next column)')
  expect(r.grid.at(-1)).toEqual(['%', '24.0', '21.7', '25.7', '', ''])
})

it.each([
  'missing-count',
  'unpaired-percentage',
  'crossed-column',
  'separated-pair',
  'missing-parent',
  'missing-frame'
])('rejects ambiguous paired records with %s', (variant) => {
  const x = fixture().cases[1]
  const percentage = x.tokens.find((i: { text: string }) => i.text === '2.5')
  const countLabel = x.tokens.find(
    (i: { text: string; baseline: number }) =>
      i.text === 'No.' && Math.abs(i.baseline - percentage.baseline + 15) < 0.1
  )
  if (variant === 'missing-count')
    x.tokens = x.tokens.filter(
      (i: { text: string; baseline: number }) =>
        i.text !== '12' || Math.abs(i.baseline - countLabel.baseline) > 0.1
    )
  if (variant === 'unpaired-percentage') countLabel.text = 'Summary'
  if (variant === 'crossed-column') percentage.rect[2] += 60
  if (variant === 'separated-pair')
    for (const i of x.tokens.filter(
      (i: { baseline: number }) => Math.abs(i.baseline - percentage.baseline) < 0.1
    )) {
      i.rect[1] += 4
      i.rect[3] += 4
      i.baseline += 4
    }
  if (variant === 'missing-parent')
    x.rules = x.rules.filter((r: number[]) => r[1] < 140 || r[1] > 142)
  if (variant === 'missing-frame') x.rules = x.rules.filter((r: number[]) => r[1] < 968)
  expect(recoverRuledComparisonRecords(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})
