import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { recoverRuledHeaderBands } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-source-records.mjs')).href
)

it.each([
  'inset-population-parent-leaf-lanes',
  'native-vertical-cohort-parent-partition',
  'independent-sibling-titles-over-sample-counts'
])('recovers %s only with complete native evidence', (name) => {
  for (const variant of ['native', 'missing-proof', 'conflicting-leaf']) {
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
      resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`)
    )
    if (variant === 'missing-proof') {
      if (name.startsWith('inset')) f.rules = f.rules.filter((r) => Math.abs(r[1] - f.bottom) > 1)
      if (name.startsWith('native-vertical')) f.rules = f.rules.filter((r) => r[0] !== r[2])
      if (name.startsWith('independent')) f.rules = f.rules.filter((r) => r[1] < 550)
    }
    if (variant === 'conflicting-leaf') {
      if (name.startsWith('inset'))
        f.source.filter((i) => i.text === 'Metric beta')[1].text = 'Other'
      if (name.startsWith('native-vertical'))
        f.source.find((i) => i.text === 'Reference cohort')!.rect[2] = f.cuts[5]
      if (name.startsWith('independent'))
        f.source.find((i) => i.text === 'N' && i.rect[1] > 560)!.text = 'Q'
    }
    const original = structuredClone(f)
    const result = recoverRuledHeaderBands(f.source, f.cuts, f.rules, f.top, f.bottom)
    const pass = name.startsWith('inset')
      ? result?.spans.filter(
          (s: { row: number; colSpan: number; column: number }) => s.row === 0 && s.colSpan === 4
        ).length === 2
      : name.startsWith('native-vertical')
        ? result?.spans.filter(
            (s: { row: number; colSpan: number; column: number }) => s.row === 0 && s.colSpan === 3
          ).length === 2
        : result?.rows.length === 3 &&
          !result.spans.some((s: { row: number; colSpan: number }) => s.row === 1 && s.colSpan > 1)
    expect(pass).toBe(variant === 'native')
    expect(f).toEqual(original)
  }
})
