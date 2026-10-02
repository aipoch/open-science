import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const {
  proveDescriptiveRecordBlock,
  recoverDescriptiveRecordBlock,
  groupDescriptiveRecordBlocks,
  provePairedStatisticGutters
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-descriptive-record-block.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

it.each([
  'native',
  'partial-frame',
  'different-leaves',
  'missing-parent',
  'missing-title',
  'too-few-records',
  'unowned-header'
])('proves numeric gutters only from two complete native statistic headers: %s', (variant) => {
  const tokens: {
      text: string
      rect: number[]
      height: number
      baseline: number
      horizontal: boolean
    }[] = [],
    rules = [
      [0, 100, 480, 100],
      [0, 120, 480, 120],
      [0, 160, 480, 160],
      [0, 220, 480, 220],
      [210, 140, 315, 140],
      [335, 140, 440, 140]
    ]
  const token = (text: string, x: number, y: number, width = 10): void => {
    tokens.push({
      text,
      rect: [x, y - 10, x + width, y],
      height: 10,
      baseline: y,
      horizontal: true
    })
  }
  token('Statistics', 10, 115, 70)
  token('Group A', 240, 135, 35)
  token('Group B', 365, 135, 35)
  token('Factor', 10, 155, 40)
  for (const shift of [0, 125])
    for (const [text, x] of [
      ['b', 220],
      ['SE', 245],
      ['t', 270],
      ['p', 295]
    ] as const)
      token(text, x + shift, 155)
  for (let row = 0; row < (variant === 'too-few-records' ? 2 : 4); row++) {
    token('Factor', 10, 175 + row * 10, 40)
    for (const shift of [0, 125]) {
      token('1.20 .04', 218 + shift, 175 + row * 10, 40)
      token('2.50', 269 + shift, 175 + row * 10, 20)
      token('.01', 294 + shift, 175 + row * 10, 15)
    }
  }
  if (variant === 'partial-frame') rules.splice(3, 1)
  if (variant === 'different-leaves')
    tokens.find((i) => i.text === 't' && i.rect[0] > 300)!.text = 'z'
  if (variant === 'missing-parent') rules.pop()
  if (variant === 'missing-title') tokens.shift()
  if (variant === 'unowned-header') token('Unowned', 450, 135, 20)
  const before = structuredClone({ tokens, rules }),
    frames = provePairedStatisticGutters(tokens, rules)
  expect(frames).toHaveLength(variant === 'native' ? 1 : 0)
  if (variant === 'native') {
    expect(frames[0].cuts).toHaveLength(6)
    expect(frames[0].numericOnly).toBe(true)
  }
  expect({ tokens, rules }).toEqual(before)
})

it.each([
  'native',
  'missing-parent-rule',
  'different-parent',
  'incomplete-record',
  'competing-caption',
  'existing-upper',
  'incomplete-lower',
  'missing-lower-title',
  'crossing-border'
])('recovers a missing descriptive block only with complete native ownership: %s', (variant) => {
  const tokens: {
      text: string
      rect: number[]
      height: number
      baseline: number
      horizontal: boolean
    }[] = [],
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
  for (const top of [100, 286, 472]) {
    for (const y of [top, top + 20, top + 60, top + 180]) rules.push([0, y, 480, y])
    for (const [left, right] of [
      [220, 320],
      [340, 440]
    ])
      rules.push([left, top + 40, right, top + 40])
    token('Section', 0, top + 15, 45)
    token('First cohort', 230, top + 35, 60)
    token('Second cohort', 350, top + 35, 65)
    for (const [text, x] of [
      ['Policy', 0],
      ['Budget', 70],
      ['Information', 140],
      ['Mean', 220],
      ['Deviation', 280],
      ['Mean', 340],
      ['Deviation', 400]
    ] as const)
      token(text, x, top + 55)
    if (top !== 100) continue
    for (let n = 0; n < 8; n++) {
      token('Policy', 0, top + 96 + n * 10, 35)
      token('Budget', 70, top + 96 + n * 10, 35)
      token('Received', 140, top + 96 + n * 10, 45)
      for (const x of [220, 280, 340, 400]) token('1.23±0.45', x, top + 96 + n * 10, 35)
    }
  }
  for (const rect of rules) {
    const shift = rect[1] >= 472 ? 4 : rect[1] >= 286 ? 2 : 0
    rect[0] += shift
    rect[2] += shift
  }
  for (const item of tokens) {
    const shift = item.baseline >= 472 ? 4 : item.baseline >= 286 ? 2 : 0
    item.rect[0] += shift
    item.rect[2] += shift
  }
  const captions = [{ page: 1, lines: ['Table A.1. Repeated cohorts'], rect: [0, 659, 480, 669] }]
  const tables = [286, 472].map((top, n) => ({
    id: 'native-lower-' + n,
    cropRect: [0, top, 480, top + 180],
    structure: { objects: [] }
  }))
  if (variant === 'missing-parent-rule')
    rules.splice(
      rules.findIndex((r) => r[0] === 220),
      1
    )
  if (variant === 'different-parent')
    tokens.find((i) => i.text === 'First cohort' && i.baseline === 321)!.text = 'Other cohort'
  if (variant === 'incomplete-record') tokens.find((i) => i.text === '1.23±0.45')!.text = 'unknown'
  if (variant === 'competing-caption')
    captions.push({ ...captions[0], lines: ['Table B.1. Competing cohort'] })
  if (variant === 'existing-upper')
    tables.push({ id: 'existing', cropRect: [0, 100, 480, 280], structure: { objects: [] } })
  if (variant === 'incomplete-lower') tables.pop()
  if (variant === 'missing-lower-title')
    tokens.splice(
      tokens.findIndex((i) => i.text === 'Section' && i.baseline === 301),
      1
    )
  if (variant === 'crossing-border') token('Unowned', 220, 281, 10)
  const before = structuredClone({ tokens, rules, captions, tables })
  const proof = proveDescriptiveRecordBlock(tables, tokens, captions, rules)
  if (variant === 'native') {
    expect(proof).toBeDefined()
    const recovered = recoverDescriptiveRecordBlock(proof, tokens, 1)
    expect(recovered).toBeDefined()
    const result = refineTable(recovered, tokens, captions, [], rules)
    expect(result.grid).toHaveLength(11)
    expect(result.grid[3]).toEqual([
      'Policy',
      'Budget',
      'Received',
      '1.23±0.45',
      '1.23±0.45',
      '1.23±0.45',
      '1.23±0.45'
    ])
    expect(result.unassigned).toEqual([])
    proof.tables = [recovered, ...tables]
    const parts = proof.tables.map((raw: { id: string; cropRect: number[] }, n: number) => ({
      ...result,
      id: raw.id,
      cropRect: raw.cropRect,
      page: 1,
      caption: { text: captions[0].lines[0] },
      sourceViewport: { width: 480, height: 700, scale: 1 },
      grid: n ? result.grid.slice(0, 4) : result.grid
    }))
    const grouped = groupDescriptiveRecordBlocks(parts, proof)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].parts.map((part: { grid: string[][] }) => part.grid.length)).toEqual([
      11, 4, 4
    ])
    expect(groupDescriptiveRecordBlocks(parts.slice(0, 2), proof)).toHaveLength(2)
  } else expect(proof).toBeUndefined()
  expect({ tokens, rules, captions, tables }).toEqual(before)
})
