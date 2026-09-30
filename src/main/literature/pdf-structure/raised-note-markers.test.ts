import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
it.each([
  [
    'raised-double-star-statistical-notes',
    /\*\* P value for within-group comparison of parametric/
  ],
  ['parenthesized-letter-note-markers', /a\) According to/],
  [
    'raised-greek-statistical-note-marker',
    /δ P value for between-group comparison.*independent-sample t-test\./
  ],
  ['shown-as-mean-deviation-note', /Values are shown as mean/]
])('retains %s with its source table', (name, pattern) => {
  const x = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )
  const notes = associateTableNotes(x.page, x.tables, x.rules)
    .flat()
    .map((n: { text: string }) => n.text)
    .join('\n')
  expect(notes).toMatch(pattern)
})

it.each(['ordinary-baseline', 'detached-from-text'])(
  'does not claim an ordinary Greek variable as a raised note: %s',
  (variant) => {
    const x = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/source-grids/raised-greek-statistical-note-marker.jsonl'
      )
    )
    const marker = x.page.lines.find(
      (line: { text: string; y: number }) => line.text === 'δ' && line.y > x.tables[0].rect[3]
    )
    if (variant === 'detached-from-text') marker.x -= 20
    else {
      const body = x.page.lines.find(
        (line: { text: string; y: number }) => line.text.startsWith('P value') && line.y > marker.y
      )
      marker.y = body.y
      marker.height = body.height
      marker.fontSize = body.fontSize
    }
    const notes = associateTableNotes(x.page, x.tables, x.rules).flat()
    expect(notes.some((note: { text: string }) => note.text.startsWith('δ'))).toBe(false)
  }
)
