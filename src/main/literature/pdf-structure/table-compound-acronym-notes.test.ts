import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/compound-acronym-notes.jsonl')
  )
it('recovers the complete native glossary including a compound treatment acronym', () => {
  const x = load(),
    notes = associateTableNotes(x.page, x.tables, x.rules)
  expect(notes[0]).toHaveLength(1)
  expect(notes[0][0].text).toBe(
    'MVPA: Moderate-to-vigorous physical activity. PAC: Physical activity counselling group. PAC+F: Physical activity counselling plus Fitbit group.'
  )
  const i = x.input
  const before = refineTable(i.table, i.tokens, i.captions, [], i.rules)
  const after = refineTable(
    i.table,
    i.tokens,
    i.captions,
    notes[0].map((n: { rect: number[] }) => ({ ...n, rect: n.rect.map((v) => v * 1.5) })),
    i.rules
  )
  expect(after.grid).toEqual(before.grid)
  expect(after.clipped).toEqual([])
  expect(after.unassigned).toEqual([])
})
it.each(['single-definition', 'prose', 'inside-grid', 'large-gap'])(
  'keeps ambiguous definition-like text outside the note set: %s',
  (kind) => {
    const x = load()
    if (kind === 'single-definition')
      x.page.lines = x.page.lines.filter((l: { text: string }) => !/^PAC[:+]/.test(l.text))
    if (kind === 'prose')
      x.page.lines.forEach((l: { text: string }) => {
        l.text = l.text
          .replace(/^MVPA:/, 'Background:')
          .replace(/^PAC:/, 'Methods:')
          .replace(/^PAC\+F:/, 'Results:')
      })
    if (kind === 'inside-grid') x.tables[0].rect[3] += 60
    if (kind === 'large-gap')
      x.page.lines
        .filter((l: { text: string }) => l.text.startsWith('PAC+F:'))
        .forEach((l: { y: number }) => (l.y += 50))
    expect(associateTableNotes(x.page, x.tables, x.rules)).toEqual([[]])
  }
)
