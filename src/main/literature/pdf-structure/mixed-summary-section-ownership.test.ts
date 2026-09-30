import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverClinicalCountSections } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/paired-count-columns-below-merged-summary-records.jsonl'
    )
  )

it('retains section statistics and merged summaries above separate count/percentage columns', () => {
  const x = fixture()
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.unassigned).toEqual([])
  expect(result.grid.some((r: string[]) => r[0] === 'Size category' && r[5] === '0.73')).toBe(true)
  expect(result.cells.find((c: { text: string }) => c.text === '58.72 (9.6)')).toMatchObject({
    column: 1,
    colSpan: 2
  })
  expect(result.cells.find((c: { text: string }) => c.text === '57.03 (10.3)')).toMatchObject({
    column: 3,
    colSpan: 2
  })
  expect(result.cells.find((c: { text: string }) => c.text === 'Missing')).toMatchObject({
    colSpan: 1
  })
  expect(result.grid.some((r: string[]) => r.slice(1).join('|') === 'n|%|n|%|Pb')).toBe(true)
  expect(result.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)).toHaveLength(
    x.tokens.length
  )
})

it.each(['underline', 'unit', 'summary', 'count', 'sample', 'orphan'])(
  'declines a mixed summary/count grid with contradictory %s evidence',
  (variant) => {
    const x = fixture()
    const tokens = x.tokens as { text: string; rect: number[]; baseline: number; height: number }[]
    if (variant === 'underline')
      x.rules = x.rules.filter((r: number[]) => !(r[1] > 125 && r[1] < 135))
    if (variant === 'unit') tokens.find((i) => i.text === '%')!.text = 'SD'
    if (variant === 'summary') tokens.find((i) => i.text === '58.72 (9.6)')!.text = '58.72'
    if (variant === 'count') tokens.find((i) => i.text === '13')!.text = 'unknown'
    if (variant === 'sample') tokens.find((i) => i.text === '= 32)')!.text = '= ?)'
    if (variant === 'orphan')
      tokens.push({
        ...tokens[0],
        text: 'Unexplained',
        rect: [240, 343, 280, 354],
        baseline: 354,
        height: 11
      })
    expect(recoverClinicalCountSections(x.table, tokens, x.rules)).toBeUndefined()
  }
)

it('joins the hanging terminal label and value without treating a shared ancestor as a leaf stub', () => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/terminal-hanging-record-inside-shared-parameter-stub.jsonl'
    )
  ) as ReturnType<typeof JSON.parse>
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(result.grid.at(-1)[1]).toBe('Frequency of treatment sessions')
  expect(result.grid.at(-1)[2]).toContain('weeks (10 sessions in total)')
  expect(result.grid.at(-2)[1]).toBe('Timing')
  expect(result.unassigned).toEqual([])
})

it.each(['closing-border', 'divider', 'indent', 'independent-label', 'wrapping-witness'])(
  'keeps a terminal parameter record separate when %s contradicts continuation',
  (variant) => {
    const x = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/source-grids/terminal-hanging-record-inside-shared-parameter-stub.jsonl'
      )
    ) as ReturnType<typeof JSON.parse>
    const tokens = x.tokens as { text: string; rect: number[] }[]
    if (variant === 'closing-border') x.rules = x.rules.filter((r: number[]) => r[1] < 870)
    if (variant === 'divider') x.rules.push([63, 849.9, 833, 849.9])
    if (variant === 'indent') {
      const tail = tokens.find((i) => i.text === 'sessions')!
      tail.rect[0] -= 18
      tail.rect[2] -= 18
    }
    if (variant === 'independent-label')
      tokens.find((i) => i.text === 'sessions')!.text = 'Sessions'
    if (variant === 'wrapping-witness')
      x.tokens = tokens.filter((i) => i.text !== 'coincident propagation axes')
    const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(result.grid.at(-1)[1]).not.toBe('Frequency of treatment sessions')
  }
)
