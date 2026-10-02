import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeHeaderOwnershipGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-ownership.mjs')).href
)
const load = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/repeated-native-separated-numeric-parents.jsonl'
    )
  )
it('keeps repeated literal separators in their numerical leaves without phantom columns or fragmenting parent scopes', () => {
  const f = load(),
    result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid).toEqual([
    ['Item', 'BandA', '', 'BandB', ''],
    ['Amber', '21 |', '24', '27 |', '30'],
    ['Azure', '28 |', '31', '34 |', '37'],
    ['Coral', '35 |', '38', '41 |', '44']
  ])
  expect(
    result.cells.filter(
      (cell: { row: number; colSpan: number }) => cell.row === 0 && cell.colSpan === 2
    )
  ).toHaveLength(2)
  expect(result.unassigned).toHaveLength(0)
})
it.each([
  'missing separator',
  'unequal leaf count',
  'missing footer',
  'competing numeric baseline',
  'foreign edge ink',
  'miscentered parent'
])('declines unproved repeated numeric parent scopes: %s', (variant) => {
  const f = load()
  if (variant === 'missing separator')
    f.tokens.splice(
      f.tokens.findIndex((i: { text: string }) => i.text === '|'),
      1
    )
  if (variant === 'unequal leaf count')
    f.tokens.splice(
      f.tokens.findIndex((i: { text: string }) => i.text === '30'),
      1
    )
  if (variant === 'missing footer') f.rules.pop()
  if (variant === 'competing numeric baseline')
    f.tokens.push({
      text: '57',
      rect: [68, 68, 88, 78],
      baseline: 78,
      height: 10,
      horizontal: true,
      font: 'Fixture-Regular'
    })
  if (variant === 'foreign edge ink')
    f.tokens.push({
      text: 'Foreign',
      rect: [230, 72, 250, 82],
      baseline: 82,
      height: 10,
      horizontal: true,
      font: 'Fixture-Regular'
    })
  if (variant === 'miscentered parent') f.tokens[1].rect = [118, 24, 138, 34]
  expect(recoverNativeHeaderOwnershipGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})
