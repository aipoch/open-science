import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/seasonality-inset-records.jsonl'
    )
  )
const run = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  refineTable(f.table, f.tokens, f.captions, [], f.rules)

it('recovers an inset numeric record and an empty daily label while preserving section notes', () => {
  const f = fixture()
  const original = structuredClone(f)
  const r = run(f)
  expect(r.repairs).toContain('source-seasonality-rows-recovered')
  expect(r.grid).toContainEqual(['', 'ABC', '24, 167', '24, 168'])
  expect(r.grid).toContainEqual(['daily_series_with_missing', 'D', '7, 365', '—'])
  expect(r.unassigned).not.toContain('ABC')
  expect(r.unassigned).not.toContain('daily_series_with_missing')
  expect(r.unassigned).toContain('‘—’ = nothing detected')
  expect(r.issues).toContain('unassigned-source-text')
  expect(f).toEqual(original)
})

it.each(['caption', 'inset-baseline', 'daily-baseline', 'daily-value'])(
  'declines the narrow recovery when %s evidence is missing or conflicting',
  (variant) => {
    const f = fixture()
    if (variant === 'caption') f.captions = []
    if (variant === 'inset-baseline') {
      const token = f.tokens.find((item: { text: string }) => item.text === '24, 167')
      token.rect[1] -= 20
      token.rect[3] -= 20
      token.baseline -= 20
    }
    if (variant === 'daily-baseline') {
      const token = f.tokens.find(
        (item: { text: string }) => item.text === 'daily_series_with_missing'
      )
      token.rect[1] -= 20
      token.rect[3] -= 20
      token.baseline -= 20
    }
    if (variant === 'daily-value') {
      const label = f.tokens.find(
        (item: { text: string }) => item.text === 'daily_series_with_missing'
      )
      const token = f.tokens.find(
        (item: { text: string; baseline: number }) =>
          item.text === '7, 365' && item.baseline === label.baseline
      )
      token.text = '7, 360'
    }
    expect(run(f).repairs).not.toContain('source-seasonality-rows-recovered')
  }
)
