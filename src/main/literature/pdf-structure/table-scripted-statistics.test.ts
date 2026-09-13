import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = readPdfFixture(
  resolve(
    'src/main/literature/pdf-structure/fixtures/source-grids/scripted-section-statistics.jsonl'
  )
)

it('keeps a scripted statistic and P value in their source columns', () => {
  const x = structuredClone(fixture)
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.grid).toContainEqual(['Endocrine therapy', '', '', '', 'χ2=3.792', 'P=0.150'])
  const statistic = result.cells.find((cell: { text: string }) => cell.text === 'χ2=3.792')
  expect(statistic.column).toBe(4)
  expect(statistic.colSpan).toBe(1)
  expect(statistic.textRuns).toEqual([
    { text: 'χ', position: 'normal' },
    { text: '2', position: 'superscript' },
    { text: '=3.792', position: 'normal' }
  ])
  expect(result.unassigned).toEqual([])
  expect(result.grid).toContainEqual(['+', '103', '52', '51', '', ''])
  const section = result.grid.findIndex((row: string[]) => row[0] === 'PR')
  expect(section).toBeGreaterThan(0)
  expect(result.grid[section]).toEqual(['PR', '', '', '', '', ''])
  expect(result.grid[section + 1]).toEqual(['−', '58', '23', '29', 'χ2=1.192', 'P=0.275'])
  expect(x).toEqual(fixture)
})

it.each(['detached', 'same-size', 'cross-column'])(
  'does not treat a %s glyph as an attached script',
  (condition) => {
    const x = structuredClone(fixture)
    const token = x.tokens.find(
      (t: { text: string; rect: number[] }) => t.text === '2' && t.rect[1] > 827 && t.rect[1] < 829
    )
    if (condition === 'detached') {
      token.rect[0] += 7
      token.rect[2] += 7
    }
    if (condition === 'same-size') token.height = 12.75
    if (condition === 'cross-column') {
      token.rect[0] = 755
      token.rect[2] = 759
    }
    const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(result.grid).not.toContainEqual(['Endocrine therapy', '', '', '', 'χ2=3.792', 'P=0.150'])
  }
)

it.each(['wrapped-label', 'incomplete-counts', 'lowercase-heading', 'detached-intervening-glyph'])(
  'preserves an ambiguous section boundary with %s',
  (condition) => {
    const x = structuredClone(fixture)
    if (condition === 'wrapped-label') {
      const token = x.tokens.find(
        (t: { text: string; rect: number[] }) =>
          t.text === '+' && t.rect[1] > 940 && t.rect[1] < 945
      )
      token.text = 'high'
    }
    if (condition === 'incomplete-counts')
      x.tokens = x.tokens.filter(
        (t: { text: string; rect: number[] }) =>
          !(t.text === '23' && t.rect[1] > 970 && t.rect[1] < 995)
      )
    if (condition === 'lowercase-heading')
      x.tokens.find((t: { text: string }) => t.text === 'PR').text = 'pr'
    if (condition === 'detached-intervening-glyph') {
      const token = x.tokens.find(
        (t: { text: string; rect: number[] }) =>
          t.text === '2' && t.rect[1] > 977 && t.rect[1] < 978
      )
      token.rect[0] += 8
      token.rect[2] += 8
    }
    const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(result.repairs).not.toContain('binary-record-section-separated')
  }
)
