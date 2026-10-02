import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverRepeatedVisitGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-repeated-visit-grid.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-paired-visit-statistics-with-long-stubs.jsonl'
    )
  )
it('keeps pure native stub baselines separate from measured paired visits', (): void => {
  const x = fixture(),
    r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(18)
  expect(r.grid[2][0]).toBe('Composite source inventory')
  for (const [n, name] of [
    [3, 'Measure A'],
    [6, 'Measure B'],
    [9, 'Measure C'],
    [12, 'Measure D'],
    [15, 'Measure E']
  ] as const) {
    expect(r.grid[n][0]).toBe(name)
    expect(r.grid[n].slice(1).every((v: string) => !v)).toBe(true)
    expect(
      r.cells.find((c: { row: number; column: number }) => c.row === n && c.column === 0)
    ).toMatchObject({ colSpan: 14 })
    expect(r.grid[n + 1][0]).toBe('t1')
    expect(r.grid[n + 2][0]).toBe('t2')
    expect(r.grid[n + 2].slice(8)).toEqual(Array(6).fill(''))
  }
  expect(r.unassigned).toEqual([])
  const rects = r.cells.flatMap((c: { sourceRects: number[][] }) =>
    c.sourceRects.map((v) => JSON.stringify(v))
  )
  expect(new Set(rects).size).toBe(x.tokens.length)
  expect(rects.length).toBe(x.tokens.length)
})
for (const mode of [
  'caption',
  'closing',
  'competing-closing',
  'leaf',
  'visit',
  'incomplete',
  'extra-tail',
  'overhang',
  'duplicate'
] as const)
  it(`rejects incomplete native paired-visit proof: ${mode}`, (): void => {
    const x = fixture()
    if (mode === 'caption') x.captions = []
    if (mode === 'closing') x.rules = x.rules.filter((r: number[]) => r[1] !== 402)
    if (mode === 'competing-closing')
      x.rules.push(
        ...x.rules
          .filter((r: number[]) => r[1] === 402)
          .map((r: number[]) => [r[0], 403, r[2], 403])
      )
    if (mode === 'leaf') x.tokens.find((i: { text: string }) => i.text === 'SD')!.text = 'Unit'
    if (mode === 'visit')
      x.tokens.find(
        (i: { text: string; rect: number[] }) => i.text === '2' && i.rect[2] < 160
      )!.text = '3'
    if (mode === 'incomplete')
      x.tokens = x.tokens.filter(
        (i: { rect: number[] }) =>
          !(i.rect[0] > 240 && i.rect[2] < 265 && i.rect[1] > 200 && i.rect[3] < 214)
      )
    if (mode === 'extra-tail') {
      const i = x.tokens.find((i: { rect: number[] }) => i.rect[0] > 830 && i.rect[1] > 200)!
      x.tokens.push({
        ...i,
        baseline: i.baseline + 14.18,
        rect: [i.rect[0], i.rect[1] + 14.18, i.rect[2], i.rect[3] + 14.18]
      })
    }
    if (mode === 'overhang')
      x.tokens.find(
        (i: { rect: number[] }) => i.rect[0] > 491 && i.rect[0] < 500 && i.rect[1] > 210
      )!.rect[0] = 485
    if (mode === 'duplicate') x.tokens.push(x.tokens.at(-1))
    expect(recoverRepeatedVisitGrid(x.table, x.tokens, x.captions, x.rules)?.repair).not.toBe(
      'native-body-records-recovered'
    )
  })
