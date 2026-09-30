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
      'src/main/literature/pdf-structure/fixtures/source-grids/raised-letter-note-with-dash-separated-definition.jsonl'
    )
  )
it.each(['—', '–', '-'])(
  'associates a raised marker followed by %s and retains its wrapped definition',
  (dash) => {
    const x = fixture()
    x.page.lines[1].text = x.page.lines[1].text.replace('—', dash)
    const notes = associateTableNotes(x.page, x.tables, x.rules)[0]
    expect(notes).toHaveLength(1)
    expect(notes[0].text).toBe(
      `d ${dash}Comparison method; IQR-interquartile range, RMS-root mean square (RMS), KEY-multiline definition text.`
    )
    expect(notes[0].text).not.toContain('Findings')
  }
)
it.each(['ordinary-letter', 'distant', 'neighbor-table', 'missing-marker'])(
  'does not promote prose with %s into a lettered note',
  (variant) => {
    const x = fixture()
    if (variant === 'ordinary-letter') {
      x.page.lines[0].fontSize = x.page.lines[1].fontSize
      x.page.lines[0].height = x.page.lines[1].height
      x.page.lines[0].y = x.page.lines[1].y
    }
    if (variant === 'distant') for (const l of x.page.lines) l.y += 80
    if (variant === 'neighbor-table') x.tables.push({ rect: [160, 363, 565, 383] })
    if (variant === 'missing-marker') x.page.lines.shift()
    expect(associateTableNotes(x.page, x.tables, x.rules)[0]).toEqual([])
  }
)
