import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { splitPdfNumericRuns } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/paired-mean-deviation-and-p-value-run.jsonl'
    )
  )
it('uses native gutters to separate paired mean/deviation entries and a final P value', () => {
  const x = fixture()
  const parts = splitPdfNumericRuns(x.content, x.operators).items
  expect(parts.map((i: { str: string }) => i.str)).toEqual([
    '53.80 ± 9.16',
    '52.39 ± 7.95',
    '0.742'
  ])
  expect(parts[1].transform[4]).toBeGreaterThan(parts[0].transform[4] + parts[0].width)
  expect(parts[2].transform[4]).toBeGreaterThan(parts[1].transform[4] + parts[1].width)
})
it.each(['width', 'gutter'])('retains the run without sufficient %s evidence', (kind) => {
  const x = fixture()
  if (kind === 'width') x.content.items[0].width += 10
  else {
    const run = x.operators.argsArray[1][0]
    run[run.indexOf(-540.5)] = -200
    x.content.items[0].width -= (340.5 * x.content.items[0].height) / 1000
  }
  expect(splitPdfNumericRuns(x.content, x.operators).items).toEqual(x.content.items)
})
