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
const line = (
  text: string,
  y: number,
  x = 50,
  width = 430,
  fontSize = 9,
  height = fontSize
): SourceLine => ({
  text,
  y,
  x,
  width,
  fontSize,
  height
})
const page = {
  pageNumber: 1,
  width: 600,
  height: 800,
  lines: [
    line('Entry A B MCSE', 100, 50, 430, 11),
    line('Record 13 17 19', 120, 50, 430, 11),
    line('Notes: Native source details are retained with original wording.', 160, 52.5),
    line('The introductory statement continues along the same source rhythm.', 171),
    line('Native short terminal sentence.', 182, 50, 160),
    line('For this block MCSE denotes the paired source quantity (', 193, 52.5, 240),
    line('ˆ', 190.75, 293, 4.5),
    line('A), and A remains literal.', 193, 292.5, 180),
    line('Its continuation retains the native calculation details.', 204),
    line('A and B are computed using the original procedure.', 215, 52.5),
    line('The ending phrase closes the definition.', 226, 50, 200),
    line('Separate body begins after the note paragraphs.', 250, 50, 430, 12)
  ]
}
const tables = [{ rect: [50, 95, 480, 143] }],
  rules = [[50, 145, 480, 145]]
it('keeps contiguous source-cited definition paragraphs inside an explicit note block', () => {
  const result = associateTableNotes(page, tables, rules)[0]
  expect(result[0].text).toContain('For this block MCSE denotes')
  expect(result[0].text).toContain('A and B are computed')
  expect(result[0].text).not.toContain('Separate body')
  expect(result[0].rect).toEqual([50, 160, 482.5, 235])
})
it('declines unreferenced methods, changed rhythm and foreign ownership', () => {
  const withoutCitation = {
    ...page,
    lines: page.lines.map((l) => ({
      ...l,
      text: l.text.replace('Entry A B MCSE', 'Entry C D Value')
    }))
  }
  expect(associateTableNotes(withoutCitation, tables, rules)[0][0].text).not.toContain(
    'For this block'
  )
  expect(
    associateTableNotes(
      { ...page, lines: page.lines.map((l) => (l.y === 204 ? { ...l, y: 207 } : l)) },
      tables,
      rules
    )[0][0].text
  ).not.toContain('For this block')
  expect(
    associateTableNotes(
      { ...page, lines: [...page.lines, line('Foreign', 210, 40, 30)] },
      tables,
      rules
    )[0][0].text
  ).not.toContain('For this block')
})
