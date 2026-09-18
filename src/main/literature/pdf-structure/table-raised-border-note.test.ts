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
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/raised-border-note.jsonl')
  )
it('associates a raised note whose font box touches the native bottom border', () => {
  const x = load(),
    notes = associateTableNotes(x.page, x.tables, x.rules)
  expect(notes[0]).toHaveLength(1)
  expect(notes[0][0].text).toContain('Included volunteer or non-paid work')
  expect(notes[0][0].text).toContain('reported comorbidities')
})
it.each(['no-border', 'inside-data', 'normal-marker'])(
  'preserves table ownership without proved raised border contact: %s',
  (kind) => {
    const x = load()
    if (kind === 'no-border') x.rules = []
    if (kind === 'inside-data') x.tables[0].rect[3] += 10
    if (kind === 'normal-marker')
      x.page.lines
        .filter((l: { text: string }) => l.text === '1')
        .forEach((l: { fontSize: number }) => {
          l.fontSize = 10.98
        })
    expect(associateTableNotes(x.page, x.tables, x.rules)).toEqual([[]])
  }
)

it('excludes the associated border note from unassigned text without changing source records', () => {
  const x = load()
  const input = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/segmented-demographics-continuation.jsonl'
    )
  )
  const notes = associateTableNotes(x.page, x.tables, x.rules)[0].map((n: { rect: number[] }) => ({
    ...n,
    rect: n.rect.map((v) => v * 1.5)
  }))
  const before = refineTable(input.table, input.tokens, input.captions, [], input.rules)
  const after = refineTable(input.table, input.tokens, input.captions, notes, input.rules)
  expect(after.grid).toEqual(before.grid)
  expect(after.unassigned).toEqual([])
})
