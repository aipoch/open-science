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
const line = (text: string, y: number): SourceLine => ({
  text,
  x: 50,
  y,
  width: 220,
  height: 9,
  fontSize: 9
})

it('retains explicit dash labels and parenthesized definition openings', () => {
  for (const text of [
    'Note—Native values retain the source wording.',
    'Notes. (a) Native labels retain the source wording.'
  ]) {
    const page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      lines: [
        line('Heading First Second', 100),
        line('Record 13 17', 120),
        line(text, 151),
        line('The remaining phrase completes this explanation.', 162)
      ]
    }
    const result = associateTableNotes(page, [{ rect: [50, 95, 270, 142] }], [[50, 145, 270, 145]])
    expect(result[0]).toHaveLength(1)
    expect(result[0][0].text).toBe(text + ' The remaining phrase completes this explanation.')
    expect(result[0][0].rect).toEqual([50, 151, 270, 171])
  }
})

it('does not classify ordinary note words or attach a caption as a tail', () => {
  const table = [{ rect: [50, 95, 270, 142] }]
  const rules = [[50, 145, 270, 145]]
  for (const text of ['Noteworthy native wording.', 'Notes concerning an unrelated section.'])
    expect(
      associateTableNotes(
        { pageNumber: 1, width: 600, height: 800, lines: [line(text, 151)] },
        table,
        rules
      )[0]
    ).toEqual([])
  const text = 'Note—Native values retain the source wording.'
  expect(
    associateTableNotes(
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        lines: [line(text, 151), line('Figure 9. Separate description.', 162)]
      },
      table,
      rules
    )[0][0].text
  ).toBe(text)
})

it('preserves a cited full-size raised letter definition only beneath its native closing', () => {
  const lines = [
    line('Heading with source marker', 100),
    { ...line('a', 96), x: 275, width: 4 },
    line('Record 13 17', 120),
    { ...line('a', 149), width: 4 },
    { ...line('Native definition retains the literal source.', 153), x: 55, width: 215 }
  ]
  const page = { pageNumber: 1, width: 600, height: 800, lines }
  const tables = [{ rect: [50, 90, 290, 140] }]
  const rules = [[50, 145, 290, 145]]
  expect(associateTableNotes(page, tables, rules)[0][0]?.text).toBe(
    'a Native definition retains the literal source.'
  )
  expect(associateTableNotes(page, tables, [])[0]).toEqual([])
  expect(
    associateTableNotes({ ...page, lines: lines.filter((l) => l.y !== 96) }, tables, rules)[0]
  ).toEqual([])
})
