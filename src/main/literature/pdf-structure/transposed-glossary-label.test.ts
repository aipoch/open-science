import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/transposed-glossary-label-with-wrapped-definitions.jsonl'
    )
  )

it('recognizes a transposed glossary label without silently correcting the original spelling', () => {
  const f = fixture()
  const notes = associateTableNotes(f.page, f.tables, f.rules)[0]
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toMatch(/^Abbreviaitons: ABC, first measurement; DEF, second measure-ment;/)
  expect(notes[0].text).toContain('T-X, sequential measures.')
})

it('requires multiple explicit acronym definitions behind a malformed label', () => {
  const f = fixture()
  f.page.lines[0].text = 'Abbreviaitons: this paragraph discusses the reported results.'
  expect(associateTableNotes(f.page, f.tables, f.rules)[0]).toEqual([])
})
