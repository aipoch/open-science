import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-evidence.mjs')).href
)
const item = (
  text: string,
  x: number,
  y: number,
  width: number
): { text: string; rect: number[]; height: number; horizontal: boolean; baseline: number } => ({
  text,
  rect: [x, y, x + width, y + 10],
  height: 10,
  horizontal: true,
  baseline: y + 10
})
const table = (
  grid: string[][]
): {
  grid: string[][]
  rows: { rect: number[] }[]
  cropRect: number[]
  cells: {
    text: string
    row: number
    column: number
    rowSpan: number
    colSpan: number
    rect: number[]
  }[]
  unassigned: string[]
  repairs: string[]
  issues: string[]
} => ({
  grid,
  rows: grid.map((_, i) => ({ rect: [50, 100 + i * 20, 550, 115 + i * 20] })),
  cropRect: [50, 90, 550, 200],
  cells: grid.flatMap((r, row) =>
    r.map((text, column) => ({
      text,
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [50 + column * 250, 100 + row * 20, 300 + column * 250, 115 + row * 20]
    }))
  ),
  unassigned: [],
  repairs: [],
  issues: []
})
it('rejects a centered display equation and its right-hand equation ordinal', () => {
  const t = table([['u = v + w', '(7.2)']])
  const tokens = [item('u = v + w', 210, 100, 90), item('(7.2)', 520, 100, 25)]
  expect(hasTableEvidence(t, undefined, tokens)).toBe(false)
  expect(hasTableEvidence(t, { lines: ['Table 4. Native formulas.'] }, tokens)).toBe(true)
})

it('rejects an uncaptained equation band that the detector split into table columns', () => {
  const t = table([
    ['(4.5)', 's21(u) = f(u)d1(u),', 's22(u) = d2(u) + f(u)d1(u)e12(u),'],
    ['(4.6)', 's31(u) = g(u)d1(u),', 's32(u) = b(u)d2(u) + g(u)d1(u)e12(u),']
  ])
  const tokens = [
    item('(4.5)', 60, 100, 30),
    item('s21(u) = f(u)d1(u),', 140, 100, 120),
    item('s22(u) = d2(u) + f(u)d1(u)e12(u),', 300, 100, 180),
    item('(4.6)', 60, 120, 30),
    item('s31(u) = g(u)d1(u),', 140, 120, 120),
    item('s32(u) = b(u)d2(u) + g(u)d1(u)e12(u),', 300, 120, 180)
  ]
  expect(hasTableEvidence(t, undefined, tokens, [])).toBe(false)
})

it('retains an uncaptained payoff matrix with explicit row labels', () => {
  const t = table([
    ['leader pauses', '(C_A, C_B)', '(S_A, T_B)'],
    ['leader advances', '(T_A, S_B)', '(R_A, R_B)']
  ])
  const tokens = [
    item('leader pauses', 60, 100, 100),
    item('(C_A, C_B)', 220, 100, 70),
    item('(S_A, T_B)', 360, 100, 70),
    item('leader advances', 60, 120, 120),
    item('(T_A, S_B)', 220, 120, 70),
    item('(R_A, R_B)', 360, 120, 70)
  ]
  expect(hasTableEvidence(t, undefined, tokens, [])).toBe(true)
})

it('retains formula-valued records whose numeric column is not an equation ordinal', () => {
  const t = table([
    ['x = 1', '12'],
    ['y = 2', '24'],
    ['z = 3', '36']
  ])
  const tokens = [
    item('x = 1', 60, 100, 60),
    item('12', 220, 100, 20),
    item('y = 2', 60, 120, 60),
    item('24', 220, 120, 20),
    item('z = 3', 60, 140, 60),
    item('36', 220, 140, 20)
  ]
  expect(hasTableEvidence(t, undefined, tokens, [])).toBe(true)
})

it('rejects an uncaptained multi-row equation system split into detector columns', () => {
  const t = table([
    ['u(x) >= psi(x)', 'x in Omega', ''],
    ['-nabla dot A(u) + 1 = 0', 'x in Omega', '(38)'],
    ['u(x) - psi(x) = 0', 'x in boundary', ''],
    ['u(x) >= psi(x)', 'x in Omega', '']
  ])
  expect(hasTableEvidence(t, undefined, [])).toBe(false)
  expect(hasTableEvidence(t, { lines: ['Table 1. Equations'] }, [])).toBe(true)
})

