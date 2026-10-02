import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { recoverNativeHeaderOwnershipGrid: recover } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-ownership.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
type Fixture = ReturnType<typeof readPdfFixture>
const token = (text: string, x: number, right: number, y: number): object => ({
  text,
  rect: [x, y - 10, right, y],
  baseline: y,
  height: 10,
  horizontal: true,
  font: 'Fixture-Regular'
})
const compound = (grouped = false): Fixture => {
  const cuts = grouped ? [0, 41, 67, 106, 145, 184, 240] : [0, 53, 94, 180, 240]
  const top = 20,
    footer = grouped ? 152 : 112
  const f: Fixture = {
    table: {
      id: 'anonymous-table',
      page: 1,
      cropRect: [0, top, 240, footer],
      structure: {
        objects: [
          ...cuts.slice(1).map((x, c) => ({
            label: 'table column',
            score: 0.99,
            rect: [cuts[c], 0, x, footer - top]
          })),
          { label: 'table column header', score: 0.99, rect: [0, 0, 240, 20] },
          ...[20, 40, 60, 80].map((y) => ({
            label: 'table row',
            score: 0.99,
            rect: [0, y, 240, y + 20]
          }))
        ]
      }
    },
    tokens: [],
    captions: [
      { page: 1, lines: ['Table 1. Measured groups.'], rect: [0, footer - 2, 240, footer + 8] }
    ],
    rules: [20, 40, ...(grouped ? [96] : []), footer].map((y) => [0, y, 240, y])
  }
  f.tokens.push(token('Table 1. Measured groups.', 0, 240, footer + 8))
  if (grouped) {
    f.table.spans = [{ label: 'table spanning cell', score: 0.99, rect: [0, 0, 39, 74] }]
    for (const [c, text] of ['Category', 'Count', 'Mode', 'Leaf A', 'Leaf B', 'Leaf C'].entries())
      f.tokens.push(token(text, [5, 40, 73, 112, 151, 190][c], [35, 60, 100, 140, 180, 228][c], 32))
    for (let r = 0; r < 6; r++) {
      const y = 52 + r * 18
      if (r === 0 || r === 3) {
        f.tokens.push(token(r ? 'Group beta' : 'Group alpha', 5, 34, y), token('4', 50, 60, y))
      }
      f.tokens.push(token(['Low', 'Mid', 'High'][r % 3], 73, 97, y))
      for (let c = 0; c < 3; c++)
        f.tokens.push(token(String(20 + r + c), 115 + c * 39, 130 + c * 39, y))
    }
  } else {
    f.tokens.push(
      token('Category', 5, 40, 32),
      token('Index', 58, 82, 32),
      token('Score', 101, 132, 32),
      token('Best-', 153, 185, 32),
      token('score', 185, 231, 32)
    )
    for (let r = 0; r < 4; r++) {
      const y = 52 + r * 17
      f.tokens.push(
        token(`Item ${r}`, 5, 40, y),
        token(String(r + 1), 70, 80, y),
        token(String(31 + r), 115, 130, y),
        token(String(41 + r), 210, 229, y)
      )
    }
  }
  return f
}

it('keeps one contiguous compound leaf together while every complete record retains its lane', () => {
  const f = compound(),
    plan = recover(f.table, f.tokens, f.captions, f.rules)
  expect(plan?.headerRows).toEqual([0])
  expect(plan?.rows.at(-1)[3]).toBe(103)
  expect(plan?.cropRect[3]).toBe(112.5)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[0]).toEqual(['Category', 'Index', 'Score', 'Best-score'])
  expect(r.grid.slice(1).map((v: string[]) => v.slice(1))).toEqual([
    ['1', '31', '41'],
    ['2', '32', '42'],
    ['3', '33', '43'],
    ['4', '34', '44']
  ])
})
it('separates the header from repeated flush group labels and preserves their ruled spans', () => {
  const f = compound(true),
    plan = recover(f.table, f.tokens, f.captions, f.rules)
  expect(plan?.headerRows).toEqual([0])
  expect(plan?.spans).toContainEqual({ row: 1, column: 0, rowSpan: 3, colSpan: 1 })
  expect(plan?.spans).toContainEqual({ row: 4, column: 1, rowSpan: 3, colSpan: 1 })
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[0][0]).toBe('Category')
  expect(r.grid[1][0]).toBe('Group alpha')
  expect(r.unassigned).toHaveLength(0)
})
it.each([
  'missing footer',
  'caption above closing',
  'caption literal mismatch',
  'competing caption',
  'second tier',
  'foreign source',
  'body crosses repaired cut',
  'missing section'
])('rejects unresolved compound-leaf ownership: %s', (variant) => {
  const f = compound(variant === 'missing section')
  if (variant === 'missing footer') f.rules.pop()
  if (variant === 'caption above closing') f.tokens[0].baseline -= 12
  if (variant === 'caption literal mismatch') f.tokens[0].text += ' Extra'
  if (variant === 'competing caption') f.captions.push({ ...f.captions[0] })
  if (variant === 'second tier') f.tokens.push(token('Parent', 100, 231, 23))
  if (variant === 'foreign source') f.tokens.push(token('Foreign text', 80, 110, 111))
  if (variant === 'body crosses repaired cut')
    f.tokens.find((i: { text: string }) => i.text === '31').rect[2] = 178
  if (variant === 'missing section') f.rules.splice(2, 1)
  expect(recover(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})

const insetParents = (): Fixture => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/native-underlined-two-tier-numeric-header.jsonl'
    )
  )
  f.rules = [
    [0, 20, 240, 20],
    [71, 37, 145, 37],
    [153, 37, 236.1, 37],
    [0, 54, 240, 54],
    [0, 112, 240, 112]
  ]
  f.tokens = f.tokens.filter((i: { text: string }) => i.text !== 'Measure')
  for (const i of f.tokens.filter((i: { baseline: number }) => i.baseline > 54)) {
    if (i.rect[0] < 65) i.rect[2] = 64
    if (i.rect[0] === 75) i.rect = [70, i.rect[1], 82, i.rect[3]]
    if (i.rect[0] === 118) i.rect[2] = 146
    if (i.rect[0] === 161) i.rect = [152, i.rect[1], 164, i.rect[3]]
  }
  return f
}
it('proves two repeated symmetrically inset native parent underlines without vertical rules', () => {
  const f = insetParents()
  expect(recover(f.table, f.tokens, f.captions, f.rules)?.headerRows).toEqual([0, 1])
  expect(recover(f.table, f.tokens, f.captions, f.rules)?.columns[1][0]).toBe(67)
})
it.each(['unequal inset', 'missing parent', 'extra underline'])(
  'does not adopt repeated inset proof with %s',
  (variant) => {
    const f = insetParents()
    if (variant === 'unequal inset') f.rules[1][2] -= 3
    if (variant === 'missing parent') f.rules.splice(2, 1)
    if (variant === 'extra underline') f.rules.push([80, 37, 135, 37])
    expect(recover(f.table, f.tokens, f.captions, f.rules)?.columns[1][0]).not.toBe(67)
  }
)
