import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverSegmentedCohortHeaderBands, groupSourceRowsWithScripts } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-source-records.mjs')).href
)
const { repairWrappedTableRows, recoverProjectedSectionRows } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    'src/main/literature/pdf-structure/fixtures/source-grids/segmented-cohort-header-with-detached-terminal-counts.jsonl'
  )

it.each([0.7, 1, 1.8])(
  'restores fragmented cohort headers, swallowed sections and terminal counts at scale %s',
  (scale) => {
    const f = load()
    for (const rect of [
      f.table.cropRect,
      f.table.detection.rect,
      ...f.table.structure.objects.map((o: { rect: number[] }) => o.rect),
      ...f.tokens.map((i: { rect: number[] }) => i.rect),
      ...f.rules
    ])
      for (let n = 0; n < 4; n++) rect[n] *= scale
    for (const i of f.tokens) {
      i.baseline *= scale
      i.height *= scale
    }
    const result = refineTable(f.table, f.tokens, [], [], f.rules)
    expect(result.grid.at(-1)).toEqual([
      'No',
      '54 (79%)',
      '44 (79%)',
      '10 (83%)',
      '',
      '46 (77%)',
      '8 (100%)',
      '',
      '39 (76%)',
      '15 (88%)',
      ''
    ])
    for (const [column, text] of [
      [4, '0.71'],
      [7, '0.13'],
      [10, '0.30']
    ])
      expect(
        result.cells.find(
          (c: { row: number; column: number }) => c.row === 28 && c.column === column
        )
      ).toMatchObject({ text, rowSpan: 2 })
    const section = result.grid.findIndex((r: string[]) => r[0] === 'Histological subtype')
    expect(result.grid[section - 1][0]).toBe('cN+')
    expect(result.grid[section + 1][0]).toBe('Ductal')
    expect(
      result.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 3)
    ).toHaveLength(3)
    expect(result.grid[0][8]).toMatch(/EpCAM and\/or MCAM-\s*positive CTCs at baseline/)
    expect(result.unassigned).toEqual([])
    const source = f.tokens.filter(
      (i: { rect: number[] }) => (i.rect[1] + i.rect[3]) / 2 < f.table.cropRect[3]
    )
    expect(
      result.cells
        .flatMap((c: { sourceRects: number[][] }) => c.sourceRects.map((r) => JSON.stringify(r)))
        .sort()
    ).toEqual(source.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
  }
)

it.each([
  'missing-top',
  'missing-leaf',
  'broken-frame',
  'spacer-text',
  'missing-child',
  'different-child',
  'off-center',
  'conflicting-rule',
  'rotated',
  'duplicate-source',
  'bad-cuts'
])('rejects unproved native cohort hierarchy: %s', (change) => {
  const f = load(),
    source = f.tokens.filter((i: { rect: number[] }) => i.rect[3] <= 195.69),
    cuts = [f.columnRects[0][0], ...f.columnRects.map((c: number[]) => c[2])]
  if (change === 'missing-top') f.rules = f.rules.filter((r: number[]) => r[1] > 107)
  if (change === 'missing-leaf')
    f.rules = f.rules.filter(
      (r: number[]) => !(r[0] > 987 && r[0] < 1000 && r[1] > 195 && r[1] < 197)
    )
  if (change === 'broken-frame')
    f.rules = f.rules.filter((r: number[]) => !(r[0] > 650 && r[0] < 651 && r[1] < 107))
  if (change === 'spacer-text')
    source.push({ ...source[0], text: 'unowned', rect: [417, 120, 429, 135], baseline: 135 })
  if (change === 'missing-child')
    for (let n = source.length - 1; n >= 0; n--)
      if (source[n].rect[0] >= cuts[9] && source[n].rect[2] <= cuts[10] && source[n].rect[1] > 158)
        source.splice(n, 1)
  if (change === 'different-child')
    source.find(
      (i: { text: string; rect: number[] }) => i.text === '≥1 CTC' && i.rect[0] > 900
    ).text = 'other child'
  if (change === 'off-center')
    for (const i of source.filter((i: { rect: number[] }) => i.rect[0] > 900 && i.rect[3] < 158)) {
      i.rect[0] -= 10
      i.rect[2] -= 10
    }
  if (change === 'conflicting-rule') f.rules.push([905, 145, 1120, 145])
  if (change === 'rotated') source[0].horizontal = false
  if (change === 'duplicate-source') source.push(source[0])
  if (change === 'bad-cuts') cuts[4] = cuts[3]
  expect(recoverSegmentedCohortHeaderBands(source, cuts, f.rules, 94, 195.69)).toBeUndefined()
})

