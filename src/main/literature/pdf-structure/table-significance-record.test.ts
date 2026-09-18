import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = readPdfFixture(
  resolve('src/main/literature/pdf-structure/fixtures/source-grids/significance-record.jsonl')
)
it('recovers a complete record with a source significance marker in the P column', () => {
  const x = structuredClone(fixture)
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.grid).toContainEqual([
    'Depression',
    '7.29±1.85',
    '8.08±1.91',
    '7.98±2.11',
    '8±2.3',
    '13.271',
    '***'
  ])
  expect(result.unassigned).toEqual([])
})
it.each(['missing-value', 'textual-marker', 'missing-p-heading'])(
  'preserves ambiguous records with %s',
  (condition) => {
    const x = structuredClone(fixture)
    if (condition === 'missing-value')
      x.tokens = x.tokens.filter(
        (t: { text: string; rect: number[] }) => !(t.text === '13.271' && t.rect[1] < 300)
      )
    if (condition === 'textual-marker')
      for (const token of x.tokens)
        if (token.text === '***' && token.rect[1] > 240 && token.rect[1] < 260)
          token.text = 'review'
    if (condition === 'missing-p-heading')
      for (const token of x.tokens) if (token.text === 'P') token.text = 'Comment'
    const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(result.unassigned).toContain('Depression')
  }
)
