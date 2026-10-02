import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { recoverRepeatedRecordBlocks, groupRepeatedRecordBlocks } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-repeated-record-blocks.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

it.each([
  'native',
  'incomplete-frame',
  'different-header',
  'incomplete-record',
  'competing-title',
  'crossing-candidate',
  'unowned-script',
  'crossing-border'
])('recovers only two proven repeated native record blocks: %s', (variant) => {
  const tokens: {
      text: string
      rect: number[]
      height: number
      baseline: number
      horizontal: boolean
    }[] = [],
    rules: number[][] = []
  const token = (text: string, x: number, y: number, width = 15, height = 10): void => {
    tokens.push({
      text,
      rect: [x, y - height, x + width, y],
      height,
      baseline: y,
      horizontal: true
    })
  }
  for (const left of [0, 270]) {
    for (const y of [10, 12, 30, 120, 122]) rules.push([left, y, left + 240, y])
    for (const [text, x] of [
      ['Record', 0],
      ['Class', 45],
      ['Q(U)', 90],
      ['R1', 130],
      ['R2', 170],
      ['R3', 210]
    ] as const)
      token(text, left + x, 25)
    for (let n = 0; n < 4; n++) {
      token('Item' + (n + 1), left, 45 + n * 20, 25)
      token('A', left + 45, 45 + n * 20, 5)
      for (const x of [90, 130, 170, 210]) token('0.357', left + x, 45 + n * 20)
    }
  }
  const captions = [{ page: 1, lines: ['Table A.1. Native records'], rect: [0, 0, 200, 5] }]
  const raw = [{ id: 'native-input', cropRect: [0, 10, 240, 122], structure: { objects: [] } }]
  if (variant === 'incomplete-frame') rules.pop()
  if (variant === 'different-header')
    tokens.find((i) => i.text === 'R3' && i.rect[0] > 270)!.text = 'T3'
  if (variant === 'incomplete-record')
    tokens.find((i) => i.text === '0.357' && i.rect[0] === 360)!.text = 'text'
  if (variant === 'competing-title')
    captions.push({ ...captions[0], lines: ['Table B.1. Competing records'] })
  if (variant === 'crossing-candidate')
    raw.push({ id: 'competing-input', cropRect: [200, 50, 300, 80], structure: { objects: [] } })
  if (variant === 'unowned-script') token('4', 250, 70, 5, 5)
  if (variant === 'crossing-border') token('Unowned', 130, 123, 15)
  const before = structuredClone({ tokens, rules, captions, raw })
  const proof = recoverRepeatedRecordBlocks(raw, tokens, captions, rules, 1)
  if (variant === 'native' || variant === 'unowned-script') {
    expect(proof.tables).toHaveLength(2)
    expect(proof.replaced).toEqual([raw[0]])
    const results = proof.tables.map((table: unknown) => ({
      ...refineTable(table, tokens, captions, [], rules),
      caption: { text: captions[0].lines[0] },
      page: 1,
      sourceViewport: { width: 510, height: 130, scale: 1.5 }
    }))
    expect(results.map((table: { grid: string[][] }) => table.grid.length)).toEqual([5, 5])
    expect(results.map((table: { grid: string[][] }) => table.grid[0].length)).toEqual([6, 6])
    const grouped = groupRepeatedRecordBlocks(results, proof)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].parts.map((p: { grid: string[][] }) => p.grid.length)).toEqual([5, 5])
  } else expect(proof).toBeUndefined()
  expect({ tokens, rules, captions, raw }).toEqual(before)
})
