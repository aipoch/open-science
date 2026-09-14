import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { associateContinuedTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/continued-lettered-notes.jsonl'
    )
  )

it.each([false, true])(
  'attaches all cited native notes and preserves the source page (grouped: %s)',
  (grouped) => {
    const { table, page, nextPage } = load()
    if (grouped) {
      table.parts = [
        {
          title: 'A. First section',
          cells: table.cells.filter((_: object, index: number) => index % 2 === 0)
        },
        {
          title: 'B. Second section',
          cells: table.cells.filter((_: object, index: number) => index % 2 === 1)
        }
      ]
      delete table.cells
    }
    const original = structuredClone({ table, page, nextPage })
    const notes = associateContinuedTableNotes(table, page, nextPage)
    expect(notes.map((n: { text: string }) => n.text[0])).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h'
    ])
    expect(
      notes.every(
        (n: { page: number; rect: number[] }) => n.page === 5 && n.rect[1] > 60 && n.rect[3] < 146
      )
    ).toBe(true)
    expect(notes[4].text).toBe('e χ² Test.')
    expect(notes[6].text).toContain('Chromosome 17 centromere (CEP-17) ratio.')
    expect(notes[7].text).toContain('excluded from analysis.')
    expect({ table, page, nextPage }).toEqual(original)
  }
)

it.each([
  'missing',
  'nonadjacent',
  'different-title',
  'ambiguous-title',
  'uncited',
  'baseline-letter',
  'distant',
  'prose'
])('does not infer continuation ownership from %s evidence', (variant) => {
  const { table, page, nextPage } = load()
  if (variant === 'missing') return expect(associateContinuedTableNotes(table, page)).toEqual([])
  if (variant === 'nonadjacent') nextPage.pageNumber++
  if (variant === 'different-title') table.caption.text = 'Table 2'
  if (variant === 'ambiguous-title')
    nextPage.lines.push({
      text: 'Table 1 (cont)',
      x: 45.58,
      y: 40,
      width: 95,
      height: 9,
      fontSize: 9
    })
  if (variant === 'uncited')
    table.cells = table.cells.filter(
      (c: { textRuns?: { text: string }[] }) => !c.textRuns?.some((r) => r.text === 'g')
    )
  if (variant === 'baseline-letter')
    for (const c of table.cells) for (const r of c.textRuns ?? []) r.position = 'normal'
  if (variant === 'distant') for (const l of nextPage.lines) if (l.y > 61) l.y += 60
  if (variant === 'prose')
    nextPage.lines = nextPage.lines.map((l: { text: string }) => ({
      ...l,
      text: l.text.replace('(cont)', 'discusses the results.')
    }))
  expect(associateContinuedTableNotes(table, page, nextPage)).toEqual([])
})

it('rejects grouped continuation notes when a cited marker is absent from every part', () => {
  const { table, page, nextPage } = load()
  table.parts = [
    {
      title: 'A. First section',
      cells: table.cells.filter(
        (c: { textRuns?: { text: string }[] }) => !c.textRuns?.some((r) => r.text === 'g')
      )
    },
    { title: 'B. Empty section', cells: [] }
  ]
  delete table.cells
  expect(associateContinuedTableNotes(table, page, nextPage)).toEqual([])
})
