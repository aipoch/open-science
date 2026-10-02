import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeHeaderOwnershipGrid: recover } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-ownership.mjs')).href
)
const load = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/centered-native-group-stubs.jsonl')
  )
const token = (
  text: string,
  x: number,
  end: number,
  y: number
): ReturnType<typeof readPdfFixture> => ({
  text,
  rect: [x, y - 10, end, y],
  baseline: y,
  height: 10,
  horizontal: true,
  font: 'Fixture-Regular'
})
const settings = (): ReturnType<typeof readPdfFixture> => {
  const f = load()
  f.tokens = f.tokens.slice(0, 4)
  f.table.cropRect = [0, 20, 240, 248]
  f.rules = [
    [0, 20, 240, 20],
    [0, 40, 240, 40],
    [0, 110, 240, 110],
    [0, 180, 240, 180],
    [0, 248, 240, 248]
  ]
  for (let g = 0; g < 3; g++) {
    f.tokens.push(
      token(['Amber setting', 'Azure setting', 'Coral'][g], 5, g < 2 ? 110 : 40, 50 + g * 70)
    )
    for (let r = 0; r < 3; r++) {
      f.tokens.push(token(['Lavender', 'Lilac', 'Indigo'][r], 5, 48, 65 + g * 70 + r * 15))
      for (let c = 1; c < 4; c++)
        f.tokens.push(
          token(
            String(31 + g * 11 + r * 4 + c),
            [0, 65, 120, 180][c] + 12,
            [0, 65, 120, 180][c] + 24,
            65 + g * 70 + r * 15
          )
        )
    }
  }
  return f
}
it('keeps ruled full-width setting rows including a short matching peer without swallowing complete numeric records', () => {
  const f = settings(),
    result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid).toHaveLength(13)
  expect(
    result.cells
      .filter((c: { colSpan: number }) => c.colSpan === 4)
      .map((c: { row: number; text: string }) => [c.row, c.text])
  ).toEqual([
    [1, 'Amber setting'],
    [5, 'Azure setting'],
    [9, 'Coral']
  ])
  expect(result.grid[2]).toEqual(['Lavender', '32', '33', '34'])
  expect(result.grid[12]).toEqual(['Indigo', '62', '63', '64'])
  expect(result.unassigned).toHaveLength(0)
})
it.each([
  'one wide peer',
  'missing setting divider',
  'foreign interposed ink',
  'mismatched font size'
])('does not infer full-width setting scope from %s', (variant) => {
  const f = settings()
  if (variant === 'one wide peer')
    f.tokens.find((i: { text: string }) => i.text === 'Azure setting').rect[2] = 40
  if (variant === 'missing setting divider') f.rules.splice(2, 1)
  if (variant === 'foreign interposed ink') f.tokens.push(token('Foreign', 140, 175, 120))
  if (variant === 'mismatched font size')
    f.tokens.find((i: { text: string }) => i.text === 'Coral').height = 7
  const plan = recover(f.table, f.tokens, f.captions, f.rules)
  expect(
    plan?.spans.some((s: { colSpan: number; row: number }) => s.row === 9 && s.colSpan === 4) ??
      false
  ).toBe(false)
})

const prose = (): ReturnType<typeof readPdfFixture> => {
  const f = load()
  f.table.cropRect = [0, 20, 240, 190]
  f.table.structure.objects = f.table.structure.objects.filter(
    (o: { label: string }) => o.label !== 'table column'
  )
  for (let c = 0; c < 3; c++)
    f.table.structure.objects.push({
      label: 'table column',
      score: 0.99,
      rect: [c * 80, 0, c * 80 + 80, 170]
    })
  f.rules = [20, 40, 90, 140, 190].map((y) => [0, y, 240, y])
  f.tokens = ['Category', 'Detail', 'Summary'].map((text, c) =>
    token(text, c * 80 + 5, c * 80 + 60, 32)
  )
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let n = 0; n < 2; n++)
        f.tokens.push(
          token(
            ['Amber detail', 'Azure detail', 'Coral detail'][c],
            c * 80 + 5,
            c * 80 + 60,
            60 + r * 50 + n * 15
          )
        )
  return f
}
it('separates a single native header face from multiline descriptions in every following face', () => {
  const f = prose(),
    result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid[0]).toEqual(['Category', 'Detail', 'Summary'])
  expect(result.grid).toHaveLength(4)
  expect(result.grid.slice(1)).toEqual(
    Array.from({ length: 3 }, () => [
      'Amber detail Amber detail',
      'Azure detail Azure detail',
      'Coral detail Coral detail'
    ])
  )
  expect(result.unassigned).toHaveLength(0)
})
it.each([
  'missing header boundary',
  'empty description lane',
  'crossing face center',
  'foreign edge'
])('declines unproved prose header faces: %s', (variant) => {
  const f = prose()
  if (variant === 'missing header boundary') f.rules.splice(1, 1)
  if (variant === 'empty description lane')
    f.tokens = f.tokens.filter(
      (i: { rect: number[]; baseline: number }) =>
        !(i.rect[0] > 160 && i.baseline > 40 && i.baseline < 90)
    )
  if (variant === 'crossing face center') f.tokens[3].rect[1] = 20
  if (variant === 'foreign edge') f.tokens.push(token('Foreign', 230, 250, 75))
  expect(recover(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})
