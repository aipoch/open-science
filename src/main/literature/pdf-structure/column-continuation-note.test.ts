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
      'src/main/literature/pdf-structure/fixtures/source-grids/centered-next-column-continuation-note.jsonl'
    )
  )

it('owns a centered continuation cue below records and above the native closing rule', () => {
  const x = fixture()
  const notes = associateTableNotes(x.page, x.tables, x.rules)
  expect(notes[0].map((n: { text: string }) => n.text)).toEqual(['(continued in next column)'])
  expect(notes[1]).toEqual([])
})

it.each(['missing-next-column', 'unruled', 'off-center', 'inside-data', 'ambiguous-owner'])(
  'keeps a continuation cue unassigned with %s',
  (variant) => {
    const x = fixture()
    if (variant === 'missing-next-column') x.tables.pop()
    if (variant === 'unruled') x.rules = []
    if (variant === 'off-center') x.page.lines[0].x += 25
    if (variant === 'inside-data') x.tables[0].rect[3] = x.page.lines[0].y + 5
    if (variant === 'ambiguous-owner') x.tables.push(structuredClone(x.tables[0]))
    expect(associateTableNotes(x.page, x.tables, x.rules).flat()).toEqual([])
  }
)