const rowInput = (): ReturnType<typeof JSON.parse> => {
  const f = load(),
    items = f.tokens.filter((i: { rect: number[] }) => i.rect[3] < 690)
  const groups = groupSourceRowsWithScripts(
    items
      .slice()
      .sort(
        (a: { baseline: number; rect: number[] }, b: { baseline: number; rect: number[] }) =>
          a.baseline - b.baseline || a.rect[0] - b.rect[0]
      ),
    15.03,
    0.35
  )
  return { ...f, items, groups, headers: [], right: f.table.cropRect[2], repairs: [] }
}

it.each([
  'missing-top',
  'missing-footer',
  'broken-footer',
  'missing-peer',
  'non-numeric',
  'unowned-prose',
  'conflicting-rule',
  'far-tail',
  'already-owned'
])('preserves terminal row bounds without complete native evidence: %s', (change) => {
  const f = rowInput(),
    last = f.rows.at(-1),
    bottom = last.rect[3]
  if (change === 'missing-top') f.rules = f.rules.filter((r: number[]) => r[1] > 107)
  if (change === 'missing-footer') f.rules = f.rules.filter((r: number[]) => r[1] < 689)
  if (change === 'broken-footer')
    f.rules = f.rules.filter((r: number[]) => !(r[0] > 650 && r[0] < 651 && r[1] > 689))
  if (change === 'missing-peer')
    for (const i of f.items.filter(
      (i: { rect: number[] }) => i.rect[1] < 650 && i.rect[0] > 678 && i.rect[0] < 745
    ))
      i.text = 'unknown'
  if (change === 'non-numeric')
    f.items.findLast((i: { text: string }) => i.text === '15 (88%)').text = 'unknown'
  if (change === 'unowned-prose')
    f.items.push({ ...f.items.at(-1), text: 'comment', rect: [200, 672, 240, 687], baseline: 687 })
  if (change === 'conflicting-rule') f.rules.push([102, 675, 1124, 675])
  if (change === 'far-tail') last.rect[3] -= 10
  if (change === 'already-owned') f.rows.at(-2).rect[3] = 686
  repairWrappedTableRows(f)
  expect(last.rect[3]).toBe(change === 'far-tail' ? bottom - 10 : bottom)
})

it.each([
  'missing-peers',
  'not-indented',
  'incomplete-record',
  'conflicting-rule',
  'duplicate-owner'
])('does not split a section without repeated independent owners: %s', (change) => {
  const f = rowInput(),
    section = f.items.find((i: { text: string }) => i.text === 'Histological subtype')
  if (change === 'missing-peers')
    for (const i of f.items.filter((i: { text: string }) =>
      ['Menopausal status', 'Treatment received'].includes(i.text)
    )) {
      i.rect[0] -= 8
      i.rect[2] -= 8
    }
  if (change === 'not-indented') section.rect[0] += 10
  if (change === 'incomplete-record')
    f.items.find((i: { text: string }) => i.text === '37 (54%)').text = 'unverified'
  if (change === 'conflicting-rule') f.rules.push([102, 342, 1124, 342])
  if (change === 'duplicate-owner')
    f.rows.push(
      structuredClone(f.rows.find((r: { rect: number[] }) => r.rect[1] < 344 && r.rect[3] > 344))
    )
  const before = structuredClone(f.rows)
  recoverProjectedSectionRows(f)
  expect(f.rows).toEqual(before)
})
