import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { recoverCitedRecordTails } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/clipped-citation-with-parallel-result-tails.jsonl'
    )
  )

it('recovers a clipped citation and both independently wrapped result columns', () => {
  const f = load(),
    repairs: string[] = []
  const old = structuredClone(f.rows)
  recoverCitedRecordTails({ ...f, repairs })
  expect(f.rows[2].rect[3]).toBeCloseTo(309.8406)
  expect(f.rows[2].rect[3]).toBeLessThan(f.rows[3].rect[1])
  expect(repairs).toEqual(['wrapped-source-row-recovered'])
  expect(f.rows.filter((_: unknown, n: number) => n !== 2)).toEqual(
    old.filter((_: unknown, n: number) => n !== 2)
  )
})

it.each([
  'not-citation',
  'missing-year',
  'fewer-authors',
  'missing-borders',
  'internal-rule',
  'single-result',
  'not-bullet',
  'next-row-owner',
  'cross-gutter',
  'detached-citation'
])('does not change a row without complete reference-tail evidence: %s', (variant) => {
  const f = load(),
    repairs: string[] = []
  if (variant === 'not-citation')
    f.items.find((i: { text: string }) => i.text === '[6,7]').text = 'new data'
  if (variant === 'missing-year')
    f.items = f.items.filter((i: { text: string }) => i.text !== '(2009, 2013)')
  if (variant === 'fewer-authors')
    f.items = f.items.filter(
      (i: { text: string }) => !['AuthorAlpha', 'AuthorDelta'].includes(i.text)
    )
  if (variant === 'missing-borders') f.rules = []
  if (variant === 'internal-rule') f.rules.push([103, 289, 1133, 289])
  if (variant === 'single-result')
    f.items = f.items.filter(
      (i: { rect: number[] }) => !(i.rect[0] > 950 && i.rect[1] > 265 && i.rect[3] < 305)
    )
  if (variant === 'not-bullet')
    f.items.find(
      (i: { text: string; rect: number[] }) => i.text === '-' && i.rect[0] > 780 && i.rect[1] > 265
    ).text = 'new'
  if (variant === 'next-row-owner') f.rows[3].rect[1] = 295
  if (variant === 'cross-gutter')
    f.items.find((i: { text: string }) => i.text === 'HR 2.4 (95% CI 0.9').rect[0] = 760
  if (variant === 'detached-citation') {
    const i = f.items.find((i: { text: string }) => i.text === '[6,7]')
    i.rect[1] += 25
    i.rect[3] += 25
    i.baseline += 25
  }
  const old = structuredClone(f.rows)
  recoverCitedRecordTails({ ...f, repairs })
  expect(f.rows).toEqual(old)
  expect(repairs).toEqual([])
})

it.each([0.7, 1.8])('recovers the same source boundary at scale %s', (scale) => {
  const f = load(),
    repairs: string[] = []
  for (const r of f.rows) r.rect = r.rect.map((v: number) => v * scale)
  f.columnRects = f.columnRects.map((r: number[]) => r.map((v) => v * scale))
  f.rules = f.rules.map((r: number[]) => r.map((v) => v * scale))
  for (const i of f.items) {
    i.rect = i.rect.map((v: number) => v * scale)
    i.height *= scale
    i.baseline *= scale
  }
  recoverCitedRecordTails({ ...f, repairs })
  expect(f.rows[2].rect[3] / scale).toBeCloseTo(309.8406)
  expect(repairs).toHaveLength(1)
})
