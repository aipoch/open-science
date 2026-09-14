import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const token = (
  text: string,
  x: number,
  y: number,
  width = 30
): {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
} => ({ text, rect: [x, y, x + width, y + 10], baseline: y + 10, height: 10, horizontal: true })

it('uses an inset underline to exclude the stub and preserves the raised header note', () => {
  const xs = [0, 200, 300, 400, 500, 600]
  const table = {
    cropRect: [0, 0, 600, 80],
    structure: {
      objects: [
        ...xs.slice(1).map((x, c) => ({ label: 'table column', rect: [xs[c], 0, x, 80] })),
        ...[
          [10, 20],
          [30, 45],
          [55, 70]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 600, b] })),
        { label: 'table column header', rect: [0, 10, 600, 45] },
        { label: 'table spanning cell', rect: [0, 10, 600, 20] }
      ]
    }
  }
  const items = [
    token('Study group', 345, 10, 120),
    { ...token('a', 465, 9.5, 4), rect: [465, 9.5, 469, 15.5], baseline: 15.5, height: 6 },
    ...['Variable', 'Control', 'Treatment', 'Other', 'P-value'].map((s, c) =>
      token(s, xs[c] + 25, 30, 40)
    ),
    token('Age', 10, 55),
    ...[40, 41, 42, 0.5].map((n, c) => token(String(n), xs[c + 1] + 25, 55, 30))
  ]
  const result = refineTable(table, items, [], [], [[210, 25, 600, 25]])
  expect(result.cells.find((c: { text: string }) => c.text === 'Study groupa')).toMatchObject({
    column: 1,
    colSpan: 4,
    textRuns: [
      { text: 'Study group', position: 'normal' },
      { text: 'a', position: 'superscript' }
    ]
  })
  expect(result.unassigned).toEqual([])
  const unsupported = refineTable(table, items, [], [], [])
  expect(
    unsupported.cells.some(
      (c: { text: string; column: number; colSpan: number }) =>
        c.text === 'Study groupa' && c.column === 1 && c.colSpan === 4
    )
  ).toBe(false)
})

it('recovers an indented acronym continuation after a conjunction across a model gap', () => {
  const table = {
    cropRect: [0, 0, 450, 80],
    structure: {
      objects: [
        ...[
          [0, 250],
          [250, 350],
          [350, 450]
        ].map(([a, b]) => ({ label: 'table column', rect: [a, 0, b, 80] })),
        ...[
          [0, 20],
          [25, 40],
          [50, 70]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 450, b] }))
      ]
    }
  }
  const items = [
    token('First question', 10, 0, 180),
    token('T', 270, 0, 10),
    token('90', 370, 0, 20),
    token('A woman has', 10, 25, 75),
    token('a gene or', 90, 25, 60),
    token('T', 270, 25, 10),
    token('100', 370, 25, 25),
    token('BRCA2 can still occur', 20, 38, 150),
    token('Next question', 10, 50, 180),
    token('F', 270, 50, 10),
    token('80', 370, 50, 20)
  ]
  const result = refineTable(table, items, [], [], [])
  expect(result.grid[1][0]).toBe('A woman has a gene or BRCA2 can still occur')
  expect(result.grid[2][0]).toBe('Next question')
  for (const [source, rules] of [
    [items.map((i) => (i.text === 'a gene or' ? { ...i, text: 'a gene.' } : i)), []],
    [items, [[0, 37, 250, 37]]]
  ] as const) {
    const uncertain = refineTable(table, source, [], [], rules)
    expect(uncertain.unassigned).toContain('BRCA2 can still occur')
  }
})

it('keeps a centered sample-size continuation with its model group header', () => {
  const table = {
    cropRect: [0, 0, 500, 130],
    structure: {
      objects: [
        ...Array.from({ length: 5 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, c * 100 + 100, 130]
        })),
        ...[
          [0, 20],
          [30, 65],
          [70, 90],
          [100, 120]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 500, b] })),
        { label: 'table column header', rect: [0, 0, 500, 90] },
        { label: 'table spanning cell', rect: [100, 30, 300, 65] },
        { label: 'table spanning cell', rect: [300, 30, 500, 65] }
      ]
    }
  }
  const items = [
    token('Study group', 260, 0, 80),
    token('Counselor', 150, 30, 45),
    token('+', 198, 30, 5),
    token('Controls', 206, 30, 45),
    token('(n', 181, 50, 12),
    token('=', 195, 50, 5),
    token('42)', 203, 50, 17),
    token('Computer (n = 29)', 350, 50, 100),
    ...['Before', 'After', 'Before', 'After'].map((s, c) => token(s, 130 + c * 100, 70, 40)),
    token('Tested', 10, 100, 40),
    ...[32, 25, 28, 14].map((n, c) => token(String(n), 140 + c * 100, 100, 20))
  ]
  const rules = [
    [100, 25, 500, 25],
    [100, 68, 500, 68]
  ]
  const result = refineTable(table, items, [], [], rules)
  expect(
    result.cells.find((c: { text: string }) => c.text === 'Counselor + Controls (n = 42)')
  ).toMatchObject({
    column: 1,
    colSpan: 2
  })
  expect(result.cells.find((c: { text: string }) => c.text === 'Study group')).toMatchObject({
    column: 1,
    colSpan: 4
  })
  expect(result.issues).toEqual([])
  for (const [source, borders] of [
    [items.map((i) => (i.text === '42)' ? { ...i, text: 'years)' } : i)), rules],
    [items, []]
  ] as const) {
    const uncertain = refineTable(table, source, [], [], borders)
    expect(uncertain.issues).toContain('span-conflicts-with-source-columns')
  }
})

