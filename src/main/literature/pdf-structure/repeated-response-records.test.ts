import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverResponseScaleGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-record-grid.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/repeated-response-counts-with-wrapped-prompts.jsonl'
    )
  )

it('separates repeated responses while retaining wrapped prompts and block statistics', () => {
  const x = fixture()
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.grid).toHaveLength(47)
  expect(result.grid[1]).toEqual(['', 'Total Number of Included Patients (173)', '83', '90', 'NA'])
  expect(result.grid[2].slice(1, 4)).toEqual(['Strongly agree', '16(19.3%)', '19(21.6%)'])
  expect(result.grid[6].slice(1, 4)).toEqual(['Strongly disagree', '0(0%)', '0(0.0%)'])
  expect(
    result.cells.filter(
      (c: { column: number; rowSpan: number }) => c.column === 0 && c.rowSpan === 5
    )
  ).toHaveLength(9)
  expect(
    result.cells.filter(
      (c: { column: number; rowSpan: number }) => c.column === 4 && c.rowSpan === 5
    )
  ).toHaveLength(5)
  expect(result.unassigned).toEqual([])
  expect(result.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)).toHaveLength(
    x.tokens.length
  )
  expect(result.grid.slice(27).map((r: string[]) => r[3])).toEqual(Array(20).fill('‐'))
})

it.each([
  'cycle',
  'count',
  'missing-arm',
  'statistic',
  'prompt',
  'column',
  'duplicate',
  'closing-rule',
  'caption'
])('refuses response recovery with ambiguous or incomplete %s evidence', (variant) => {
  const x = fixture()
  const first = x.tokens.find((i: { text: string }) => i.text === 'Strongly agree')
  if (variant === 'cycle') first.text = 'Different response'
  if (variant === 'count')
    x.tokens.splice(
      x.tokens.findIndex((i: { text: string }) => i.text === '16(19.3%)'),
      1
    )
  if (variant === 'missing-arm')
    x.tokens.find((i: { text: string }) => i.text === '19(21.6%)').text = '‐'
  if (variant === 'statistic') {
    const stat = structuredClone(x.tokens.find((i: { text: string }) => i.text === '0.3090'))
    stat.baseline = first.baseline
    stat.rect[1] = first.rect[1]
    stat.rect[3] = first.rect[3]
    x.tokens.push(stat)
  }
  if (variant === 'prompt')
    x.tokens = x.tokens.filter(
      (i: { rect: number[] }) => !(i.rect[0] < 304 && i.rect[1] > 150 && i.rect[1] < 225)
    )
  if (variant === 'column') first.rect[2] = 480
  if (variant === 'duplicate') x.tokens.push(first)
  if (variant === 'closing-rule') x.rules = []
  if (variant === 'caption') x.captions = []
  expect(recoverResponseScaleGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
})

it('uses the repeated source categories instead of hardcoded response wording', () => {
  const x = fixture()
  const labels = [
    'Strongly agree',
    'Agree',
    'Neither disagree nor agree',
    'Disagree',
    'Strongly disagree'
  ]
  for (const item of x.tokens) {
    const index = labels.indexOf(item.text)
    if (index >= 0) item.text = `Response category ${index + 1}`
  }
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.grid.filter((r: string[]) => r[1] === 'Response category 1')).toHaveLength(9)
  expect(result.unassigned).toEqual([])
})

it('joins a hanging count-label continuation before a new section', () => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/wrapped-count-label-before-section.jsonl'
    )
  )
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  const row = result.grid.find((r: string[]) => r[0].startsWith('Number of patients who actually'))
  expect(row[0]).toBe('Number of patients who actually received chemotherapy (from EMR), (%)')
  expect(row.slice(1, 5)).toEqual(['10 (12.0%)', '11 (12.2%)', '0.9721', '21 (12.1%)'])
  expect(result.grid.some((r: string[]) => r[0] === 'First treatment:')).toBe(true)
  expect(result.unassigned).toEqual([])
})

it.each(['unmatched-indent', 'intervening-rule', 'new-record', 'different-leading'])(
  'retains the separate stub when %s contradicts the repeated wrapping evidence',
  (variant) => {
    const x = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/source-grids/wrapped-count-label-before-section.jsonl'
      )
    )
    const head = x.tokens.find(
      (i: { text: string }) => i.text === 'Number of patients who actually received'
    )
    const tail = x.tokens.find((i: { text: string }) => i.text === 'chemotherapy (from EMR), (%)')
    if (variant === 'unmatched-indent') {
      tail.rect[0] += 5
      tail.rect[2] += 5
    }
    if (variant === 'intervening-rule')
      x.rules.push([
        head.rect[0],
        (head.rect[3] + tail.rect[1]) / 2,
        x.table.cropRect[2],
        (head.rect[3] + tail.rect[1]) / 2
      ])
    if (variant === 'new-record') tail.text = 'Chemotherapy (from EMR), (%)'
    if (variant === 'different-leading') {
      tail.baseline += 2
      tail.rect[1] += 2
      tail.rect[3] += 2
    }
    const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    const row = result.grid.find((r: string[]) =>
      r[0].startsWith('Number of patients who actually')
    )
    expect(row[0]).toBe('Number of patients who actually received')
  }
)
