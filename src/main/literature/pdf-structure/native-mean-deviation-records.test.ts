import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { recoverNativeMeanDeviationRecords } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-mean-deviation-records.mjs'))
    .href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
type Token = { text: string; rect: number[]; height: number; baseline: number; horizontal: boolean }
type Model = {
  id: string
  cropRect: number[]
  structure: { objects: { label: string; score: number; rect: number[] }[] }
}
type Caption = { page: number; lines: string[]; rect: number[] }
const input = (): { tokens: Token[]; rules: number[][]; tables: Model[]; captions: Caption[] } => {
  const tokens: Token[] = [],
    rules: number[][] = []
  const token = (text: string, x: number, y: number, width = 25): void => {
    tokens.push({
      text,
      rect: [x, y - 10, x + width, y],
      height: 10,
      baseline: y,
      horizontal: true
    })
  }
  for (const y of [100, 120, 160, 230]) rules.push([0, y, 400, y])
  for (const y of [240, 260, 300, 350]) rules.push([-20, y, 420, y])
  for (const y of [140, 280]) rules.push([210, y, 285, y], [315, y, 390, y])
  token('Summary', 160, 115, 60)
  token('Group A', 225, 135, 45)
  token('Group B', 330, 135, 45)
  for (const [text, x, w] of [
    ['Policy', 10, 35],
    ['Setting', 90, 40],
    ['Measure', 235, 40],
    ['Measure', 335, 40]
  ] as const)
    token(text, x, 155, w)
  for (let n = 0; n < 4; n++) {
    token('Choice', 10, 175 + n * 14, 40)
    token('Level', 90, 175 + n * 14, 30)
    token('1.20±0.30', 225, 175 + n * 14, 55)
    token('2.40±0.50', 325, 175 + n * 14, 55)
  }
  token('Coefficients', 140, 255, 80)
  token('Group A', 225, 275, 45)
  token('Group B', 330, 275, 45)
  for (const [text, x] of [
    ['Factor', 10],
    ['b', 210],
    ['SE', 230],
    ['t', 250],
    ['p', 270],
    ['b', 315],
    ['SE', 335],
    ['t', 355],
    ['p', 375]
  ] as const)
    token(text, x, 295, 12)
  for (let n = 0; n < 2; n++) {
    token('Term', 10, 315 + n * 15, 25)
    for (const x of [210, 230, 250, 270, 315, 335, 355, 375]) token('.12', x, 315 + n * 15, 12)
  }
  const tables = [
    {
      id: 'native-model',
      cropRect: [-1, 95, 401, 233],
      structure: {
        objects: Array.from({ length: 4 }, (_, n) => ({
          label: 'table column',
          score: 1,
          rect: [n * 100, 0, (n + 1) * 100, 138]
        }))
      }
    }
  ]
  return {
    tokens,
    rules,
    tables,
    captions: [{ page: 1, lines: ['Table 1. Repeated native groups.'], rect: [0, 355, 400, 370] }]
  }
}
it('rebuilds complete native paired mean/deviation rows and whole-width title ownership', () => {
  const f = input(),
    snapshot = structuredClone(f),
    proof = recoverNativeMeanDeviationRecords(f.tables, f.tokens, f.captions, f.rules)
  expect(proof?.replacements).toHaveLength(1)
  expect(proof.replacements[0].original).toBe(f.tables[0])
  expect(proof.replacements[0].caption).toBe(f.captions[0])
  const result = refineTable(proof.replacements[0].table, f.tokens, f.captions, [], f.rules)
  expect(result.grid).toHaveLength(7)
  expect(result.grid[0]).toEqual(['Summary', '', '', ''])
  expect(
    result.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 0).colSpan
  ).toBe(4)
  expect(result.grid.slice(3)).toEqual(
    Array.from({ length: 4 }, () => ['Choice', 'Level', '1.20±0.30', '2.40±0.50'])
  )
  expect(result.unassigned).toEqual([])
  expect(result.clipped).toEqual([])
  expect(result.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).length).toBe(
    f.tokens.filter((i) => i.baseline < 230).length
  )
  expect(f).toEqual(snapshot)
})
it.each([
  'missing-footer',
  'missing-title',
  'missing-parent',
  'different-parent',
  'different-leaf',
  'incomplete-record',
  'too-few-rows',
  'unowned-body',
  'crossing-footer',
  'font-overhang',
  'competing-caption',
  'missing-caption',
  'distant-lower',
  'competing-model',
  'incomplete-lower-header'
])('does not repair an unproven native record block: %s', (variant) => {
  const f = input()
  if (variant === 'missing-footer') f.rules = f.rules.filter((r) => r[1] !== 230)
  if (variant === 'missing-title') f.tokens = f.tokens.filter((i) => i.text !== 'Summary')
  if (variant === 'missing-parent') f.rules = f.rules.filter((r) => !(r[0] === 210 && r[1] === 140))
  if (variant === 'different-parent')
    f.tokens.find((i) => i.text === 'Group A' && i.baseline === 275)!.text = 'Group C'
  if (variant === 'different-leaf')
    f.tokens.find((i) => i.text === 'Measure' && i.rect[0] === 335)!.text = 'Other'
  if (variant === 'incomplete-record') f.tokens.find((i) => i.text === '1.20±0.30')!.text = '1.20'
  if (variant === 'too-few-rows') f.tokens = f.tokens.filter((i) => i.baseline !== 217)
  if (variant === 'unowned-body')
    f.tokens.push({
      text: 'Unknown',
      rect: [145, 168, 165, 178],
      height: 10,
      baseline: 178,
      horizontal: true
    })
  if (variant === 'crossing-footer')
    f.tokens.push({
      text: 'Unknown',
      rect: [10, 222, 50, 231],
      height: 9,
      baseline: 229,
      horizontal: true
    })
  if (variant === 'font-overhang')
    f.tokens.find((i) => i.text === 'Group B' && i.baseline === 135)!.rect[2] = 400
  if (variant === 'competing-caption')
    f.captions.push({ ...f.captions[0], lines: ['Table 2. Competing.'] })
  if (variant === 'missing-caption') f.captions = []
  if (variant === 'distant-lower')
    for (const r of f.rules.filter((r) => r[1] >= 240)) {
      r[1] += 100
      r[3] += 100
    }
  if (variant === 'competing-model') f.tables.push({ ...f.tables[0], id: 'competitor' })
  if (variant === 'incomplete-lower-header')
    f.tokens = f.tokens.filter((i) => !(i.text === 'SE' && i.rect[0] === 335))
  const snapshot = structuredClone(f)
  expect(recoverNativeMeanDeviationRecords(f.tables, f.tokens, f.captions, f.rules)).toBeUndefined()
  expect(f).toEqual(snapshot)
})
