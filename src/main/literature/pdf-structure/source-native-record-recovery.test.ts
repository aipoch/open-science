import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixtures = readFileSync(
  resolve('src/main/literature/pdf-structure/fixtures/source-native-record-recovery.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const fixture = (kind: string): ReturnType<typeof JSON.parse> =>
  structuredClone(fixtures.find((entry) => entry.kind === kind))
const run = (input: ReturnType<typeof fixture>): ReturnType<typeof refineTable> =>
  refineTable(input.table, input.items, input.captions ?? [], [], input.rules)

it('separates a source operator header from the first complete record', () => {
  const input = fixture('operator-block')
  const before = structuredClone(input)
  const result = run(input)
  expect(result.grid).toHaveLength(4)
  expect(result.grid[0]).toEqual(['Input', 'Operator', 'Output'])
  expect(result.grid[1]).toEqual(['h × w × k', '1 × 1 Conv2D, ReLU6', 'h × w × (tk)'])
  expect(result.repairs).toContain('native-operator-records-recovered')
  expect(result.unassigned).toEqual([])
  expect(input).toEqual(before)
})

it('recovers short layer columns and the source record between adjacent operators', () => {
  const input = fixture('layer-records')
  const before = structuredClone(input)
  const result = run(input)
  expect(result.grid).toHaveLength(12)
  expect(result.grid[0]).toEqual(['Input', 'Operator', 't', 'c', 'n', 's'])
  expect(result.grid[9]).toEqual(['72 × 320', 'conv2d 1 × 1', '-', '1280', '1', '1'])
  expect(result.grid.every((row: string[]) => row.length === 6)).toBe(true)
  expect(result.unassigned).toEqual([])
  expect(input).toEqual(before)
})

it('preserves independent field-strength headings and every wrapped parameter', () => {
  const input = fixture('acquisition-parameters')
  const before = structuredClone(input)
  const result = run(input)
  expect(result.grid[0]).toEqual(['', '0.25T', '1.5T', '3T'])
  expect(result.grid[1]).toEqual([
    'Sequence',
    'SEQ-A, TR=12ms, TE=6ms, FA=15◦,',
    'SEQ-B, TR=1890ms, TE=4.17ms, TI=110ms, FA=15◦',
    'SEQ-C, TR=8.428ms, TE=3.2ms, TI=450ms, FA=12◦'
  ])
  expect(result.grid[2][1]).toBe('0.45x0.45x5mm3')
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('native-acquisition-records-recovered')
  expect(input).toEqual(before)
})

it('refuses operator recovery when a short scalar lane has an unknown value', () => {
  const input = fixture('layer-records')
  const token = input.items.find(
    (item: { text: string; rect: number[] }) => item.text === '32' && item.rect[0] > 250
  )
  token.text = 'uncertain'
  expect(run(input).repairs).not.toContain('native-operator-records-recovered')
})

it('refuses acquisition ownership without all native vertical lanes', () => {
  const input = fixture('acquisition-parameters')
  input.rules = input.rules.filter(
    (rule: number[]) =>
      Math.abs(rule[0] - rule[2]) >= 0.5 ||
      Math.abs(rule[0] - input.rules.find((r: number[]) => Math.abs(r[0] - r[2]) < 0.5)![0]) > 0.5
  )
  expect(run(input).repairs).not.toContain('native-acquisition-records-recovered')
})

it('keeps native records stable after scaling, translation, and source-order reversal', () => {
  const input = fixture('layer-records')
  const transform = (rect: number[]): number[] =>
    rect.map((value, index) => value * 1.7 + (index % 2 ? 70 : 30))
  input.table.cropRect = transform(input.table.cropRect)
  input.table.structure.objects = input.table.structure.objects.map(
    (object: { rect: number[] }) => ({ ...object, rect: object.rect.map((value) => value * 1.7) })
  )
  input.items = input.items
    .map((item: { rect: number[]; baseline: number; height: number }) => ({
      ...item,
      rect: transform(item.rect),
      baseline: item.baseline * 1.7 + 70,
      height: item.height * 1.7
    }))
    .reverse()
  input.rules = input.rules.map(transform)
  const result = run(input)
  expect(result.grid).toHaveLength(12)
  expect(result.grid[9]).toEqual(['72 × 320', 'conv2d 1 × 1', '-', '1280', '1', '1'])
  expect(result.unassigned).toEqual([])
  const selected = result.cells.flatMap((cell: { sourceTokens: unknown[] }) => cell.sourceTokens)
  expect(selected).toHaveLength(input.items.length)
  expect(new Set(selected).size).toBe(input.items.length)
})

it('separates the terminal native metric lane and preserves grouped header leaves', () => {
  const input = fixture('ruled-metric-records')
  const before = structuredClone(input)
  const result = run(input)
  expect(result.grid).toHaveLength(10)
  expect(result.grid[0]).toEqual([
    'Metric',
    '',
    '1.5T',
    'HM',
    'Supervised Approaches',
    '',
    '',
    '',
    '',
    'Unsupervised Approaches',
    '',
    '3T'
  ])
  expect(result.grid[1].slice(4)).toEqual([
    'SCSR',
    'CCA',
    'MIMECS',
    'EDp',
    'ED',
    'Proposed',
    'Proposed (NLM)',
    ''
  ])
  expect(result.grid[2].slice(-2)).toEqual(['24.27', 'inf'])
  expect(result.grid[3].slice(-2)).toEqual(['0.1864', '-'])
  expect(result.grid[6][4]).toBe('0..4300')
  expect(result.grid.every((row: string[]) => row.length === 12)).toBe(true)
  expect(result.unassigned).toEqual([])
  expect(result.clipped).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.cropRect[2]).toBeGreaterThan(input.table.cropRect[2])
  expect(input).toEqual(before)
  const characters = (texts: string[]): string =>
    texts.join('').replace(/\s/gu, '').split('').sort().join('')
  expect(
    characters(
      result.cells.flatMap((cell: { sourceTokens: { text: string }[] }) =>
        cell.sourceTokens.map((item) => item.text)
      )
    )
  ).toBe(characters(input.items.map((item: { text: string }) => item.text)))
})

it('does not infer an unknown terminal metric value', () => {
  const input = fixture('ruled-metric-records')
  input.items.find((item: { text: string }) => item.text === 'inf').text = 'unknown'
  expect(run(input).repairs).not.toContain('native-ruled-metric-records-recovered')
})

it('does not split combined metric labels without complete ruled leaves', () => {
  const input = fixture('ruled-metric-records')
  const vertical = input.rules.filter((rule: number[]) => Math.abs(rule[0] - rule[2]) < 0.5)
  const interior = [...new Set(vertical.map((rule: number[]) => rule[0]))].sort(
    (a, b) => Number(a) - Number(b)
  )[5]
  input.rules = input.rules.filter(
    (rule: number[]) => Math.abs(rule[0] - rule[2]) >= 0.5 || rule[0] !== interior
  )
  expect(run(input).repairs).not.toContain('native-ruled-metric-records-recovered')
})
