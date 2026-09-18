import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/centered-count-sections.jsonl')
  )
const parse = (x: ReturnType<typeof load>): ReturnType<typeof refineTable> =>
  refineTable(x.table, x.tokens, x.captions, [], x.rules)
const headings = [
  'Age (years)',
  'Treatment',
  'RCB Class',
  'ER Status',
  'PgR Status',
  'Histology',
  'Metastasis during follow-up'
]

it('recovers repeated centered sections and keeps the summary label with its original values', () => {
  const x = load(),
    t = parse(x)
  const expected = structuredClone(x.previousGrid)
  expected[2] = ['Age (years)', '', '']
  expected[3][0] = 'mean (range)'
  for (const row of expected) if (headings.includes(row[1])) [row[0], row[1]] = [row[1], '']
  expect(t.grid).toEqual(expected)
  for (const text of headings)
    expect(t.cells).toContainEqual(
      expect.objectContaining({ text, column: 0, rowSpan: 1, colSpan: 3 })
    )
  // Note association runs after this seam; keep its native text available.
  expect(t.unassigned).toEqual([
    'Sample availability varied for each time point, giving a slightly'
  ])
  expect(x).toEqual(load())
})

it.each(['off-center', 'too-few-peers', 'missing-count'])(
  'keeps ambiguous section ownership with %s',
  (condition) => {
    const x = load()
    if (condition === 'off-center')
      for (const token of x.tokens)
        if (headings.includes(token.text)) {
          token.rect[0] += 30
          token.rect[2] += 30
        }
    if (condition === 'too-few-peers')
      x.tokens = x.tokens.filter((i: { text: string }) => !headings.slice(2).includes(i.text))
    if (condition === 'missing-count')
      x.tokens = x.tokens.filter(
        (i: { rect: number[] }) => !(i.rect[0] > 760 && i.rect[1] > 543 && i.rect[1] < 556)
      )
    const t = parse(x)
    expect(t.cells).not.toContainEqual(expect.objectContaining({ text: 'Age (years)', colSpan: 3 }))
  }
)
