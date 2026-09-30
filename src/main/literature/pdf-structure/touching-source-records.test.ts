import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledComparisonRecords } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/double-rule-header-with-touching-record-boxes.jsonl'
    )
  )

it('recovers an outdented section despite almost touching source line boxes', () => {
  const x = fixture().cases[0],
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toContainEqual(['Subject’s personal history', '', '', '', ''])
  expect(t.grid).toContainEqual([
    'Any male relative w/ breast cancer',
    '3 (4.9 %)',
    '2 (3.3 %)',
    '5 (4.1 %)',
    '1.0'
  ])
  expect(t.unassigned).toEqual([])
})
it('separates complete records and sections under a decorative double header rule', () => {
  const x = fixture().cases[1],
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toContainEqual(['Screening and treatment', '', '', '', ''])
  expect(t.grid).toContainEqual(['Emotional issues', '', '', '', ''])
  expect(t.grid).toContainEqual([
    'Positive result means family members may need additional breast cancer screening',
    '12 (19.7 %)',
    '9 (15.0 %)',
    '21 (17.4 %)',
    '0.63'
  ])
  expect(t.grid).toContainEqual([
    'Positive result means family members may need treatment (including surgery and prophylaxis with medications)',
    '7 (11.5 %)',
    '3 (5.0 %)',
    '10 (8.3 %)',
    '0.32'
  ])
})
it('retains conservative fallback for substantive source-line overlap', () => {
  const x = fixture().cases[1],
    token = x.tokens.find((i: { text: string }) => i.text === 'Genetic testing')
  token.rect[1] -= token.height * 0.2
  expect(recoverRuledComparisonRecords(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})
it('does not discard a header tier containing a source label', () => {
  const x = fixture().cases[1],
    border = x.rules
      .filter((r: number[]) => r[1] === r[3] && r[1] > x.table.cropRect[1] && r[2] - r[0] > 700)
      .sort((a: number[], b: number[]) => a[1] - b[1])[0]
  const baseline = border[1] + 3
  x.tokens.push({
    text: 'A',
    horizontal: true,
    height: 2,
    baseline,
    rect: [border[0] + 30, baseline - 2, border[0] + 32, baseline]
  })
  expect(recoverRuledComparisonRecords(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})