it('rejects equation systems whose ordinal is attached to a condition cell', () => {
  const t = table([
    ['domain x = y', '0 < x < 1. (41)'],
    ['du/dt - laplace u = 0', 'x in Omega(t), t in (0, 1],'],
    ['u(s) = 0', '0 < x < 1, (42)']
  ])
  expect(hasTableEvidence(t, undefined, [])).toBe(false)
})
it('rejects continuous source prose fragmented across model columns', () => {
  const t = table([
    ['This native paragraph', 'continues across the predicted cut.'],
    ['A second native line', 'also continues across the predicted cut.']
  ])
  const tokens = [
    item('This native paragraph continues across the predicted cut.', 60, 100, 460),
    item('A second native line also continues across the predicted cut.', 60, 120, 460)
  ]
  expect(hasTableEvidence(t, undefined, tokens)).toBe(false)
})
it('preserves independent numerical records and a genuine separated description table', () => {
  const t = table([
    ['Alpha', '2.7'],
    ['Beta', '3.8']
  ])
  expect(
    hasTableEvidence(t, undefined, [
      item('Alpha', 60, 100, 60),
      item('2.7', 350, 100, 20),
      item('Beta', 60, 120, 50),
      item('3.8', 350, 120, 20)
    ])
  ).toBe(true)
  const qualitative = table([
    ['Alpha native heading', 'An independent description.'],
    ['Beta native heading', 'A second independent description.']
  ])
  expect(
    hasTableEvidence(qualitative, undefined, [
      item('Alpha native heading', 60, 100, 180),
      item('An independent description.', 350, 100, 190),
      item('Beta native heading', 60, 120, 170),
      item('A second independent description.', 350, 120, 190)
    ])
  ).toBe(true)
})

it('rejects a single-column derivation underneath a caption reserved for the next page', () => {
  const t = table([
    ['A native paragraph begins with several ordinary words.'],
    ['The same paragraph continues across the entire detector.'],
    ['A third native line provides the following equations:'],
    ['u = 0, v = 0 (9)']
  ])
  t.cells.forEach((c) => (c.rect[2] = 550))
  const tokens = [
    item(t.grid[0][0], 60, 100, 460),
    item(t.grid[1][0], 60, 120, 460),
    item(t.grid[2][0], 60, 140, 430),
    item('u = 0, v = 0', 80, 160, 110),
    item('(9)', 520, 160, 25)
  ]
  const caption = { page: 1, lines: ['Table 4. Native descriptors.'], rect: [40, 135, 220, 145] }
  expect(hasTableEvidence(t, caption, tokens, [])).toBe(false)
  expect(
    hasTableEvidence(t, caption, tokens, [
      [50, 95, 550, 95],
      [50, 180, 550, 180]
    ])
  ).toBe(true)
  expect(hasTableEvidence(t, caption, tokens)).toBe(true)
})

it('rejects prose with a display equation when a coarse model crop overlaps the following caption', () => {
  const tokens = [
      item('A bounded derivation starts with several ordinary words.', 10, 20, 180),
      item('The next paragraph discusses additional ordinary variables.', 10, 35, 180),
      item('A final statement uses complete ordinary explanatory words.', 10, 50, 180),
      item('q = r + s = u', 20, 80, 90),
      item('(4)', 190, 80, 15)
    ],
    grid = tokens
      .slice(0, 3)
      .map((i) => [i.text])
      .concat([['q = r + s = u (4)']]),
    t = {
      ...table(grid),
      cropRect: [0, 10, 220, 120],
      cells: tokens
        .slice(0, 3)
        .map((i, row) => ({ row, column: 0, text: i.text, sourceRects: [i.rect] }))
        .concat([
          { row: 3, column: 0, text: grid[3][0], sourceRects: tokens.slice(3).map((i) => i.rect) }
        ])
    },
    caption = {
      lines: ['Table 7. Example native records.'],
      rect: [0, 110 / 1.5, 220 / 1.5, 120 / 1.5]
    }
  expect(hasTableEvidence(t, caption, tokens, [])).toBe(false)
  expect(
    hasTableEvidence(t, caption, tokens, [
      [0, 10, 220, 10],
      [0, 105, 220, 105]
    ])
  ).toBe(true)
  expect(hasTableEvidence({ ...t, cells: [] }, caption, tokens, [])).toBe(true)
  expect(hasTableEvidence(t, caption, tokens.slice(0, -1), [])).toBe(true)
  expect(hasTableEvidence(t, { ...caption, rect: [0, 0, 220 / 1.5, 8 / 1.5] }, tokens, [])).toBe(
    true
  )
  expect(
    hasTableEvidence({ ...t, grid: [['Label'], ['1'], ['2'], ['3']] }, caption, tokens, [])
  ).toBe(true)
})

