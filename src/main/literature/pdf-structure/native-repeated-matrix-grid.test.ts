import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pdfTextRunsSchema } from '../../../shared/pdf-structure'

const { nativeRepeatedMatrixCandidate } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-native-repeated-matrix-candidate.mjs')
  ).href
)
const { recoverNativeRepeatedMatrixParts } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-repeated-matrix-grid.mjs'))
    .href
)
type Token = { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }
type Input = { tokens: Token[]; rules: number[][]; captions: { lines: string[]; rect: number[] }[] }
function input(): Input {
  const tokens: Token[] = [],
    rules: number[][] = []
  const add = (text: string, x: number, y: number, w = 8): void => {
    tokens.push({ text, rect: [x, y - 10, x + w, y], baseline: y, height: 10, horizontal: true })
  }
  for (const l of [0, 160, 320]) {
    add('n', l + 50, 20, 5)
    add('=', l + 60, 20, 5)
    add('4', l + 70, 20, 5)
    for (const y of [30, 40, 94]) rules.push([l, y, l + 140, y])
    for (const [a, b] of [
      [30, 40],
      [40, 52],
      [52, 64],
      [64, 76],
      [76, 94]
    ])
      rules.push([l + 24, a, l + 24, b])
    add('R', l + 3, 38, 4)
    add('\\', l + 8, 38, 4)
    add('Q', l + 13, 38, 4)
    for (let k = 0; k < 5; k++) add(String(k + 1), l + 36 + k * 20, 38)
    for (let n = 0; n < 4; n++) {
      const y = 50 + n * 12
      add(String(n + 1), l + 5, y)
      for (let k = 0; k < 5; k++) add((1 + n / 10 + k / 100).toFixed(2), l + 36 + k * 20, y)
    }
  }
  return {
    tokens,
    rules,
    captions: [{ lines: ['Table 1. Repeated matrices.'], rect: [0, 0, 150, 5] }]
  }
}
type Candidate = {
  rect: number[]
  caption: Input['captions'][number]
  panels: {
    rect: number[]
    opening: number[]
    divider: number[]
    closing: number[]
    owned: Token[]
  }[]
}
function candidate(f: Input): Candidate {
  const c = nativeRepeatedMatrixCandidate(f.tokens, f.rules, f.captions, 480, 100)
  if (!c) throw new Error('The synthetic native matrix candidate must be complete')
  return c
}
it('adapts only complete native matrix panels into existing literal table parts', () => {
  const f = input(),
    original = structuredClone(f),
    c = candidate(f),
    r = recoverNativeRepeatedMatrixParts(c)
  expect(r.parts.map((p: { grid: string[][] }) => [p.grid.length, p.grid[0].length])).toEqual([
    [5, 6],
    [5, 6],
    [5, 6]
  ])
  expect(r.parts.map((p: { title: string }) => p.title)).toEqual(['n=4', 'n=4', 'n=4'])
  expect(r.ownedTokens.size).toBe(105)
  const cells = r.parts.flatMap(
    (p: { cells: { rect: number[]; sourceRects: number[][] }[] }) => p.cells
  )
  for (const cell of cells) expect(pdfTextRunsSchema.parse(cell.textRuns)).toEqual(cell.textRuns)
  expect(
    cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  ).toEqual([...r.cellTokens].map((i: Token) => JSON.stringify(i.rect.map((v) => v * 1.5))).sort())
  expect(
    cells.every((c: { rect: number[]; sourceRects: number[][] }) =>
      c.sourceRects.every(
        (s) => s[0] >= c.rect[0] && s[1] >= c.rect[1] && s[2] <= c.rect[2] && s[3] <= c.rect[3]
      )
    )
  ).toBe(true)
  expect(f).toEqual(original)
})
it('keeps a bounded header fontbox overhang only when native centers and a real source gutter agree', () => {
  const c = candidate(input())
  for (const p of c.panels) {
    for (const i of p.owned.filter((i: Token) => i.baseline === 38)) i.rect[1] = 29
    for (const i of p.owned.filter((i: Token) => i.baseline === 50)) i.rect[1] = 39
  }
  const r = recoverNativeRepeatedMatrixParts(c)
  expect(r).toBeDefined()
  expect(r.parts[0].cells[0].rect[1]).toBe(43.5)
  expect(r.parts[0].cells[0].rect[3]).toBe(57.75)
})
it.each([
  'record',
  'baseline',
  'header',
  'title',
  'rule',
  'duplicate',
  'overhang',
  'overlap',
  'center',
  'scale'
])('refuses an incomplete literal matrix adapter proof: %s', (change: string) => {
  const c = candidate(input()),
    p = c.panels[0]
  if (change === 'record')
    p.owned.splice(
      p.owned.findIndex((i: Token) => i.text === '1.00'),
      1
    )
  if (change === 'baseline') {
    const i = p.owned.find((i: Token) => i.text === '1.00')!
    i.baseline += 2
    i.rect[1] += 2
    i.rect[3] += 2
  }
  if (change === 'header')
    p.owned.find((i: Token) => i.text === '5' && i.baseline === 38)!.text = 'Other'
  if (change === 'title') p.owned.find((i: Token) => i.text === '=')!.text = 'Other'
  if (change === 'rule') p.divider = [0, 40, 139, 40]
  if (change === 'duplicate') p.owned.push(p.owned[8])
  if (change === 'overhang') p.owned.find((i: Token) => i.text === 'R')!.rect[1] = 27
  if (change === 'overlap') p.owned.find((i: Token) => i.text === '1.00')!.rect[1] = 37
  if (change === 'center') p.owned.find((i: Token) => i.text === 'R')!.rect[1] = 20
  expect(recoverNativeRepeatedMatrixParts(c, change === 'scale' ? NaN : 1.5)).toBeUndefined()
})
