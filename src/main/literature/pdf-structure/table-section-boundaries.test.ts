import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`))

it('separates a measurement section after a complete percentage record', () => {
  const x = fixture('percentage-to-measurements')
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid).toContainEqual(['Hispanic Ethnicity (%)', '36', '10.78%', '26', '10.16%', '0.506'])
  expect(r.grid).toContainEqual(['Baseline Physical Activity', '', '', '', '', ''])
  expect(r.grid.some((row: string[]) => row.every((v) => !v))).toBe(false)
  expect(r.grid.find((row: string[]) => row[0] === 'Light PA (min/week)')).toEqual([
    'Light PA (min/week)',
    '332',
    '1054.18 (391.6), 208–2882',
    '258',
    '1168.02 (343.0), 349–2882',
    '<0.001'
  ])
})

it('removes unsupported model bands beside established section rows', () => {
  const x = fixture('wrapped-threshold-label')
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid.some((row: string[]) => row.every((v) => !v))).toBe(false)
  for (const heading of ['N staging', 'M staging'])
    expect(r.grid).toContainEqual([heading, '', '', ''])
  expect(r.grid).toContainEqual(['0', '45 (81.8)', '36 (85.7)', '0.608'])
})

it.each(['different-unit', 'missing-value', 'lowercase-continuation', 'overlapping-source'])(
  'keeps ambiguous section ownership with %s evidence',
  (condition) => {
    const x = fixture('percentage-to-measurements')
    if (condition === 'different-unit') {
      const token = x.tokens.find(
        (t: { text: string }) => t.text === 'Moderate-to Vigorous PA (min/week)'
      )
      token.text = 'Moderate-to Vigorous PA (min/day)'
    }
    if (condition === 'missing-value')
      x.tokens = x.tokens.filter((t: { text: string }) => t.text !== '0.506')
    const heading = x.tokens.find((t: { text: string }) => t.text === 'Baseline Physical Activity')
    if (condition === 'lowercase-continuation') heading.text = 'with baseline physical activity'
    if (condition === 'overlapping-source') heading.rect[1] -= 8
    const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(r.repairs).not.toContain('unit-measurement-section-separated')
  }
)
