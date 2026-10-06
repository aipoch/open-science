import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { refineTable, recoverSeparatedTerminalRecordsCrop, recoverRuledTerminalColumn } =
  await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
  )
const fixture = (name: string): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`))

it('recovers two complete terminal records crossing an open ruled stub boundary', () => {
  const f = fixture('separated-terminal-records')
  const original = structuredClone(f)
  const crop = recoverSeparatedTerminalRecordsCrop(f.table, f.tokens, f.rules, f.captions)
  expect(crop?.[3]).toBeGreaterThan(256)
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid.slice(-2).map((row: string[]) => row.slice(1))).toEqual([
    ['74.0', '74.7', '65.3', '48.0'],
    ['73.4', '73.2', '63.4', '44.2']
  ])
  expect(result.grid).toHaveLength(9)
  expect(result.clipped).toEqual([])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('separated-terminal-record-crop-recovered')
  expect(f).toEqual(original)
})

it.each(['separator', 'caption', 'missing-value', 'detached-row', 'prose'] as const)(
  'rejects terminal expansion with %s evidence',
  (kind) => {
    const f = fixture('separated-terminal-records')
    if (kind === 'separator') f.rules = []
    if (kind === 'caption')
      f.captions.push({ lines: ['Table 3: Other results.'], rect: [475, 239, 820, 243] })
    if (kind === 'missing-value')
      f.tokens = f.tokens.filter((t: { text: string }) => t.text !== '44.2')
    if (kind === 'detached-row') f.table.cropRect[3] = 228
    if (kind === 'prose')
      f.tokens.find((t: { text: string }) => t.text === '44.2').text = 'a following sentence'
    expect(
      recoverSeparatedTerminalRecordsCrop(f.table, f.tokens, f.rules, f.captions)
    ).toBeUndefined()
  }
)

it('recovers a fully ruled terminal column omitted by the detector', () => {
  const f = fixture('ruled-missing-terminal-column')
  const original = structuredClone(f)
  const plan = recoverRuledTerminalColumn(f.table, f.tokens, f.rules, f.captions)
  expect(plan?.right).toBeGreaterThan(786)
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid[0].at(-1)).toBe('3T')
  expect(result.grid.slice(-5).map((row: string[]) => row.at(-1))).toEqual([
    '5',
    '5',
    '4',
    '4.25',
    '4.25'
  ])
  expect(result.grid[0]).toHaveLength(11)
  expect(result.clipped).toEqual([])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('ruled-terminal-column-recovered')
  expect(f).toEqual(original)
})

it.each([
  'closing-rule',
  'paired-sides',
  'caption',
  'mixed-prose',
  'missing-header',
  'duplicate-baseline'
] as const)('rejects terminal-column recovery without %s proof', (kind) => {
  const f = fixture('ruled-missing-terminal-column')
  if (kind === 'closing-rule') f.rules = f.rules.filter((r: number[]) => r[1] !== r[3])
  if (kind === 'paired-sides')
    f.rules = f.rules.filter((r: number[]) => (r[0] === r[2] && r[0] < 780) || r[1] === r[3])
  if (kind === 'caption')
    f.captions.push({ lines: ['Figure 2: Separate panel.'], rect: [753, 610, 790, 625] })
  if (kind === 'mixed-prose')
    f.tokens.find((t: { text: string; rect: number[] }) => t.text === '5' && t.rect[0] > 750).text =
      'Nearby prose'
  if (kind === 'missing-header')
    f.tokens = f.tokens.filter((t: { text: string }) => t.text !== '3T')
  if (kind === 'duplicate-baseline') {
    const original = f.tokens.find(
      (t: { text: string; rect: number[] }) => t.text === '5' && t.rect[0] > 750
    )
    f.tokens.push({ ...structuredClone(original), text: '7' })
  }
  expect(recoverRuledTerminalColumn(f.table, f.tokens, f.rules, f.captions)).toBeUndefined()
})
