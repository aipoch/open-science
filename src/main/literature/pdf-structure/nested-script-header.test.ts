import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/nested-underlined-headers-with-raised-comparison-markers.jsonl'
    )
  )
it('restores underlined cohort and visit parents beside raised comparison markers', () => {
  const f = fixture(),
    original = structuredClone(f)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  for (const text of ['Active arm (n = 18)', 'Control arm (n = 19)'])
    expect(r.cells.find((c: { text: string }) => c.text === text)).toMatchObject({
      row: 0,
      colSpan: 4,
      rowSpan: 1
    })
  expect(
    r.cells.filter(
      (c: { text: string; colSpan: number }) =>
        ['Initial', 'Final'].includes(c.text) && c.colSpan === 2
    )
  ).toHaveLength(4)
  expect(
    r.cells.filter(
      (c: { text: string; rowSpan: number }) => /^P[ab]$/.test(c.text) && c.rowSpan === 3
    )
  ).toHaveLength(3)
  expect(r.grid[4].slice(1)).toEqual([
    '67.3',
    '62.0–74.1',
    '67.5',
    '62.8–77.6',
    '0.078',
    '66.6',
    '57.7–73.2',
    '67.5',
    '57.5–71.7',
    '0.776',
    '0.079'
  ])
  expect(r.unassigned).toEqual([])
  expect(f).toEqual(original)
})
it('keeps a slightly overhanging wrapped parent above its native pair of leaves', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/wrapped-parent-heading-overhanging-native-underline.jsonl'
    )
  )
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.cells.find((c: { text: string }) => c.text === 'Control (n = 217)')).toMatchObject({
    row: 0,
    column: 3,
    colSpan: 2
  })
  expect(r.cells.find((c: { text: string }) => c.text === 'Intervention (n = 211)')).toMatchObject({
    row: 0,
    column: 5,
    colSpan: 2
  })
  expect(r.cells.find((c: { text: string }) => c.text === 'Overall')).toMatchObject({
    row: 0,
    column: 1,
    colSpan: 2
  })
  expect(r.grid[2]).toEqual([
    'Age (years)',
    '53.18',
    '9.68',
    '53.84',
    '9.99',
    '52.5',
    '9.25',
    '0.15'
  ])
})
it.each([
  'missing top border',
  'missing child underline',
  'missing parent underline',
  'detached script'
])('does not invent the nested hierarchy with %s', (kind) => {
  const f = fixture()
  if (kind === 'missing top border')
    f.rules = f.rules.filter((r: number[]) => Math.abs(r[1] - 148.7332) > 0.1)
  if (kind === 'missing child underline')
    f.rules = f.rules.filter((r: number[]) => !(Math.abs(r[1] - 188.1922) < 0.1 && r[0] < 250))
  if (kind === 'missing parent underline')
    f.rules = f.rules.filter((r: number[]) => Math.abs(r[1] - 168.4628) > 0.1)
  if (kind === 'detached script') {
    const marker = f.tokens.find((i: { text: string }) => i.text === 'a')
    marker.rect[0] += 12
    marker.rect[2] += 12
  }
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.cells.find((c: { text: string }) => c.text === 'Active arm (n = 18)')?.colSpan).not.toBe(
    4
  )
})
it('preserves all native header and body tokens exactly once', () => {
  const f = fixture(),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    f.tokens.map((i: { rect: number[] }) => i.rect).sort()
  )
})
it('uses a complete native header tree above an interrupted bottom rule', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/nested-headers-above-interrupted-bottom-rule.jsonl'
    )
  )
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.rows[0].rect[1]).toBeGreaterThanOrEqual(148.7332)
  expect(r.cells.find((c: { text: string }) => c.text === 'Active arm (n = 18)')).toMatchObject({
    row: 0,
    colSpan: 4
  })
  expect(
    r.cells.filter(
      (c: { text: string; colSpan: number }) =>
        ['Initial', 'Final'].includes(c.text) && c.colSpan === 2
    )
  ).toHaveLength(4)
  expect(r.unassigned).toEqual([])
})
it.each(['top', 'parents'])(
  'does not reconstruct an interrupted header without its %s rules',
  (part) => {
    const f = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/source-grids/nested-headers-above-interrupted-bottom-rule.jsonl'
      )
    )
    f.rules = f.rules.filter(
      (r: number[]) => Math.abs(r[1] - (part === 'top' ? 148.7332 : 168.4628)) > 0.1
    )
    const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
    expect(
      r.cells.find((c: { text: string }) => c.text === 'Active arm (n = 18)')?.colSpan
    ).not.toBe(4)
  }
)
