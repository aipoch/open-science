import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = readPdfFixture(
  resolve('src/main/literature/pdf-structure/fixtures/source-grids/single-row-continuation.jsonl')
)
it('reconstructs a single ruled continuation record from independent header anchors', () => {
  const x = structuredClone(fixture),
    r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid).toEqual([
    [
      'Characteristics',
      'Total (n=124)',
      'Intervention group (n=62)',
      'Control group (n=62)',
      'Statistics',
      'P value'
    ],
    ['+', '60', '35', '29', '', '']
  ])
  expect(r.unassigned).toEqual([])
})
it.each(['missing-caption', 'missing-border', 'unaligned-value', 'extra-line'])(
  'rejects ambiguous single-row continuations with %s',
  (condition) => {
    const x = structuredClone(fixture)
    if (condition === 'missing-caption') x.captions = []
    if (condition === 'missing-border')
      x.rules = x.rules.filter((r: number[]) => Math.abs(r[1] - 151.771) > 1)
    if (condition === 'unaligned-value')
      for (const t of x.tokens) if (t.text === '35') t.rect = [320, t.rect[1], 370, t.rect[3]]
    if (condition === 'extra-line')
      x.tokens.push({
        text: 'Another record',
        rect: [80, 144, 170, 150],
        height: 6,
        baseline: 150,
        horizontal: true
      })
    expect(refineTable(x.table, x.tokens, x.captions, [], x.rules).grid).not.toContainEqual([
      '+',
      '60',
      '35',
      '29',
      '',
      ''
    ])
  }
)