it('uses parent underlines ending at wider body values to constrain header spans', () => {
  const table = {
    cropRect: [0, 0, 700, 80],
    structure: {
      objects: [
        ...Array.from({ length: 7 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, (c + 1) * 100, 80]
        })),
        ...Array.from({ length: 4 }, (_, r) => ({
          label: 'table row',
          rect: [0, r * 20, 700, r * 20 + 10]
        })),
        { label: 'table column header', rect: [0, 0, 700, 30] },
        { label: 'table spanning cell', rect: [0, 0, 400, 10] },
        { label: 'table spanning cell', rect: [400, 0, 700, 10] }
      ]
    }
  }
  const items = [
    token('Status', 210, 0, 70),
    token('Status', 510, 0, 70),
    ...['Size', 'Treatment', 'N+', 'N−', 'Control', 'N+', 'N−'].map((s, c) =>
      token(s, c * 100 + 10, 20)
    ),
    ...Array.from({ length: 7 }, (_, c) =>
      token('8 (50%)', c * 100 + 10, 40, c === 3 || c === 6 ? 86 : 50)
    ),
    ...Array.from({ length: 7 }, (_, c) => token('4', c * 100 + 10, 60))
  ]
  const rules = [
    [210, 15, 398, 15],
    [510, 15, 698, 15]
  ]
  const result = refineTable(table, items, [], [], rules)
  expect(
    result.cells
      .filter((c: { text: string }) => c.text === 'Status')
      .map((c: { column: number; colSpan: number }) => [c.column, c.colSpan])
  ).toEqual([
    [2, 2],
    [5, 2]
  ])
  const unrelated = refineTable(
    table,
    items,
    [],
    [],
    [
      [210, 15, 475, 15],
      [510, 15, 750, 15]
    ]
  )
  expect(
    unrelated.cells.filter((c: { origin: string }) => c.origin === 'ruled-header-span')
  ).toEqual([])
})

it('joins repeated empty stub bands only to indented lowercase labels with complete values', () => {
  const table = {
    cropRect: [0, 0, 300, 100],
    structure: {
      objects: [
        ...Array.from({ length: 3 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, (c + 1) * 100, 100]
        })),
        ...[0, 20, 36, 55, 71].map((y) => ({ label: 'table row', rect: [0, y, 300, y + 10] })),
        { label: 'table projected row header', rect: [0, 20, 300, 30] },
        { label: 'table projected row header', rect: [0, 55, 300, 65] }
      ]
    }
  }
  const items = [
    token('Outcome', 0, 0, 50),
    token('Group A', 110, 0, 50),
    token('Group B', 210, 0, 50),
    token('Discharged after surgery', 0, 20, 90),
    token('day 3', 8, 36),
    token('20 (80)', 110, 36),
    token('19 (76)', 210, 36),
    token('Discharged after surgery', 0, 55, 90),
    token('day 4', 8, 71),
    token('5 (20)', 110, 71),
    token('6 (24)', 210, 71)
  ]
  const result = refineTable(table, items)
  expect(result.grid).toEqual([
    ['Outcome', 'Group A', 'Group B'],
    ['Discharged after surgery day 3', '20 (80)', '19 (76)'],
    ['Discharged after surgery day 4', '5 (20)', '6 (24)']
  ])
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  const incomplete = refineTable(
    table,
    items.filter((i) => i.text !== '19 (76)')
  )
  expect(incomplete.grid.some((r: string[]) => r[0] === 'Discharged after surgery')).toBe(true)
  const section = refineTable(
    table,
    items.map((i) => (i.text === 'day 3' ? { ...i, text: 'Day 3' } : i))
  )
  expect(section.grid.some((r: string[]) => r[0] === 'Discharged after surgery')).toBe(true)
})
