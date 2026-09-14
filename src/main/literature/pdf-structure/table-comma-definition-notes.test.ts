import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/comma-definition-notes.jsonl')
  )
it('assigns wrapped comma-separated definition lists to their own tables', () => {
  const x = load(),
    notes = associateTableNotes(x.page, x.tables, x.rules)
  expect(notes.map((n: unknown[]) => n.length)).toEqual([1, 1])
  expect(notes[0][0].text).toContain(
    'SD: standard deviation, Diff: the difference between the two groups.'
  )
  expect(notes[0][0].text).toContain('Boldface indicates statistically significant result.')
  expect(notes[1][0].text).toContain('C: control group, AFT: AFT group')
  expect(notes[1][0].text).toContain('Change: Q-scores’ interpretation of change.')
  expect(notes[0][0].text).not.toContain('The change for baseline')
})
it.each(['single-acronym', 'prose-headings', 'inside-table', 'distant-paragraph'])(
  'does not turn ordinary prose into a table definition list: %s',
  (kind) => {
    const x = load()
    if (kind === 'single-acronym' || kind === 'prose-headings') {
      const lines = x.page.lines.filter((l: { text: string }) => /^(SD:|Diff:)/.test(l.text))
      for (const l of lines)
        l.text =
          kind === 'single-acronym'
            ? 'SD: standard deviation, Change: a new result.'
            : 'Background: prior findings, Methods: study design, Results: complete follow-up.'
    }
    if (kind === 'inside-table') x.tables.forEach((t: { rect: number[] }) => (t.rect[3] += 20))
    if (kind === 'distant-paragraph') x.tables.forEach((t: { rect: number[] }) => (t.rect[3] -= 80))
    expect(associateTableNotes(x.page, x.tables, x.rules)).toEqual([[], []])
  }
)

it('keeps definition text out of data cells and clears the clipped-note warning', async () => {
  const { refineTable } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
  )
  const x = load(),
    notes = associateTableNotes(x.page, x.tables, x.rules)
  for (const [index, name] of ['ruled-time-series', 'ruled-time-comparisons'].entries()) {
    const input = readPdfFixture(
      resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`)
    )
    const before = refineTable(input.table, input.tokens, input.captions, [], input.rules)
    const after = refineTable(
      input.table,
      input.tokens,
      input.captions,
      notes[index].map((n: { rect: number[] }) => ({ ...n, rect: n.rect.map((v) => v * 1.5) })),
      input.rules
    )
    expect(after.grid).toEqual(before.grid)
    expect(after.clipped).toEqual([])
    expect(after.unassigned).toEqual([])
  }
})

it('keeps a complete acronym glossary separate from the preceding symbol footnote', () => {
  const x = load()
  const glossary = x.page.lines.find((line: { text: string }) => line.text.startsWith('SD:'))
  x.page.lines = [
    { ...glossary, text: '†† ALT.' },
    { ...glossary, y: glossary.y + 10 }
  ]
  x.tables = x.tables.slice(0, 1)
  const notes = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(notes.map((note: { text: string }) => note.text)).toEqual(['†† ALT.', glossary.text])
})
