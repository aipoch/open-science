import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const { recoverNativeNumberedDefinitionFooter } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-note-blocks.mjs')).href
)
type NativeLine = {
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
}
const line = (text: string, x: number, y: number, width: number, fontSize = 8): NativeLine => ({
  text,
  x,
  y,
  width,
  fontSize,
  height: fontSize
})
const table = { rect: [40, 100, 500, 250] }
const page = (
  lines: NativeLine[]
): { pageNumber: number; width: number; height: number; lines: NativeLine[] } => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  lines
})

it('keeps an explicit glossary preamble with qualified wording and its definitions', () => {
  const p = page([
    line(
      'Abbreviations and measured ranges for the complete panel: Coord.—coordinate; Orient.—orientation;',
      60,
      258,
      400
    ),
    line(
      'AA—first measured channel; BB—second measured channel; CC—third measured channel.',
      60,
      268,
      400
    )
  ])
  expect(
    associateTableNotes(p, [table])[0]
      .map((n) => n.text)
      .join(' ')
  ).toContain(p.lines[0].text)
})

it('keeps source-cited dotted definitions crossing a padded crop at the native closing rule', () => {
  const p = page([
    line('Source. Measure. Orient.', 50, 120, 400, 9),
    line('Source. = Source data; Measure. = Measurement; Orient. = Orientation.', 50, 248, 390)
  ])
  const notes = associateTableNotes(p, [table], [[40, 246, 500, 246]])[0]
  expect(notes.map((n) => n.text)).toEqual([p.lines[1].text])
  const foreign = structuredClone(p)
  foreign.lines[0].text = 'Different unrelated table headers'
  expect(associateTableNotes(foreign, [table], [[40, 246, 500, 246]])[0]).toEqual([])
})

it('keeps consecutive inline numbered definitions when the next marker starts on the prior last line', () => {
  const input = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/inline-consecutive-numbered-definitions.jsonl'
    )
  )
  const p = input.page
  const notes = associateTableNotes(p, input.tables, input.rules)[0]
  expect(notes).toHaveLength(3)
  expect(notes[0].text).toContain('with the complete original expansion.')
  expect(notes[1].text).toContain(
    'pation Level: Full—complete participation; Partial—limited participation.'
  )
  expect(notes[2].text).toContain('Type: Spec—spectra; Phot—photometry.')
  expect(notes.map((n) => n.text).join(' ')).not.toContain('separate body')
  const ambiguous = structuredClone(p)
  ambiguous.lines.push({ ...ambiguous.lines[4] })
  expect(recoverNativeNumberedDefinitionFooter(ambiguous, [table])[0]).toBeUndefined()
})

it('does not turn a body-sentence fraction numerator into a numbered footnote', () => {
  const p = page([
    line('A body sentence discusses the arc u =', 50, 275, 181, 10.9),
    line('√', 236, 267, 7, 8),
    line('3', 243, 273.6, 4.2, 8),
    line('2', 239.5, 281.8, 4.2, 8),
    line('m and u =', 248.4, 275, 51, 10.9)
  ])
  const rules = [[236, 283.2, 247.3, 283.2]]
  expect(associateTableNotes(p, [table], rules)[0]).toEqual([])
})