it('rejects independently numbered equivalence displays with letter-suffixed ordinals', () => {
  const t = table([
    ['f(u)', '↔', 'g(u)', '(12a)'],
    ['h(u)', '↔', 'p(u) = q(u)', '(12b)']
  ])
  const tokens = [
    item('f(u)', 100, 100, 35),
    item('↔', 180, 100, 10),
    item('g(u)', 220, 100, 35),
    item('(12a)', 500, 100, 35),
    item('h(u)', 100, 120, 35),
    item('↔', 180, 120, 10),
    item('p(u)', 220, 120, 35),
    item('=', 270, 120, 10),
    item('q(u)', 290, 120, 35),
    item('(12b)', 500, 120, 35)
  ]
  expect(hasTableEvidence(t, undefined, tokens, [])).toBe(false)
  expect(
    hasTableEvidence(t, { lines: ['Table 1: Defined mathematical records.'] }, tokens, [])
  ).toBe(true)
  expect(hasTableEvidence(t, undefined, tokens, [[50, 95, 550, 95]])).toBe(true)
  const unaligned = tokens.map((i) => (i.text === '(12b)' ? { ...i, baseline: 180 } : i))
  expect(hasTableEvidence(t, undefined, unaligned, [])).toBe(true)
})

function proseDisplayFolio(): {
  t: ReturnType<typeof table> & { page: number }
  tokens: (ReturnType<typeof item> & {
    sourceItem: { pageNumber: number; index: number; text: string }
  })[]
} {
  const t = {
    ...table([
      ['provides an equivalence between', 'native categories', ''],
      ['a(u) : P(u)', '≃', 'Q(u).'],
      ['', '', ''],
      ['', '6', '']
    ]),
    page: 6,
    cropRect: [50, 90, 550, 190]
  }
  const raw = [
    item('Corollary 2.3. A native construction', 60, 65, 230),
    item('provides an equivalence between', 60, 100, 160),
    item('native categories', 225, 100, 95),
    item('a(u)', 150, 130, 25),
    item(':', 180, 130, 5),
    item('P(u)', 200, 130, 25),
    item('≃', 240, 130, 10),
    item('Q(u)', 265, 130, 25),
    item('.', 290, 130, 3),
    item('6', 295, 165, 10)
  ]
  const tokens = raw.map((i, index) => ({
    ...i,
    sourceItem: { pageNumber: 6, index, text: i.text }
  }))
  return { t, tokens }
}
it('rejects a theorem prose tail, one display and the terminal native folio', () => {
  const { t, tokens } = proseDisplayFolio()
  expect(hasTableEvidence(t, undefined, tokens, [])).toBe(false)
  expect(hasTableEvidence({ ...t, page: undefined }, undefined, tokens, [])).toBe(false)
  expect(hasTableEvidence(t, { lines: ['Table 1: Formula records.'] }, tokens, [])).toBe(true)
  expect(hasTableEvidence(t, undefined, tokens, [[50, 95, 550, 95]])).toBe(true)
})
it.each([
  'different folio',
  'missing theorem',
  'missing source',
  'another record',
  'incomplete display'
])('does not infer a theorem tail with %s', (name) => {
  const { t, tokens } = proseDisplayFolio()
  if (name === 'different folio') tokens.at(-1)!.text = '7'
  if (name === 'missing theorem') tokens.shift()
  if (name === 'missing source') tokens[1].sourceItem.pageNumber = 7
  if (name === 'another record')
    tokens.push({
      ...item('Another native record', 60, 180, 160),
      sourceItem: { pageNumber: 6, index: 20, text: 'Another native record' }
    })
  if (name === 'incomplete display')
    tokens.splice(
      tokens.findIndex((i) => i.text === '.'),
      1
    )
  expect(hasTableEvidence(t, undefined, tokens, [])).toBe(true)
})
