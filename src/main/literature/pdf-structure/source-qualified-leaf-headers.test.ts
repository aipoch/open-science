import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { populateTableCellText } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-text.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`))
const fill = (x: ReturnType<typeof JSON.parse>): void => {
  for (const cell of x.cells) cell.items = []
  populateTableCellText({
    ...x,
    items: x.tokens,
    pageItems: x.tokens,
    issues: new Set(),
    repairs: []
  })
}

it('owns the equals sign and closing sample value with each complete source heading', () => {
  const x = fixture('split-sample-header-over-independent-data-columns')
  fill(x)
  expect(
    x.cells.filter((c: { row: number }) => c.row === 0).map((c: { text: string }) => c.text)
  ).toEqual(['Variable', 'Comparison arm (n=44)', 'Reference arm (n=44)', 'p-value'])
  expect(
    x.cells.filter((c: { row: number }) => c.row === 1).map((c: { text: string }) => c.text)
  ).toEqual(['Measure, mean±SD', '45.25±10.32', '42.67±12.34', '0.3406'])
})

it('uses repeated sample headings and their native closing rule when the model omits the header', () => {
  const x = fixture('split-sample-header-over-independent-data-columns')
  x.headerRows = []
  x.rules = [[85, 552, 808, 552]]
  fill(x)
  expect(
    x.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 1).text
  ).toBe('Comparison arm (n=44)')
})

it('keeps unmarked body labels when no native header rule witnesses their ownership', () => {
  const x = fixture('split-sample-header-over-independent-data-columns')
  x.headerRows = []
  x.rules = []
  fill(x)
  expect(
    x.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 1).text
  ).toBe('Comparison arm (n')
})

it.each(['vertical-divider', 'distant-suffix', 'missing-parenthesis'])(
  'declines sample ownership with %s evidence',
  (variant) => {
    const x = fixture('split-sample-header-over-independent-data-columns')
    if (variant === 'vertical-divider') x.rules.push([501, 525, 501, 545])
    if (variant === 'distant-suffix') {
      const token = x.tokens.find((i: { text: string }) => i.text === '=')
      token.rect[0] += 10
      token.rect[2] += 10
    }
    if (variant === 'missing-parenthesis')
      x.tokens.find((i: { text: string }) => i.text === 'Comparison arm (n').text =
        'Comparison arm n'
    fill(x)
    expect(
      x.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 1).text
    ).not.toBe('Comparison arm (n=44)')
  }
)

it('keeps an opening sample parenthesis out of the preceding independent P heading', () => {
  const x = fixture('sample-opening-parenthesis-after-statistic-heading')
  fill(x)
  expect(x.cells.find((c: { column: number }) => c.column === 4).text).toBe('P Value')
  expect(x.cells.find((c: { column: number }) => c.column === 5).text).toBe('Total (n = 33417)')
})
