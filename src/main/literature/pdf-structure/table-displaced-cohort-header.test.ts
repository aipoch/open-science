import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = readPdfFixture(
  resolve('src/main/literature/pdf-structure/fixtures/source-grids/displaced-cohort-header.jsonl')
)
it('restores a ruled wrapped cohort header and the following age record', () => {
  const x = structuredClone(fixture)
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.grid[0]).toEqual([
    'Characteristics',
    'Participants in the normal control group (n=48)',
    'Patients with breast cancer (n=124)',
    'Statistics',
    'P value'
  ])
  expect(result.grid).toContainEqual(['Age', '44.81±8.039', '49.85±9.363', 't=3.283', 'P=0.294'])
  expect(result.unassigned).toEqual([])
})

it.each(['missing-lower-rule', 'missing-model-header', 'occupied-band'])(
  'does not expand the header with %s',
  (condition) => {
    const x = structuredClone(fixture)
    if (condition === 'missing-lower-rule') {
      x.rules = x.rules.filter((rule: number[]) => rule[1] < 120 || rule[1] > 130)
    } else if (condition === 'missing-model-header') {
      x.table.structure.objects = x.table.structure.objects.filter(
        (object: { label: string }) => object.label !== 'table column header'
      )
    } else {
      x.tokens.push({
        text: '42',
        rect: [420, 119, 432, 131],
        baseline: 131,
        height: 12,
        horizontal: true
      })
    }
    const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(result.grid[0]).not.toContain('Participants in the normal control group (n=48)')
  }
)
