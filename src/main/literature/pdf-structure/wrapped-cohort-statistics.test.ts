import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverWrappedCohortStatistics } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
)
const fixture = (kind: 'sd' | 'ci'): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      `src/main/literature/pdf-structure/fixtures/source-grids/wrapped-cohort-${kind}-records.jsonl`
    )
  )
for (const kind of ['sd', 'ci'] as const)
  it(`preserves native ${kind} suffixes in each complete cohort record`, (): void => {
    const f = fixture(kind),
      r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
    if (kind === 'sd')
      expect(
        r.grid.some((row: string[]) => row[1] === '272.35 (6.84)' && row[3] === '272.24 (6.42)')
      ).toBe(true)
    else
      expect(
        r.grid.some((row: string[]) => row[1] === '1.1291 (1.1279, 1.1203)' && row[6] === '1.902')
      ).toBe(true)
    expect(r.unassigned).toEqual([])
    const assigned = r.cells.flatMap((c: { sourceRects: number[][] }) =>
      c.sourceRects.map((v) => JSON.stringify(v))
    )
    expect(new Set(assigned).size).toBe(assigned.length)
    expect(assigned.length).toBe(f.tokens.length)
    expect(r.cropRect).toEqual(f.table.cropRect)
  })
for (const name of ['caption', 'footer', 'extra', 'section', 'suffix', 'head'] as const)
  it(`rejects incomplete wrapped statistics: ${name}`, (): void => {
    const f = fixture('sd')
    if (name === 'caption') f.captions = []
    if (name === 'footer') f.rules = f.rules.filter((r: number[]) => r[1] < 350)
    if (name === 'extra') {
      const t = f.tokens.find(
        (t: { text: string; rect: number[]; baseline: number; height: number }) =>
          t.text === '(6.84)'
      )!
      f.tokens.push({
        ...t,
        text: '9.2',
        rect: [t.rect[0] + 15, t.rect[1], t.rect[2] + 15, t.rect[3]]
      })
    }
    if (name === 'section')
      f.tokens.find(
        (t: { text: string; rect: number[]; baseline: number; height: number }) =>
          t.text === 'unitQ'
      )!.text = 'Unrelated'
    if (name === 'suffix')
      f.tokens.find(
        (t: { text: string; rect: number[]; baseline: number; height: number }) =>
          t.text === '(6.84)'
      )!.text = '6.84'
    if (name === 'head')
      f.tokens.find(
        (t: { text: string; rect: number[]; baseline: number; height: number }) =>
          t.text === '272.35'
      )!.text = '272.35 (2.3)'
    expect(recoverWrappedCohortStatistics(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  })
