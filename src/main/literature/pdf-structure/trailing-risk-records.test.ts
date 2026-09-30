import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRepeatedRegressionGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-regression-grid.mjs')).href
)
const cases = [
  ['trailing-risk-values-with-indented-reference-sections', 18, '1.62', '0.22-12.08'],
  ['wrapped-risk-comparisons-with-reference-categories', 18, '0.48', '0.28-0.81†']
] as const

it.each(cases)('retains every wrapped risk record and section in %s', (name, rows, risk, ci) => {
  const f = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
  const original = structuredClone(f)
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid).toHaveLength(rows)
  expect(result.unassigned).toEqual([])
  const record = result.grid.find((row: string[]) => row[1] === risk)
  expect(record?.[2]).toBe(ci)
  expect(record?.[0]).toMatch(
    name.startsWith('trailing') ? /Circular\/oval.*cations inside/ : /Postmenopausal.*pausal/
  )
  expect(result.grid.filter((row: string[]) => row.every((cell) => !cell))).toEqual([])
  expect(f).toEqual(original)
})

it.each(['missing-rule', 'incomplete-value', 'conflicting-interval'])(
  'does not force risk records with %s',
  (variant) => {
    const f = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/source-grids/trailing-risk-values-with-indented-reference-sections.jsonl'
      )
    )
    if (variant === 'missing-rule') f.rules = []
    else {
      const token = f.tokens.find((item: { text: string }) => item.text === '0.22-12.08')!
      if (variant === 'incomplete-value')
        f.tokens = f.tokens.filter((item: unknown) => item !== token)
      else token.text = 'not an interval'
    }
    expect(recoverRepeatedRegressionGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)
