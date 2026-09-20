import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/outdented-marked-note.jsonl')
  )

it('continues an accepted marked note at its own left edge outside an inset table crop', () => {
  const x = load(),
    notes = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toContain('different number of survivors and nonsurvivors')
  expect(notes[0].text).toContain('alive 5 years after treatment start')
  expect(notes[0].text).toMatch(/PgR: progesterone receptor\.$/)
  expect(notes[0].text).not.toContain('Prognostic Measures')
  expect(x).toEqual(load())
})
it.each(['further-left', 'different-font', 'new-caption'])(
  'stops at a continuation with %s',
  (condition) => {
    const x = load()
    const line = x.page.lines.find((l: { text: string }) => l.text.startsWith('different number'))
    if (condition === 'further-left') line.x -= 15
    if (condition === 'different-font') line.fontSize += 2
    if (condition === 'new-caption') line.text = 'Figure 2. Independent figure caption.'
    const notes = associateTableNotes(x.page, x.tables, x.rules)[0]
    expect(notes[0].text).toMatch(/giving a slightly$/)
  }
)
