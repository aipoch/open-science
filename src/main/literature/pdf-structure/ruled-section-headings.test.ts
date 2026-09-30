import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/omitted-final-section-with-ruled-indented-records.jsonl'
    )
  )
const refine = (x: ReturnType<typeof fixture>): ReturnType<typeof refineTable> =>
  refineTable(x.table, x.tokens, x.captions, [], x.rules)

it('recovers an omitted final section from ruled peers without changing numeric records', () => {
  const x = fixture()
  const result = refine(x)
  expect(result.cells.find((c: { text: string }) => c.text === 'Circulatory events')).toMatchObject(
    {
      row: 17,
      column: 0,
      rowSpan: 1,
      colSpan: 5
    }
  )
  expect(result.cells.filter((c: { colSpan: number }) => c.colSpan === 5)).toHaveLength(6)
  expect(result.grid).toHaveLength(19)
  expect(result.grid[18]).toEqual(['Hot flush', '11', '0', '8', '0'])
  expect(result.unassigned).toEqual([])
  expect(
    result.cells
      .flatMap((c: { sourceTokens: { text: string }[] }) => c.sourceTokens.map((t) => t.text))
      .sort()
  ).toEqual(x.tokens.map((t: { text: string }) => t.text).sort())
})

it.each([
  'missing-border',
  'unindented-child',
  'incomplete-child',
  'occupied-values',
  'vertical-divider',
  'no-peer-spans'
])('does not infer a section with contradictory evidence: %s', (variant) => {
  const x = fixture()
  const tokens = x.tokens as { text: string; rect: number[] }[]
  if (variant === 'missing-border')
    x.rules = x.rules.filter((r: number[]) => r[1] < 438 || r[1] > 440)
  if (variant === 'unindented-child')
    for (const t of tokens.filter((t) => t.rect[1] > 440 && t.rect[2] < 200)) {
      t.rect[0] -= 11
      t.rect[2] -= 11
    }
  if (variant === 'incomplete-child')
    x.tokens = tokens.filter((t) => !(t.rect[1] > 440 && t.text === '8'))
  if (variant === 'occupied-values') {
    const value = structuredClone(tokens.find((t) => t.rect[1] > 440 && t.text === '8')!)
    value.rect[1] -= 19
    value.rect[3] -= 19
    x.tokens.push({ ...value, baseline: value.rect[3] })
  }
  if (variant === 'vertical-divider') x.rules.push([400, 420, 400, 441])
  if (variant === 'no-peer-spans')
    x.table.structure.objects = x.table.structure.objects.filter(
      (o: { label: string }) => o.label !== 'table projected row header'
    )
  expect(
    refine(x).cells.find((c: { text: string }) => c.text === 'Circulatory events').colSpan
  ).toBe(1)
})
