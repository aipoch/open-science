import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateContinuedTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/cited-symbol-notes-before-next-table.jsonl'
    )
  )
it('associates a raised, cited symbol sequence before the next table with the preceding page', () => {
  const f = fixture(),
    before = structuredClone(f)
  const notes = associateContinuedTableNotes(f.table, f.page, f.nextPage)
  expect(notes.map((n: { text: string }) => /^\*+/.exec(n.text)?.[0])).toEqual([
    '*',
    '**',
    '***',
    '****'
  ])
  expect(
    notes.every(
      (n: { page: number; rect: number[] }) => n.page === 3 && n.rect[1] > 95 && n.rect[3] < 160
    )
  ).toBe(true)
  expect(notes[2].text).toContain('https://example.org/definition.')
  expect(notes[3].text).toBe('**** https://example.org/definition.')
  expect(f).toEqual(before)
})
it.each([
  'missing citations',
  'ordinary markers',
  'broken sequence',
  'prior notes missing',
  'prior note uncited',
  'not at page end',
  'misaligned',
  'font mismatch',
  'extra preceding prose',
  'extra trailing prose',
  'prior trailing body',
  'nonadjacent page',
  'wrong next table',
  'missing next table',
  'already defined'
])('rejects ambiguous symbol continuation with %s', (kind) => {
  const f = fixture()
  if (kind === 'missing citations')
    f.table.cells = f.table.cells.filter(
      (c: { textRuns: { text: string }[] }) => c.textRuns[0].text !== '***'
    )
  if (kind === 'ordinary markers')
    for (const l of f.nextPage.lines)
      if (/^\*+$/.test(l.text)) {
        l.fontSize = 9.6879924
        l.height = 9.6879924
      }
  if (kind === 'broken sequence')
    f.nextPage.lines.find((l: { text: string }) => l.text === '***').text = '*****'
  if (kind === 'prior notes missing') f.table.notes = []
  if (kind === 'prior note uncited')
    f.table.cells = f.table.cells.filter(
      (c: { textRuns: { text: string }[] }) => c.textRuns[0].text !== '‡'
    )
  if (kind === 'not at page end') f.table.notes.at(-1).rect[3] = f.page.height * 0.7
  if (kind === 'misaligned') for (const l of f.nextPage.lines) l.x += 30
  if (kind === 'font mismatch')
    for (const l of f.nextPage.lines) if (l.fontSize > 9) l.fontSize = 11
  if (kind === 'extra preceding prose')
    f.nextPage.lines.push({
      text: 'Discussion starts here.',
      x: 58,
      y: 80,
      width: 150,
      height: 10,
      fontSize: 9.6879924
    })
  if (kind === 'extra trailing prose')
    f.nextPage.lines.push({
      text: 'A separate paragraph follows.',
      x: 58,
      y: 178,
      width: 180,
      height: 10,
      fontSize: 9.6879924
    })
  if (kind === 'prior trailing body')
    f.page.lines.push({
      text: 'Further results follow.',
      x: 58,
      y: 725,
      width: 180,
      height: 10,
      fontSize: 9.6879924
    })
  if (kind === 'nonadjacent page') f.nextPage.pageNumber++
  if (kind === 'wrong next table')
    f.nextPage.lines.find((l: { text: string }) => l.text.startsWith('Table 3')).text =
      'Table 5. Subsequent outcomes.'
  if (kind === 'missing next table')
    f.nextPage.lines = f.nextPage.lines.filter(
      (l: { text: string }) => !l.text.startsWith('Table 3')
    )
  if (kind === 'already defined')
    f.table.notes.unshift({ text: '* Previous definition.', rect: [58, 670, 250, 680] })
  expect(associateContinuedTableNotes(f.table, f.page, f.nextPage)).toEqual([])
})
it('reads citations from grouped table parts without changing their data', () => {
  const f = fixture(),
    cells = f.table.cells
  f.table.parts = [{ cells: cells.slice(0, 3) }, { cells: cells.slice(3) }]
  delete f.table.cells
  expect(associateContinuedTableNotes(f.table, f.page, f.nextPage)).toHaveLength(4)
})
