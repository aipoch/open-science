import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable, hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
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
