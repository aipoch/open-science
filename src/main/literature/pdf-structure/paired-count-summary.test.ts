import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
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
      'src/main/literature/pdf-structure/fixtures/source-grids/paired-counts-and-centered-summary-values.jsonl'
    )
  )

it('recovers the single stub, paired cohort summaries and every complete source record', () => {
  const x = fixture()
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.grid).toHaveLength(53)
  expect(result.grid.every((r: string[]) => r.length === 9 && r.some(Boolean))).toBe(true)
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.grid.filter((r: string[]) => r[0] === 'Median')).toEqual([
    ['Median', '52', '', '49', '', '51', '', '50', ''],
    ['Median', '40', '', '40', '', '40', '', '40', '']
  ])
  expect(result.grid.filter((r: string[]) => r[0] === 'Range')).toEqual([
    ['Range', '28-77', '', '22-75', '', '23-78', '', '23-77', ''],
    ['Range', '10-120', '', '10-120', '', '10-120', '', '10-120', '']
  ])
  expect(result.grid.find((r: string[]) => r[0] === 'Unknown')).toEqual([
    'Unknown',
    '1',
    '',
    '17',
    '',
    '16',
    '',
    '17',
    ''
  ])
  expect(result.grid.find((r: string[]) => r[0] === 'Category beta')?.slice(1)).toEqual([
    '7',
    '9.5',
    '43',
    '9.1',
    '52',
    '11.0',
    '66',
    '13.8'
  ])
  expect(result.cells.find((c: { text: string }) => c.text === 'Severity†')).toMatchObject({
    colSpan: 9
  })
  expect(
    result.cells.filter((c: { row: number; colSpan: number }) => c.row === 1 && c.colSpan === 2)
  ).toHaveLength(4)
  expect(
    result.cells
      .flatMap((c: { sourceTokens: { text: string }[] }) => c.sourceTokens.map((i) => i.text))
      .sort()
  ).toEqual(x.tokens.map((i: { text: string }) => i.text).sort())
})

it.each([
  'header-pair',
  'sample-size',
  'missing-rule',
  'missing-value',
  'duplicate',
  'summary-outside-pair'
])('refuses paired summary recovery with %s evidence', (variant) => {
  const x = fixture()
  const tokens = x.tokens as { text: string; rect: number[] }[]
  if (variant === 'header-pair') tokens.find((i) => i.text === '%')!.text = 'SD'
  if (variant === 'sample-size') tokens.find((i) => i.text === '74)')!.text = 'unknown)'
  if (variant === 'missing-rule') x.rules.splice(3, 1)
  if (variant === 'missing-value')
    tokens.splice(
      tokens.findIndex((i) => i.text === '13.6'),
      1
    )
  if (variant === 'duplicate') tokens.push(tokens.find((i) => i.text === '13.6')!)
  if (variant === 'summary-outside-pair') tokens.find((i) => i.text === '28-77')!.rect[2] += 95
  expect(recoverRuledComparisonRecords(x.table, tokens, x.captions, x.rules)).toBeUndefined()
})
