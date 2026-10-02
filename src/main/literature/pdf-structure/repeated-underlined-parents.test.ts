import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { recoverRuledHeaderBands } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-source-records.mjs')).href
)

it.each(['native', 'different-leaf', 'missing-leaf', 'crossing-title', 'missing-leaf-strokes'])(
  'partitions a continuous parent underline with %s evidence',
  (variant) => {
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
        'src/main/literature/pdf-structure/fixtures/source-grids/continuous-underline-with-repeated-leaf-pairs.jsonl'
      )
    )
    const leaf = f.source.filter((i) => i.text === 'SD')[1]
    if (variant === 'different-leaf') leaf.text = 'Other'
    if (variant === 'missing-leaf') f.source.splice(f.source.indexOf(leaf), 1)
    if (variant === 'crossing-title')
      f.source.find((i) => i.text === 'Treatment Alpha')!.rect[2] = f.cuts[4]
    if (variant === 'missing-leaf-strokes')
      f.rules = f.rules.filter((r) => r[1] > 118 && r[1] < 160)
    const original = structuredClone(f)
    const result = recoverRuledHeaderBands(f.source, f.cuts, f.rules, f.top, f.bottom)
    const spans = result?.spans.filter(
      (s: { row: number; colSpan: number; column: number }) =>
        s.row === 0 && s.colSpan === 2 && s.column < 7
    )
    expect(spans?.length ?? 0).toBe(variant === 'native' ? 3 : 0)
    expect(f).toEqual(original)
  }
)
