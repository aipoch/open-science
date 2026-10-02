import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { nativeRepeatedMatrixCandidate } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-native-repeated-matrix-candidate.mjs')
  ).href
)
const input = (): ReturnType<typeof JSON.parse> => {
  const items: ReturnType<typeof JSON.parse>[] = [],
    rules: number[][] = []
  const token = (text: string, x: number, b: number, w = 4): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [x, b - 8, x + w, b],
    baseline: b,
    height: 8,
    horizontal: true
  })
  for (const x of [100, 220, 340]) {
    rules.push(
      [x, 80, x + 100, 80],
      [x, 88, x + 100, 88],
      [x, 124, x + 100, 124],
      ...Array.from({ length: 6 }, (_, i) => [
        x + 20,
        80.2 + i * 8,
        x + 20,
        Math.min(87.8 + i * 8, 123.8)
      ])
    )
    items.push(
      token('A', x + 40, 76),
      token('=', x + 48, 76),
      token('1', x + 56, 76),
      token('G', x + 5, 86, 2),
      token('\\', x + 8, 86, 2),
      token('H', x + 11, 86, 2),
      ...[30, 52, 74].map((n, i) => token(String(i + 1), x + n, 86))
    )
    for (const b of [96, 104, 112, 120])
      items.push(token('1', x + 10, b), ...[26, 48, 70].map((n) => token('1.00', x + n, b, 12)))
  }
  return {
    items,
    rules,
    captions: [{ page: 1, lines: ['Table 1: Repeated matrices.'], rect: [100, 40, 440, 60] }],
    width: 600,
    height: 800
  }
}
it('proves a complete repeated native matrix image without inventing cells', () => {
  const f = input()
  const p = nativeRepeatedMatrixCandidate(f.items, f.rules, f.captions, f.width, f.height)
  expect(p.rect).toEqual([100, 68, 440, 124.5])
  expect(p.panels).toHaveLength(3)
  expect(new Set(p.panels.flatMap((r: ReturnType<typeof JSON.parse>) => r.owned)).size).toBe(
    f.items.length
  )
  expect(p.grid).toBeUndefined()
})
it.each([
  'missing-footer',
  'missing-value',
  'foreign-source',
  'ambiguous-caption',
  'broken-stub',
  'misaligned-value',
  'nonfinite'
])('rejects incomplete matrix proof: %s', (reason) => {
  const f = input()
  if (reason === 'missing-footer')
    f.rules = f.rules.filter((r: number[]) => !(r[0] === 100 && r[1] === 124))
  if (reason === 'missing-value') f.items.pop()
  if (reason === 'foreign-source')
    f.items.push({
      text: 'Foreign',
      rect: [250, 90, 275, 100],
      baseline: 100,
      height: 8,
      horizontal: true
    })
  if (reason === 'ambiguous-caption') f.captions.push({ ...f.captions[0] })
  if (reason === 'broken-stub') f.rules[4][1] += 2
  if (reason === 'misaligned-value') f.items.at(-1).rect[0] += 2
  if (reason === 'nonfinite') f.items[0].baseline = NaN
  expect(
    nativeRepeatedMatrixCandidate(f.items, f.rules, f.captions, f.width, f.height)
  ).toBeUndefined()
})
