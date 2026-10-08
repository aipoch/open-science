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
  expect(result.unassigned).toEqual(
    expect.arrayContaining(['Item (mean', '±', 'SD)', 'CG (n', '=', '62)'])
  )
  expect(result.issues).toContain('unassigned-source-text')
})
it('completes the existing source-owned record without duplicating its measurement tokens', () => {
  const x = structuredClone(fixture)
  const stub = x.tokens.find(
    (token: { text: string; rect: number[] }) => token.text === 'Depression' && token.rect[1] < 300
  )
  const recordTokens = x.tokens.filter(
    (token: { horizontal: boolean; baseline: number }) =>
      token.horizontal && Math.abs(token.baseline - stub.baseline) < 0.02
  )
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  const sourceRows = new Set<number>()
  for (const token of recordTokens) {
    const owners = result.cells.filter((cell: { row: number; sourceRects: number[][] }) =>
      cell.sourceRects.some((rect) => rect.every((value, index) => value === token.rect[index]))
    )
    expect(owners, token.text).toHaveLength(1)
    sourceRows.add(owners[0].row)
  }
  expect(sourceRows.size).toBe(1)
  expect(result.grid.filter((row: string[]) => row[0] === 'Depression')).toHaveLength(1)
})
it('retains an unrelated unassigned header with the same literal as an owned measurement', () => {
  const x = structuredClone(fixture)
  const header = x.tokens.find((token: { text: string }) => token.text === 'SD)')
  const unrelated = {
    ...header,
    text: '7.29',
    rect: [170, header.rect[1], 190, header.rect[3]]
  }
  x.tokens.push(unrelated)
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.unassigned).toContain(unrelated.text)
  expect(result.issues).toContain('unassigned-source-text')
})
it('retains the partial record when its existing row also owns unrelated source text', () => {
  const x = structuredClone(fixture)
  const measurement = x.tokens.find(
    (token: { text: string; rect: number[] }) => token.text === '7.29' && token.rect[1] < 300
  )
  x.tokens.push({
    ...measurement,
    text: 'EXTRA',
    rect: [302, 235, 315, 247.75],
    baseline: 247.75
  })
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.unassigned).toContain('Depression')
  expect(result.grid.flat().join(' ')).toContain('EXTRA')
  expect(result.repairs).not.toContain('source-significance-row-recovered')
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
