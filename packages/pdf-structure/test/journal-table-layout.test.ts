import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'

const { refineTable, hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const token = (
  text: string,
  x: number,
  y: number,
  width = 35
): { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean } => ({
  text,
  rect: [x, y, x + width, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})
const model = (
  columns: number,
  bands: number[][],
  bottom = 200
): {
  id: string
  cropRect: number[]
  structure: { objects: { label: string; rect: number[] }[] }
} => ({
  id: 'sample',
  cropRect: [0, 0, columns * 100, bottom],
  structure: {
    objects: [
      ...Array.from({ length: columns }, (_, i) => ({
        label: 'table column',
        rect: [i * 100, 0, (i + 1) * 100, bottom]
      })),
      ...bands.map(([top, end]) => ({ label: 'table row', rect: [0, top, columns * 100, end] }))
    ]
  }
})

it('recovers paired primer sequences and centered gene labels when model rows miss reverse primers', () => {
  const source = model(
    2,
    [
      [5, 20],
      [30, 43],
      [70, 83]
    ],
    120
  )
  const items = [
    token('Gene', 5, 5),
    token('Sequence', 105, 5),
    token('GeneA', 5, 40),
    token('F: ACGTACGTACGT', 105, 30, 85),
    token('R: TGCATGCATGCA', 105, 50, 85),
    token('GeneB', 5, 80),
    token('F: AAAAAAAAAAAA', 105, 70, 85),
    token('R: CCCCCCCCCCCC', 105, 90, 85)
  ]
  const result = refineTable(source, items)
  expect(result.unassigned).toEqual([])
  expect(result.grid).toEqual([
    ['Gene', 'Sequence'],
    ['GeneA', 'F: ACGTACGTACGT R: TGCATGCATGCA'],
    ['GeneB', 'F: AAAAAAAAAAAA R: CCCCCCCCCCCC']
  ])
})

it('reconstructs dense numeric records and sparse probability rows without an empty duplicate column', () => {
  const source = model(
    8,
    [
      [5, 20],
      ...Array.from({ length: 12 }, (_, i) => [30 + i * 15, 42 + i * 15]).filter((_, i) => i !== 4)
    ],
    240
  )
  source.structure.objects.push({ label: 'table column', rect: [310, 0, 400, 240] })
  const items = Array.from({ length: 8 }, (_, c) => token(`H${c}`, c * 100 + 5, 5))
  for (let r = 0; r < 12; r++) {
    if (r % 3 === 0) items.push(token(`Group${r}`, 5, 30 + r * 15))
    items.push(token(`Type${r}`, 105, 30 + r * 15))
    for (let c = 2; c < 8; c++) items.push(token(String(r * 10 + c), c * 100 + 5, 30 + r * 15))
  }
  items.push(
    token('P', 105, 215),
    token('0.012', 305, 215),
    token('0.032', 505, 215),
    token('0.087', 705, 215)
  )
  const result = refineTable(source, items)
  expect(result.unassigned).toEqual([])
  expect(result.grid).toHaveLength(14)
  expect(result.grid[5]).toEqual(['', 'Type4', '42', '43', '44', '45', '46', '47'])
  expect(result.grid.at(-1)).toEqual(['', 'P', '', '0.012', '', '0.032', '', '0.087'])
})

it('keeps off-grid final records distinct from a preceding row with merged labels', () => {
  const source = model(
    4,
    [
      [5, 20],
      [30, 43],
      [47, 60],
      [65, 79]
    ],
    100
  )
  const items = [
    token('Gene', 5, 5),
    token('Site', 105, 5),
    token('Variant', 205, 5),
    token('Effect', 305, 5),
    token('A', 5, 30),
    token('x', 105, 30),
    token('a', 205, 30),
    token('b', 305, 30),
    token('x2', 105, 47),
    token('a2', 205, 47),
    token('b2', 305, 47),
    token('B', 5, 65),
    token('y', 105, 65),
    token('c', 205, 65),
    token('d', 305, 65),
    token('y2', 105, 77),
    token('c2', 205, 77),
    token('d2', 305, 77)
  ]
  const result = refineTable(source, items, [], [], [[0, 95, 400, 95]])
  expect(result.unassigned).toEqual([])
  expect(result.grid.at(-1)).toEqual(['', 'y2', 'c2', 'd2'])
})

it('rejects supplementary directories and affiliation blocks while preserving captioned contact tables', () => {
  const directory = {
    grid: [
      ['Supplementary Table S3 |', 'Antibodies'],
      ['Supplementary Table S4 |', 'Growth assay']
    ],
    issues: []
  }
  expect(hasTableEvidence(directory, { lines: ['Supplementary Table S2 | Primers'] })).toBe(false)
  const affiliations = {
    grid: [
      ['*', 'A. Author a@example.org'],
      ['1', 'Department of Biology, University A']
    ],
    issues: []
  }
  expect(hasTableEvidence(affiliations)).toBe(false)
  expect(hasTableEvidence(affiliations, { lines: ['Table 1. Contacts'] })).toBe(true)
})

const fencedListContinuation = (
  fault = ''
): {
  source: ReturnType<typeof model>
  items: (ReturnType<typeof token> & {
    sourceItem: { pageNumber: number; index: number; text: string }
  })[]
  rules: number[][]
} => {
  let index = 0
  const whole = (
    text: string,
    x: number,
    y: number
  ): ReturnType<typeof fencedListContinuation>['items'][number] => ({
    ...token(text, x, y, 50),
    sourceItem: { pageNumber: 2, index: index++, text }
  })
  const source = model(
    3,
    [
      [5, 24],
      [28, 57],
      [63, 88],
      [92, 126]
    ],
    145
  )
  const items = [
    whole('Field', 5, 8),
    whole('Value', 105, 8),
    whole('Origin', 205, 8),
    whole('delta', 5, 32),
    whole('4', 105, 32),
    whole('Reference A', 205, 32),
    whole('epsilon', 5, 68),
    whole('5', 105, 68),
    whole('Reference B', 205, 68),
    whole('alpha,', 5, 94),
    whole('10;', 105, 94),
    whole('Dataset note', 205, 94),
    whole('beta,', 5, 108),
    whole('20;', 105, 108),
    whole('continued', 205, 108),
    whole('gamma', 5, 122),
    whole('30; 40', 105, 122)
  ]
  let rules = [0, 25, 60, 90, 140].map((y) => [0, y, 300, y])
  if (fault === 'page') items.at(-1)!.sourceItem.pageNumber = 3
  if (fault === 'literal') items.at(-1)!.sourceItem.text = 'partial'
  if (fault === 'fence') rules = rules.filter((rule) => rule[1] !== 90)
  if (fault === 'peer') items.splice(8, 1)
  if (fault === 'separator') {
    items[13].text = '20'
    items[13].sourceItem.text = '20'
  }
  return { source, items, rules }
}

it('refuses a new scalar row that cuts two whole native lists inside one complete ruled face', () => {
  const { source, items, rules } = fencedListContinuation()
  const result = refineTable(source, items, [], [], rules)
  expect(result.repairs).not.toContain('final-record-recovered')
  expect(result.issues).toContain('native-table-structure-ambiguous')
  expect(result.reviewCandidate).toBe(false)
  expect(result.repairs).toContain('ruled-final-continuation-recovered')
  expect(result.grid.at(-1)).toEqual([
    'alpha, beta, gamma',
    '10; 20; 30; 40',
    'Dataset note continued'
  ])
  expect(result.unassigned).toEqual([])
  const claims = result.cells.flatMap(
    (cell: { sourceItems?: { index: number; text: string }[] }) => cell.sourceItems ?? []
  )
  expect(
    claims.map((item: { index: number }) => item.index).sort((a: number, b: number) => a - b)
  ).toEqual(items.map((item) => item.sourceItem.index))
  expect(
    new Map(claims.map((item: { index: number; text: string }) => [item.index, item.text]))
  ).toEqual(new Map(items.map((item) => [item.sourceItem.index, item.text])))
})

it('does not infer a list continuation across different native pages', () => {
  const { source, items, rules } = fencedListContinuation('page')
  const result = refineTable(source, items, [], [], rules)
  expect(result.issues).not.toContain('native-table-structure-ambiguous')
  expect(result.repairs).toContain('final-record-recovered')
})

it('requires complete literal Source text before refusing the final record repair', () => {
  const { source, items, rules } = fencedListContinuation('literal')
  const result = refineTable(source, items, [], [], rules)
  expect(result.issues).not.toContain('native-table-structure-ambiguous')
  expect(result.repairs).toContain('final-record-recovered')
})

it('does not turn an unfenced list-shaped suffix into a native record conflict', () => {
  const { source, items, rules } = fencedListContinuation('fence')
  const result = refineTable(source, items, [], [], rules)
  expect(result.issues).not.toContain('native-table-structure-ambiguous')
  expect(result.repairs).toContain('final-record-recovered')
})

it('requires complete three-lane peer faces before blocking the scalar repair', () => {
  const { source, items, rules } = fencedListContinuation('peer')
  const result = refineTable(source, items, [], [], rules)
  expect(result.issues).not.toContain('native-table-structure-ambiguous')
  expect(result.repairs).toContain('final-record-recovered')
})

it('keeps an otherwise supported final record without both native trailing separators', () => {
  const { source, items, rules } = fencedListContinuation('separator')
  const result = refineTable(source, items, [], [], rules)
  expect(result.issues).not.toContain('native-table-structure-ambiguous')
  expect(result.repairs).toContain('final-record-recovered')
})
