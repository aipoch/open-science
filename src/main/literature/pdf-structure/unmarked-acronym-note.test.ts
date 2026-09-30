import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/unmarked-acronym-with-comma-separated-expansion.jsonl'
    )
  )
it('keeps an unmarked comma-separated acronym expansion below the native closing rule', () => {
  const f = fixture()
  const notes = associateTableNotes(f.page, f.tables, f.rules)[0]
  expect(notes.map((n: { text: string }) => n.text)).toContain('ABC Alpha, beta, category')
  expect(notes).toHaveLength(3)
})
it.each(['missing rule', 'uncited acronym', 'mismatched initials', 'distant note', 'inside table'])(
  'does not adopt a comma-separated expansion with %s',
  (kind) => {
    const f = fixture()
    const note = f.page.lines.find((l: { text: string }) => l.text === 'ABC Alpha, beta, category')
    if (kind === 'missing rule') f.rules = []
    if (kind === 'uncited acronym')
      f.page.lines = f.page.lines.filter(
        (l: { text: string }) => !l.text.startsWith('ABC classification')
      )
    if (kind === 'mismatched initials') note.text = 'ABC Alpha, delta, category'
    if (kind === 'distant note') note.y += 50
    if (kind === 'inside table') note.y = f.tables[0].rect[3] - 12
    expect(
      associateTableNotes(f.page, f.tables, f.rules)[0].some((n: { text: string }) =>
        n.text.startsWith('ABC ')
      )
    ).toBe(false)
  }
)
it.each(['ABC Alpha,  , category', 'ABC Alpha, -, category'])(
  'ignores malformed expansion %s without throwing',
  (text) => {
    const f = fixture()
    f.page.lines.find((l: { text: string }) => l.text.startsWith('ABC Alpha,')).text = text
    expect(
      associateTableNotes(f.page, f.tables, f.rules)[0].some((n: { text: string }) =>
        n.text.startsWith('ABC ')
      )
    ).toBe(false)
  }
)
