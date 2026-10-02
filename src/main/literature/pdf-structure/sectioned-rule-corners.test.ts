import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
it('separates aligned category records inside section faces with small painted corner gaps', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/sectioned-records-with-gapped-rule-corners.jsonl'
    )
  )
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid.find((v: string[]) => v[0] === 'Well differentiated')).toEqual([
    'Well differentiated',
    '651 (20.8)',
    '638 (20.5)',
    '663 (21.2)'
  ])
  expect(r.grid.find((v: string[]) => v[0] === 'Cannot be assessed')).toEqual([
    'Cannot be assessed',
    '267 (8.5)',
    '260 (8.3)',
    '264 (8.4)'
  ])
  expect(r.unassigned).toEqual([])
})
it('keeps mean/deviation records in separate cohort columns beneath unindented statistic labels', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/semicolon-summaries-beside-unindented-section-stubs.jsonl'
    )
  )
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid.find((v: string[]) => v[0] === 'Mean; SD')).toEqual([
    'Mean; SD',
    '27.0; 5.0',
    '26.9; 5.1',
    '27.1; 4.9'
  ])
  expect(r.grid.some((v: string[]) => v[0] === 'Clinical tumour stage, N (%)')).toBe(true)
  expect(r.unassigned).toEqual([])
})
const { joinHorizontalTableRules } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-rules.mjs')).href
)
const { recoverRuledRecordFaces } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-record-faces.mjs')).href
)
it('preserves a populated narrow rule face instead of collapsing it as a closing double stroke', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/semicolon-summaries-beside-unindented-section-stubs.jsonl'
    )
  )
  f.tokens.push({
    text: 'Unit',
    rect: [65, 238.1, 85, 238.25],
    baseline: 238.25,
    height: 0.15,
    horizontal: true
  })
  expect(recoverRuledRecordFaces(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})
it('bridges small horizontal corner gaps only when an intersecting vertical stroke exists', () => {
  const horizontal = [
    [0, 10, 100, 10],
    [101.2, 10, 200, 10]
  ]
  expect(joinHorizontalTableRules(horizontal, 1, 2)).toHaveLength(2)
  expect(joinHorizontalTableRules([...horizontal, [100.6, 0, 100.6, 20]], 1, 2)).toEqual([
    [0, 10, 200, 10]
  ])
  expect(joinHorizontalTableRules([...horizontal, [100.6, 12.1, 100.6, 20]], 1, 2)).toHaveLength(2)
})
