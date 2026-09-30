import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/comparison-prefix-straddling-a-narrow-column.jsonl'
    )
  )
it('keeps a verified comparison prefix with its closely adjacent numeric operand', () => {
  const x = fixture(),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  const rows = t.grid.filter((r: string[]) => r[0].startsWith('CBR'))
  expect(rows).toHaveLength(2)
  for (const r of rows) {
    expect(r.at(-1)).toBe('< .001')
    expect(r.at(-2)).not.toContain('<')
  }
})
it('respects an explicit native column border between the prefix and number', () => {
  const x = fixture(),
    operator = x.tokens.find((t: { text: string }) => t.text === '<')
  x.rules.push([
    operator.rect[2] + 1,
    operator.rect[1] - 1,
    operator.rect[2] + 1,
    operator.rect[3] + 1
  ])
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid.find((r: string[]) => r[0].startsWith('CBR'))?.at(-1)).toBe('.001')
})
