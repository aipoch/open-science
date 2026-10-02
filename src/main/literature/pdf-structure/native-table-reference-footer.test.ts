import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
type SourceLine = {
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
}
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const line = (text: string, y: number, x = 60, width = 420, fontSize = 10): SourceLine => ({
  text,
  y,
  x,
  width,
  height: fontSize,
  fontSize
})
const page = {
  pageNumber: 1,
  width: 600,
  height: 800,
  lines: [
    line('Entry Value Reference', 100),
    line('EntryA 37 1', 120),
    line('EntryB 41 2', 135),
    line('EntryC 43 3', 150),
    line('References. (1) Entry Alpha; (2) Entry Beta;', 170, 35, 510, 9),
    line('(3) Entry Gamma.', 180, 35, 160, 9),
    line('Separate body begins after the source footer.', 208, 50, 420, 11)
  ]
}
const tables = [{ rect: [60, 95, 480, 163] }],
  rules = [[60, 162, 480, 162]]
it('retains cited table reference lists beneath a unique native closing', () => {
  expect(associateTableNotes(page, tables, rules)[0]).toEqual([
    {
      text: 'References. (1) Entry Alpha; (2) Entry Beta; (3) Entry Gamma.',
      rect: [35, 170, 545, 189]
    }
  ])
})
it('declines uncited bibliography, missing or competing closings, and intervening prose', () => {
  const withoutHeader = {
    ...page,
    lines: page.lines.map((l) => ({ ...l, text: l.text.replace('Reference', 'Category') }))
  }
  expect(associateTableNotes(withoutHeader, tables, rules)[0]).toEqual([])
  expect(associateTableNotes(page, tables, [])[0]).toEqual([])
  expect(associateTableNotes(page, tables, [...rules, [60, 164, 480, 164]])[0]).toEqual([])
  expect(
    associateTableNotes(
      { ...page, lines: [...page.lines, line('Foreign prose intervenes.', 164, 60, 400, 9)] },
      tables,
      rules
    )[0]
  ).toEqual([])
})
