import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = readPdfFixture(
  resolve('src/main/literature/pdf-structure/fixtures/source-grids/dense-wrapped-stubs.jsonl')
)

it('joins repeated dense label continuations while preserving counts and section P values', () => {
  const x = structuredClone(fixture)
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toContainEqual(['Self-reported race/ethnicity', '', '', '.91'])
  expect(t.grid).toContainEqual(['Some college or technical school', '30 (12.8)', '36 (16.1)', ''])
  expect(t.grid).toContainEqual([
    'Married or living with partner',
    '152 (64.7)',
    '137 (61.6)',
    '.44'
  ])
  expect(t.grid).toContainEqual(['Calculated breast cancer risk', '', '', '.45'])
  expect(t.grid).toContainEqual(['Measured breast density on mammogram', '', '', '.08'])
  expect(t.grid).toContainEqual(['Perceived risk of breast cancer', '', '', '.96'])
  expect(t.unassigned).toEqual([])
  expect(x).toEqual(fixture)
})

it.each(['rule', 'capitalized', 'different-font'])(
  'preserves an independent line with %s evidence',
  (condition) => {
    const x = structuredClone(fixture)
    const tail = x.tokens.find((t: { text: string }) => t.text === 'partner')
    if (condition === 'rule') x.rules.push([453, 800, 829, 800])
    if (condition === 'capitalized') tail.text = 'Partner'
    if (condition === 'different-font') tail.height *= 1.3
    const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(t.grid.some((r: string[]) => r[0] === 'Married or living with partner')).toBe(false)
  }
)

it('requires repeated wrapping evidence rather than joining an isolated lowercase line', () => {
  const x = structuredClone(fixture)
  for (const t of x.tokens) {
    if (['race/ethnicity', 'school', 'risk', 'on mammogram', 'cancer'].includes(t.text))
      t.text = t.text[0].toUpperCase() + t.text.slice(1)
  }
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.repairs).not.toContain('dense-stub-continuation-recovered')
  expect(t.grid).toContainEqual(['partner', '', '', ''])
})
