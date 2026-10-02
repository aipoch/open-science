import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { recoverUnderlinedCohortPairHeaderBands } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-source-records.mjs')).href
)

it.each([
  'native',
  'unqualified-leaf',
  'missing-rule',
  'inset-rule',
  'crossing-token',
  'body-record'
])('recovers a left-aligned group over fragmented sample leaves with %s evidence', (variant) => {
  const f: {
    source: Array<{ text: string; rect: number[] }>
    items: Array<{ text: string; rect: number[] }>
    cuts: number[]
    rules: number[][]
    top: number
    bottom: number
    table: unknown
    captions: unknown[]
  } = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/left-aligned-group-with-fragmented-sample-leaves.jsonl'
    )
  )
  if (variant === 'unqualified-leaf')
    f.source.find((i) => i.text === 'Treatment (')!.text = 'Treatment'
  if (variant === 'missing-rule') f.rules = []
  if (variant === 'inset-rule') f.rules[0][0] += 3
  if (variant === 'crossing-token')
    f.source.find((i) => i.text === 'Treatment (')!.rect[2] = f.cuts[4]
  if (variant === 'body-record')
    f.source.push({ ...f.source[0], text: '12.4', rect: [330, 129, 350, 133] })
  const original = structuredClone(f)
  const result = recoverUnderlinedCohortPairHeaderBands(f.source, f.cuts, f.rules, f.top, f.bottom)
  expect(Boolean(result)).toBe(variant === 'native')
  if (result) expect(result.spans).toContainEqual({ row: 0, column: 2, rowSpan: 1, colSpan: 2 })
  expect(f).toEqual(original)
})
