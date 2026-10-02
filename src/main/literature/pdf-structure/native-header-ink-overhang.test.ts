import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { recoverRuledComparisonRecords } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
)

it.each(['native', 'large-overhang', 'adjacent-prose'])(
  'retains cohort ink at a native border with %s evidence',
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
        'src/main/literature/pdf-structure/fixtures/source-grids/native-border-with-tiny-header-ink-overhang.jsonl'
      )
    )
    const title = f.items.find((i) => i.text === 'Reference cohort')!
    if (variant === 'large-overhang') title.rect[1] -= 2
    if (variant === 'adjacent-prose') {
      f.items.push({
        ...title,
        text: 'Nearby paragraph',
        rect: [title.rect[0], 115, title.rect[2], 125]
      })
    }
    const original = structuredClone(f)
    const r = recoverRuledComparisonRecords(f.table, f.items, f.captions, f.rules)
    expect(Boolean(r)).toBe(true)
    expect(r.rows[0][1] <= title.rect[1]).toBe(variant !== 'large-overhang')
    if (variant === 'adjacent-prose') expect(r.rows[0][1]).toBeGreaterThan(125)
    expect(f).toEqual(original)
  }
)
