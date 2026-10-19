import { readPdfFixture } from './read-fixture'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/closed-parent-count-grid.jsonl'))
const parse = (x: ReturnType<typeof load>): ReturnType<typeof refineTable> =>
  refineTable(x.table, x.tokens, x.captions, [], x.rules)
it('uses closed source faces to remove a false stub column and recover both parent headers', () => {
  const x = load(),
    t = parse(x)
  expect(t.grid).toEqual([
    ['', 'Interruption', '', 'Discontinuation', ''],
    ['', 'EF-guided (n=8)', 'GLS-guided (n=5)', 'EF-guided (n=5)', 'GLS-guided (n=9)'],
    ['Adverse events / serious adverse effects', '1', '0', '1', '2'],
    ['Left ventricular dysfunction', '1', '3', '1', '2'],
    ['Chemotherapy side effect', '3', '1', '1', '4'],
    ['Other reasons', '3', '1', '2', '1']
  ])
  for (const text of ['Interruption', 'Discontinuation'])
    expect(t.cells).toContainEqual(
      expect.objectContaining({ text, row: 0, rowSpan: 1, colSpan: 2 })
    )
  expect(t.unassigned).toEqual([])
  expect(x).toEqual(load())
})
it.each(['broken-border', 'missing-value', 'extra-divider'])(
  'does not rebuild an ambiguous closed grid with %s',
  (condition) => {
    const x = load()
    if (condition === 'broken-border')
      x.rules = x.rules.filter(
        (r: number[]) => !(r[0] === r[2] && Math.abs(r[0] - 578.16) < 1 && r[1] > 595)
      )
    if (condition === 'missing-value')
      x.tokens = x.tokens.filter(
        (t: { rect: number[] }) => !(t.rect[0] > 600 && t.rect[1] > 590 && t.rect[1] < 625)
      )
    if (condition === 'extra-divider') x.rules.push([420, 270, 420, 290])
    expect(parse(x).repairs).not.toContain('closed-parent-grid-recovered')
  }
)

const { recoverClosedCellGrid } = await import(
  pathToFileURL(resolve('resources/literature-pdf-ruled-column-grid.mjs')).href
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- inferred anonymous fixture
function closedProseFixture() {
  const crop = [0, 0, 280, 180],
    xs = [0, 60, 200, 280],
    ys = [0, 30, 60, 90, 120, 150, 180],
    items: {
      text: string
      rect: number[]
      baseline?: number
      height?: number
      horizontal?: boolean
      sourceItem?: { pageNumber: number; index: number; text: string }
      sourceTokens?: unknown[]
    }[] = []
  const add = (text: string, rect: number[]): number =>
    items.push({
      text,
      rect,
      baseline: rect[3],
      height: 10,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: items.length, text }
    })
  add('Group A', [5, 8, 45, 18])
  add('Group B', [5, 98, 45, 108])
  for (let n = 0; n < 6; n++) {
    add('Complete description', [70, n * 30 + 8, 180, n * 30 + 18])
    add('Source detail', [210, n * 30 + 8, 270, n * 30 + 18])
  }
  const rules = [
    ...xs.map((x) => [x, 0, x, 180]),
    ...ys.map((y) => [y % 90 === 0 ? 0 : 60, y, 280, y])
  ]
  const objects = [
    ...[0, 30, 60, 90, 120, 150].map((y) => ({
      label: 'table row',
      score: 1,
      rect: [0, y, 280, y + 30]
    })),
    ...[
      [0, 90],
      [70, 230],
      [190, 280]
    ].map(([l, r]) => ({ label: 'table column', score: 1, rect: [l, 0, r, 180] }))
  ]
  return {
    table: {
      id: 'anonymous-native-faces',
      cropRect: crop,
      detection: { label: 'table', score: 1, rect: crop },
      structure: { objects }
    },
    items,
    rules,
    captions: []
  }
}
it.each([
  'complete-grid',
  'no-rules',
  'missing-outer',
  'missing-body-face',
  'foreign-ink',
  'rotated-font',
  'external-alias',
  'crossing-face',
  'full-width-prose-box',
  'independent-no-shared-stub',
  'diagonal-rule',
  'malformed-ink',
  'nonrectangular-connection',
  'blank-stubs'
])('preserves closed captionless prose faces only with complete native proof: %s', (name) => {
  const x = closedProseFixture()
  if (name === 'no-rules') x.rules = []
  if (name === 'missing-outer') x.rules = x.rules.filter((r) => r[0] !== 280 || r[2] !== 280)
  if (name === 'missing-body-face')
    x.rules = x.rules.map((r) => (r[1] === 30 && r[3] === 30 ? [200, 30, 280, 30] : r))
  if (name === 'foreign-ink') x.items.push({ text: '?', rect: [72, 20, 78, 25], horizontal: false })
  if (name === 'rotated-font') x.items[2].horizontal = false
  if (name === 'external-alias')
    x.items.push({
      text: 'outside',
      rect: [300, 0, 320, 10],
      sourceTokens: [{ sourceItem: { ...x.items[2].sourceItem } }]
    })
  if (name === 'crossing-face') x.items[2].rect[3] = 32
  if (name === 'full-width-prose-box') x.rules = x.rules.filter((r) => r[0] === 0 || r[0] === 280)
  if (name === 'independent-no-shared-stub')
    x.rules = x.rules.map((r) => (r[1] === r[3] ? [0, r[1], 280, r[3]] : r))
  if (name === 'diagonal-rule') x.rules.push([70, 20, 160, 80])
  if (name === 'malformed-ink')
    x.items.push({ text: '?', rect: [NaN, 20, 78, 25], horizontal: true })
  if (name === 'nonrectangular-connection')
    x.rules = x.rules.map((r) => (r[1] === 30 && r[3] === 30 ? [200, 30, 280, 30] : r))
  if (name === 'blank-stubs') x.items = x.items.slice(2)
  const plan = recoverClosedCellGrid(x.table, x.items, x.captions, x.rules),
    accepted = plan?.repair === 'native-closed-prose-faces-recovered'
  expect(accepted).toBe(name === 'complete-grid')
  if (accepted) {
    const actual = refineTable(x.table, x.items, [], [], x.rules)
    expect(actual.grid).toHaveLength(6)
    expect(actual.grid[0]).toHaveLength(3)
    expect(actual.unassigned).toHaveLength(0)
    expect(
      actual.cells.filter(
        (c: { rowSpan: number; column: number }) => c.rowSpan === 3 && c.column === 0
      )
    ).toHaveLength(2)
  }
})
