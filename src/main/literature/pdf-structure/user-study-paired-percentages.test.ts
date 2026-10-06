import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/user-study-paired-percentages.jsonl'
    )
  )

it('recovers paired User Study percentages from an anonymized wide table', () => {
  const f = fixture()
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  const byMethod = new Map(result.grid.map((row: string[]) => [row[0], row.slice(-2)]))
  expect(byMethod.get('Method Beta')).toEqual(['61.4%', '43.9%'])
  expect(byMethod.get('Method Gamma')).toEqual(['14.1%', '27.0%'])
  expect(byMethod.get('Method Delta')).toEqual(['57.7%', '61.7%'])
  expect(byMethod.get('Method Epsilon')).toEqual(['42.2%', '35.6%'])
  expect(byMethod.get('Method Zeta')).toEqual(['49.2%', '52.1%'])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('user-study-paired-percentages-recovered')
})

it('does not infer paired percentages without both User Study leaf headers', () => {
  const f = fixture()
  f.tokens = f.tokens.filter((token: { text: string }) => !token.text.includes('≡'))
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.repairs).not.toContain('user-study-paired-percentages-recovered')
})
