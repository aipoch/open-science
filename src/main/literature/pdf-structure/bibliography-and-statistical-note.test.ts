import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-evidence.mjs')).href
)
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`))

it('rejects uncaptioned author-year reference columns without requiring clipped text', () => {
  const x = fixture('author-year-bibliography-columns')
  expect(hasTableEvidence(x.table, undefined, x.tokens)).toBe(false)
  expect(hasTableEvidence(x.table, { lines: ['Table 1. Study summaries.'] }, x.tokens)).toBe(true)
  x.table.grid.push(['24', '32'])
  expect(hasTableEvidence(x.table, undefined, x.tokens)).toBe(true)
})

it('retains a median/interquartile definition and its wrapped treatment glossary', () => {
  const x = fixture('median-interquartile-definition-note')
  const notes = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toMatch(/^Data are expressed as median \(interquartile range\)/)
  expect(notes[0].text).toContain('CC: participants receiving active treatment.')
})

it.each(['inside', 'distant', 'prose'])(
  'does not collect a statistical note with %s evidence',
  (kind) => {
    const x = fixture('median-interquartile-definition-note')
    if (kind === 'inside') x.tables[0].rect[3] += 30
    if (kind === 'distant') x.page.lines.forEach((l: { y: number }) => (l.y += 100))
    if (kind === 'prose')
      x.page.lines.find((l: { text: string }) => l.text.startsWith('Data')).text =
        'Data are expressed differently in the discussion of median changes.'
    expect(associateTableNotes(x.page, x.tables, x.rules)[0]).toEqual([])
  }
)

it.each([
  [0, 4, 'ELSI', '‡'],
  [1, 3, 'SoFAS,', 'a Means'],
  [2, 4, 'Cr,', '***Comparing'],
  [3, 3, '*Dose', 'Abbreviations:'],
  [4, 2, 'ECOG PS,', '⁎ Log rank.']
])('preserves all notes in the ruled or inset glossary block %s', (index, count, first, last) => {
  const x = fixture('ruled-and-inset-glossary-blocks').cases[index]
  const notes = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(notes).toHaveLength(count)
  expect(notes[0].text.startsWith(first)).toBe(true)
  expect(notes.at(-1).text.startsWith(last)).toBe(true)
})

it.each(['no rule', 'no following footnote', 'distant footnote'])(
  'does not attach an isolated unlabelled definition with %s',
  (variant) => {
    const x = fixture('ruled-and-inset-glossary-blocks').cases[1]
    if (variant === 'no rule') x.rules = []
    if (variant === 'no following footnote')
      x.page.lines = x.page.lines.filter((l: { text: string }) => !l.text.startsWith('*'))
    if (variant === 'distant footnote')
      x.page.lines.find((l: { text: string }) => l.text.startsWith('*')).y += 80
    expect(
      associateTableNotes(x.page, x.tables, x.rules)[0].some((n: { text: string }) =>
        n.text.startsWith('SoFAS')
      )
    ).toBe(false)
  }
)
