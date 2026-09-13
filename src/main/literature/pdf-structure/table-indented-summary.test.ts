import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = readPdfFixture(
  resolve('src/main/literature/pdf-structure/fixtures/source-grids/indented-summary-sections.jsonl')
)

it('separates indented summary records and their section titles without rewriting source statistics', () => {
  const x = structuredClone(fixture)
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid.slice(3, 12)).toEqual([
    ['Age of patients (y)', ''],
    ['Median ± SD', '54.9 ± 10.2'],
    ['Range', '32–73'],
    ['Tumor size (mm)', ''],
    ['Median ± SD', '25.1 ± 19.8'],
    ['Range', '4–80'],
    ['Tumor type (n)', ''],
    ['Invasive ductal carcinoma', '23'],
    ['Invasive lobular carcinoma', '2']
  ])
  expect(t.unassigned).toEqual([])
  expect(x).toEqual(fixture)
})

it.each(['no-indent', 'missing-value', 'lowercase-title'])(
  'retains ambiguous summary ownership with %s',
  (condition) => {
    const x = structuredClone(fixture)
    if (condition === 'no-indent')
      for (const i of x.tokens) {
        if (i.rect[0] < 300 && i.baseline > 165 && i.baseline < 194) {
          i.rect[0] -= 12
          i.rect[2] -= 12
        }
      }
    if (condition === 'missing-value')
      x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '54.9')
    if (condition === 'lowercase-title')
      x.tokens.find((i: { text: string }) => i.text === 'Age of patients (y)').text =
        'age of patients (y)'
    const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(t.grid).not.toContainEqual(['Range', '32–73'])
  }
)
