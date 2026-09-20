import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const token = (text: string, x: number, y: number, width = 40): object => ({
  text,
  rect: [x, y, x + width, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})

it('separates a counted category from a merged count/percentage header', () => {
  const raw = {
    cropRect: [0, 0, 300, 105],
    structure: {
      objects: [
        ...[0, 150, 240].map((x, i, xs) => ({
          label: 'table column',
          rect: [x, 0, xs[i + 1] ?? 300, 105]
        })),
        { label: 'table column header', rect: [0, 0, 300, 35] },
        ...[
          [0, 35],
          [40, 58],
          [60, 78],
          [80, 100]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 300, b] }))
      ]
    }
  }
  const source = [
    token('Diagnosis', 5, 5),
    token('Number', 170, 5),
    token('%', 260, 5, 10),
    token('Group A', 5, 23),
    token('30', 180, 23, 15),
    token('Type A', 5, 43),
    token('30', 180, 43, 15),
    token('100', 260, 43, 20),
    token('Group B', 5, 63),
    token('20', 180, 63, 15),
    token('Type B', 5, 83),
    token('20', 180, 83, 15),
    token('100', 260, 83, 20)
  ]
  const result = refineTable(raw, source, [], [], [])
  expect(result.grid).toEqual([
    ['Diagnosis', 'Number', '%'],
    ['Group A', '30', ''],
    ['Type A', '30', '100'],
    ['Group B', '20', ''],
    ['Type B', '20', '100']
  ])
  expect(result.repairs).toContain('counted-category-header-separated')
  const withoutCountHeading = source.filter((_, i) => i !== 1)
  expect(refineTable(raw, withoutCountHeading, [], [], []).repairs).not.toContain(
    'counted-category-header-separated'
  )
  expect(
    refineTable(
      raw,
      source.filter((_, i) => i < 8 || i > 9),
      [],
      [],
      []
    ).repairs
  ).not.toContain('counted-category-header-separated')
})

it('keeps a split sample-size suffix with its adjoining header without changing data columns', () => {
  const raw = {
    cropRect: [0, 0, 400, 130],
    structure: {
      objects: [
        ...[0, 100, 260].map((x, i, xs) => ({
          label: 'table column',
          rect: [x, 0, xs[i + 1] ?? 400, 130]
        })),
        { label: 'table column header', rect: [0, 0, 400, 60] },
        ...[
          [0, 60],
          [65, 90],
          [95, 120]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 400, b] }))
      ]
    }
  }
  const source = [
    token('Period', 5, 5),
    token('Treatment (n=', 110, 5, 143),
    token('42)', 255, 5, 20),
    token('Control', 300, 5),
    token('(n=40)', 300, 25),
    token('Acute', 5, 70),
    token('30 (71%)', 115, 70, 60),
    token('20 (50%)', 300, 70, 60),
    token('Overall', 5, 100),
    token('25 (60%)', 115, 100, 60),
    token('18 (45%)', 300, 100, 60)
  ]
  const result = refineTable(raw, source, [], [], [])
  expect(result.grid).toEqual([
    ['Period', 'Treatment (n= 42)', 'Control (n=40)'],
    ['Acute', '30 (71%)', '20 (50%)'],
    ['Overall', '25 (60%)', '18 (45%)']
  ])
  expect(result.repairs).toContain('split-header-sample-size-recovered')
  expect(refineTable(raw, source, [], [], [[260, 0, 260, 60]]).repairs).not.toContain(
    'split-header-sample-size-recovered'
  )
  const distant = source.map((item, i) => (i === 2 ? token('42)', 285, 5, 12) : item))
  expect(refineTable(raw, distant, [], [], []).repairs).not.toContain(
    'split-header-sample-size-recovered'
  )
})

it('recovers a lone wrapped heading prefix corroborated by an adjacent treatment heading', () => {
  const raw = {
    cropRect: [0, 0, 500, 110],
    structure: {
      objects: [
        ...[0, 100, 200, 300, 400].map((x) => ({
          label: 'table column',
          rect: [x, 0, x + 100, 110]
        })),
        { label: 'table column header', rect: [0, 15, 500, 50] },
        ...[
          [15, 50],
          [55, 75],
          [80, 100]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 500, b] }))
      ]
    }
  }
  const source = [
    token('Variable', 5, 37),
    token('Total', 110, 22),
    token('(n=80)', 110, 37),
    token('Usual', 210, 8),
    token('therapy', 210, 22),
    token('(n=40)', 210, 37),
    token('Usual therapy +', 305, 22, 85),
    token('drug (n=40)', 305, 37, 85),
    token('P value', 410, 37),
    ...[60, 85].flatMap((y) => [
      token('Outcome', 5, y),
      token('25', 110, y),
      token('10', 210, y),
      token('15', 310, y),
      token('0.2', 410, y)
    ])
  ]
  expect(refineTable(raw, source, [], [], []).grid[0][2]).toBe('Usual therapy (n=40)')
  const unrelated = source.map((t, i) => (i === 6 ? token('Other therapy +', 305, 22, 85) : t))
  expect(refineTable(raw, unrelated, [], [], []).unassigned).toContain('Usual')
})

it('rejoins a parenthetical category label while retaining its group P-value and numerical subrows', () => {
  const raw = {
    cropRect: [0, 0, 500, 130],
    structure: {
      objects: [
        ...[0, 250, 330, 410, 460].map((x, i, xs) => ({
          label: 'table column',
          rect: [x, 0, xs[i + 1] ?? 500, 130]
        })),
        { label: 'table column header', rect: [0, 0, 500, 20] },
        ...[
          [0, 20],
          [25, 45],
          [46, 66],
          [68, 90],
          [95, 120]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 500, b] }))
      ]
    }
  }
  const source = [
    token('Variable', 5, 5),
    token('Total', 260, 5),
    token('Arm A', 340, 5),
    token('Arm B', 415, 5),
    token('P', 470, 5, 10),
    token('Treatment setting (number of lines', 5, 30, 230),
    token('0.254', 466, 30, 30),
    token('for advanced disease) (%)', 15, 47, 180),
    ...[73, 100].flatMap((y, i) => [
      token(String(i), 15, y, 10),
      token('10 (20)', 260, y),
      token('5 (20)', 340, y),
      token('5 (20)', 415, y)
    ])
  ]
  const result = refineTable(raw, source, [], [], [])
  expect(result.grid[1]).toEqual([
    'Treatment setting (number of lines for advanced disease) (%)',
    '',
    '',
    '',
    '0.254'
  ])
  expect(result.grid[2]).toEqual(['0', '10 (20)', '5 (20)', '5 (20)', ''])
  expect(result.grid).toHaveLength(4)
  expect(refineTable(raw, source, [], [], [[0, 45, 250, 45]]).grid).toHaveLength(5)
  const closed = source.map((t, i) =>
    i === 5 ? token('Treatment setting (number of lines)', 5, 30, 230) : t
  )
  expect(refineTable(raw, closed, [], [], []).grid).toHaveLength(5)
})
