import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { repairWrappedTableRows } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )
const refine = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  refineTable(f.table, f.tokens, f.captions, [], f.rules)
const repair = 'text-supported-wrapped-records-recovered'

it('keeps the final wrapped resource and URL in one record without repairing source spelling', () => {
  const t = refine(fixture('wrapped-resource-records'))
  expect(t.grid).toHaveLength(17)
  expect(t.grid.at(-1)).toEqual([
    'The Molecular Signatures Database (MSigDB',
    'Liberzon et al.19',
    'https://www.gsea-msigdb.org/gsea/msigdb'
  ])
  expect(t.grid[6][0]).toContain('bioosies')
  expect(
    t.cells.find((c: { text: string }) => c.text === 'Liberzon et al.19').textRuns
  ).toContainEqual({
    text: '19',
    position: 'superscript'
  })
})

it('returns a wrapped kit name to its own record and preserves the next supplier and identifier', () => {
  const t = refine(fixture('clipped-resource-header'))
  expect(t.grid).toHaveLength(31)
  const row = t.grid.findIndex(
    (r: string[]) => r[0] === 'Chromium Single Cell Human TCR Amplification Kit'
  )
  expect(t.grid[row]).toEqual([
    'Chromium Single Cell Human TCR Amplification Kit',
    '10X Genomics',
    '1000252'
  ])
  expect(t.grid[row + 1]).toEqual(['High Sensitivity DNA kit', 'Agilent Technologies', '5067–4626'])
  expect(t.grid.every((r: string[]) => r.some(Boolean))).toBe(true)
  for (const text of ['Biological samples', 'Software and algorithms']) {
    expect(t.cells.find((c: { text: string }) => c.text === text)).toMatchObject({
      colSpan: 3,
      rowSpan: 1
    })
  }
})

it.each(['wrapped-resource-records', 'clipped-resource-header'])(
  'preserves every enclosed source token exactly once and leaves input unchanged in %s',
  (name) => {
    const f = fixture(name),
      original = structuredClone(f),
      t = refine(f)
    const rects = t.cells.map((c: { rect: number[] }) => c.rect)
    const bounds = [
      Math.min(...rects.map((r: number[]) => r[0])),
      Math.min(...rects.map((r: number[]) => r[1])),
      Math.max(...rects.map((r: number[]) => r[2])),
      Math.max(...rects.map((r: number[]) => r[3]))
    ]
    const signature = (i: { text: string; rect: number[] }): string =>
      JSON.stringify([i.text, i.rect])
    const source = f.tokens.filter(
      (i: { rect: number[] }) =>
        i.rect[0] >= bounds[0] &&
        i.rect[2] <= bounds[2] &&
        i.rect[1] >= bounds[1] &&
        i.rect[3] <= bounds[3]
    )
    expect(
      t.cells
        .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
        .map(signature)
        .sort()
    ).toEqual(source.map(signature).sort())
    expect(t.unassigned).toEqual([])
    expect(t.repairs).toContain(repair)
    expect(f).toEqual(original)
  }
)

it.each([
  'header',
  'rules',
  'divider',
  'misaligned-tail',
  'missing-source',
  'uncited-missing-source',
  'missing-identifier',
  'cross-column'
])('declines resource reconstruction with %s evidence missing or contradicted', (mode) => {
  const f = fixture('wrapped-resource-records')
  const tail = f.tokens.find((i: { text: string }) => i.text === '(MSigDB')
  if (mode === 'header')
    f.tokens.find((i: { text: string }) => i.text === 'IDENTIFIER').text = 'OUTCOME'
  if (mode === 'rules') f.rules = []
  if (mode === 'divider') f.rules.push([90, tail.rect[1] - 1, 824, tail.rect[1] - 1])
  if (mode === 'misaligned-tail')
    tail.rect = tail.rect.map((v: number, n: number) => (n % 2 ? v : v + 30))
  if (mode === 'missing-source')
    f.tokens = f.tokens.filter((i: { text: string }) => i.text !== 'Liberzon et al.')
  if (mode === 'uncited-missing-source') {
    const label = f.tokens.find((i: { text: string }) => i.text === 'Analysis code')
    f.tokens = f.tokens.filter(
      (i: { text: string; baseline: number }) =>
        i.text !== 'Zenodo' || i.baseline !== label.baseline
    )
  }
  if (mode === 'missing-identifier') {
    f.tokens = f.tokens.filter((i: { text: string }) => !i.text.includes('10.5281/zenodo.13833943'))
  }
  if (mode === 'cross-column') tail.rect[2] = 600
  expect(refine(f).repairs).not.toContain(repair)
})

it.each([false, true])(
  'handles resource continuation ownership without losing input (gutter: %s)',
  (gutter) => {
    const token = (text: string, x: number, y: number): ReturnType<typeof JSON.parse> => ({
      text,
      rect: [x, y, x + 20, y + 10],
      height: 10,
      baseline: y + 10,
      horizontal: true
    })
    const record = (y: number): ReturnType<typeof JSON.parse>[] => [
      token('Resource', 5, y),
      token('Supplier', 125, y),
      token('12345', 225, y)
    ]
    const items = [
      token('RESOURCE', 5, 0),
      token('SOURCE', 125, 0),
      token('IDENTIFIER', 225, 0),
      token('Section A', 5, 16),
      ...record(32),
      token('continued', 5, 44),
      ...record(56),
      ...record(68),
      token('Section B', 5, 84),
      ...record(100),
      token('continued', gutter ? 101 : 125, 112),
      ...record(124),
      ...record(136)
    ]
    const columnRects = [
      [0, 0, 100, 150],
      [125, 0, 200, 150],
      [220, 0, 300, 150]
    ]
    const rules = [11, 15, 27, 83, 95, 147].map((y) => [0, y, 300, y])
    const original = structuredClone({ items, columnRects, rules })
    const rows: { rect: number[] }[] = []
    const repairs: string[] = []
    expect(() =>
      repairWrappedTableRows({ rows, items, columnRects, rules, right: 300, repairs })
    ).not.toThrow()
    expect(repairs).toEqual(gutter ? [] : [repair])
    expect(rows).toHaveLength(gutter ? 0 : 9)
    expect({ items, columnRects, rules }).toEqual(original)
  }
)
