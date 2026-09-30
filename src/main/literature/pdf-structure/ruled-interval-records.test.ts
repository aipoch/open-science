import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
it.each([
  'paired-estimate-intervals-with-detached-minus',
  'repeated-adjustment-intervals-with-shared-labels'
])('owns every native interval and signed value in %s', (name) => {
  const f = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
  const original = structuredClone(f)
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.unassigned).toEqual([])
  expect(result.grid.some((r: string[]) => r.some((s) => s === '− − −'))).toBe(false)
  if (name.startsWith('paired')) {
    expect(result.grid.flat()).toContain('−0.021 [−0.036; −0.006]')
    expect(result.grid.flat()).toContain('0.000 [−0.011; 0.012]')
  } else {
    expect(
      result.cells
        .filter((c: { column: number; text: string }) => c.column === 0 && /^Measure/.test(c.text))
        .every((c: { rowSpan: number }) => c.rowSpan === 5)
    ).toBe(true)
  }
  expect(f).toEqual(original)
})
