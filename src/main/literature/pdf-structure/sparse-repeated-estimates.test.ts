import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/repeated-estimates-with-sparse-statistics.jsonl'
    )
  )

it.each([0, 1])(
  'retains underlined comparison parents with uppercase superscripts: %s',
  (index) => {
    const x = fixture().cases[index],
      t = refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
    expect(
      t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 7)
    ).toMatchObject({ colSpan: 3, rowSpan: 1 })
    expect(
      t.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 7).textRuns
    ).toContainEqual({ text: 'B', position: 'superscript' })
    expect(t.grid[0][7]).toMatch(/B$/)
    expect(t.grid[1].slice(-3)).toEqual(['Arm B vs. Arm C', 'Arm A vs. Arm C', 'Arm B vs. Arm A'])
  }
)
it.each([0, 1])(
  'separates repeated section cycles when only change records carry statistics: %s',
  (index) => {
    const x = fixture().cases[index],
      t = refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
    const labels =
      index === 0
        ? [
            'Chair Stand (sec)',
            'Walk Speed (m/s)',
            'SPPB SumC',
            'SF-36 Physical FunctionD',
            'LLFDI Upper Extremity FunctionE',
            'LLFDI Lower Extremity FunctionE',
            'LLFDI Advance Lower Extremity FunctionE'
          ]
        : [
            '1 RM Bench Press (kg)',
            '1 RM Leg Press (kg)',
            '6 Minute Walk (m)',
            'Chair Sit and Reach (cm)C'
          ]
    for (const label of labels) expect(t.grid).toContainEqual([label, ...Array(9).fill('')])
    expect(t.grid.filter((r: string[]) => r[0] === 'Baseline')).toHaveLength(labels.length)
    expect(
      t.grid.filter((r: string[]) => /^Within group change|^Change from/.test(r[0]))
    ).toHaveLength(labels.length)
    expect(t.grid).toHaveLength(2 + labels.length * 3)
    expect(t.unassigned).toEqual([])
    expect(t.grid.flat().join(' ')).not.toContain('Resistance Exercise Training group')
  }
)

it('keeps paired statistics and confidence limits in their original change records', () => {
  const x = fixture().cases[1],
    t = refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
  expect(t.grid[4]).toEqual([
    'Change from 0 to 12 months',
    '2.5',
    '(1.6, 3.5)',
    '1.7',
    '(0.6, 2.8)',
    '1.1',
    '(0.0, 2.1)',
    '0.396/0.580',
    '0.048/0.192',
    '0.288/0.533'
  ])
  expect(t.grid[13]).toEqual([
    'Change from 0 to 12 months',
    '3.2',
    '(0.9, 5.5)',
    '1.9',
    '(−0.6, 4.4)',
    '2.5',
    '(0.1, 4.9)',
    '0.738/0.738',
    '0.679/0.738',
    '0.435/0.580'
  ])
})

it.each([
  ['an internal numeric gap', '21.0'],
  ['different trailing occupancy between sections', '(20.7, 23.9)']
])('declines cycle reconstruction with %s', (_, removedValue) => {
  const x = fixture().cases[1]
  x.tokens = x.tokens.filter((token: { text: string }) => token.text !== removedValue)
  const t = refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
  expect(t.repairs).not.toContain('repeated-measurement-section-separated')
  expect(t.grid[3].slice(1)).toContain('')
  expect(t.grid.flat()).not.toContain(removedValue)
})

it('declines cycle reconstruction when record labels differ between sections', () => {
  const x = fixture().cases[1]
  x.tokens.find((token: { text: string }) => token.text === 'Baseline').text = 'Other measurement'
  const t = refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
  expect(t.repairs).not.toContain('repeated-measurement-section-separated')
  expect(t.grid[3][0]).toBe('Other measurement')
})
