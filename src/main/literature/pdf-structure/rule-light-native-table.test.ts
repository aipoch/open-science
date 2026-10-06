import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { recoverCaptionedRuledTables } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-regions.mjs')).href
)

const token = (text: string, x: number, y: number, width = 70): object => ({
  text,
  rect: [x, y, x + width, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})

const table = (): ReturnType<typeof JSON.parse> => ({
  id: 'anonymous-rule-light-table',
  cropRect: [0, 0, 400, 220],
  structure: {
    objects: [
      ...[0, 1, 2, 3].map((row) => ({
        label: 'table row',
        rect: [0, 30 + row * 35, 400, 60 + row * 35]
      })),
      { label: 'table column', rect: [0, 0, 180, 220] },
      { label: 'table column', rect: [180, 0, 400, 220] }
    ]
  }
})

const caption = (y: number): { page: number; lines: string[]; rect: number[] } => ({
  page: 1,
  lines: ['Table 1: Scores for held-out data.'],
  rect: [20, y, 300, y + 10]
})

const items = [
  token('Metric', 20, 35),
  token('Value', 220, 35),
  token('Alpha', 20, 70),
  token('0.91', 220, 70),
  token('Beta', 20, 105),
  token('0.87', 220, 105),
  token('Gamma', 20, 140),
  token('0.82', 220, 140)
]

it('keeps every cell in a two-column native table without vertical or bottom rules', () => {
  const result = refineTable(table(), items, [caption(5)], [], [])
  expect(result.grid).toEqual([
    ['Metric', 'Value'],
    ['Alpha', '0.91'],
    ['Beta', '0.87'],
    ['Gamma', '0.82']
  ])
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
})

it('associates a caption below a rule-light table without requiring a footer rule', () => {
  const page = {
    pageNumber: 1,
    width: 400,
    height: 300,
    lines: [
      {
        x: 20,
        y: 190,
        width: 260,
        height: 10,
        text: 'Table 1: Scores for held-out data.',
        fontSize: 10
      }
    ],
    graphicsBounds: []
  }
  const result = associateTableCaptions(page, [{ rect: [0, 30, 400, 170] }], [caption(190)])
  expect(result[0].caption).toEqual(caption(190))
})

it('keeps a below-table caption outside the table cell grid', () => {
  const result = refineTable(table(), items, [caption(190)], [], [])
  expect(result.grid).toHaveLength(4)
  expect(result.grid.flat()).not.toContain('Table 1: Scores for held-out data.')
  expect(result.unassigned).toEqual([])
})

it('does not synthesize a header when the detector supplied no table rows', async () => {
  const { recoverClippedColumnHeader } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-header-grid.mjs')).href
  )
  const result = recoverClippedColumnHeader(
    {
      cropRect: [0, 40, 400, 220],
      structure: {
        objects: [
          { label: 'table column', rect: [0, 0, 180, 180] },
          { label: 'table column', rect: [180, 0, 400, 180] }
        ]
      }
    },
    [token('Metric', 20, 20), token('Value', 220, 20)],
    [[0, 35, 400, 35]],
    []
  )
  expect(result).toBeUndefined()
})

it('recovers a missing side-by-side booktabs table from captioned rules and text rows', () => {
  const caption = {
    page: 1,
    lines: ['Table 1: Ablation scores.'],
    rect: [20, 10, 180, 20]
  }
  const items = [
    token('Method Score A Score B', 25, 45, 180),
    token('Alpha 0.91 0.84', 25, 65, 180),
    token('Beta 0.87 0.81', 25, 105, 180),
    token('Gamma 0.82 0.79', 25, 125, 180)
  ]
  const rules = [
    [20, 40, 220, 40],
    [100, 40, 100, 140],
    [160, 40, 160, 140],
    [20, 90, 220, 90],
    [20, 140, 220, 140]
  ]
  const [recovered] = recoverCaptionedRuledTables(items, rules, [caption], 1)
  expect(recovered.cropRect).toEqual([20, 40, 220, 140])
  expect(
    recovered.structure.objects.filter((object: { label: string }) => object.label === 'table row')
  ).toHaveLength(4)
  expect(
    recovered.structure.objects.filter(
      (object: { label: string }) => object.label === 'table column'
    )
  ).toHaveLength(3)
})

it('recovers every table in a stacked open-rule page and keeps caption order', () => {
  const captions = [
    { page: 1, lines: ['Table 1: First benchmark.'], rect: [20, 10, 180, 20] },
    { page: 1, lines: ['Table 2: Second benchmark.'], rect: [20, 190, 180, 200] }
  ]
  const items = [
    token('Method Score', 25, 45, 160),
    token('Alpha 0.91', 25, 65, 160),
    token('Beta 0.87', 25, 85, 160),
    token('Gamma 0.82', 25, 105, 160),
    token('Method Score', 25, 225, 160),
    token('Alpha 0.81', 25, 245, 160),
    token('Beta 0.77', 25, 265, 160),
    token('Gamma 0.72', 25, 285, 160)
  ]
  const rules = [
    [20, 40, 220, 40],
    [100, 40, 100, 140],
    [160, 40, 160, 140],
    [20, 140, 220, 140],
    [20, 220, 220, 220],
    [100, 220, 100, 320],
    [160, 220, 160, 320],
    [20, 320, 220, 320]
  ]
  const recovered = recoverCaptionedRuledTables(items, rules, captions, 1)
  expect(recovered).toHaveLength(2)
  expect(
    recovered.map((table: { caption?: { lines: string[] } }) => table.caption?.lines[0])
  ).toEqual(['Table 1: First benchmark.', 'Table 2: Second benchmark.'])
  expect(
    recovered.map(
      (table: { structure: { objects: { label: string }[] } }) =>
        table.structure.objects.filter((object) => object.label === 'table row').length
    )
  ).toEqual([4, 4])
})

it('stops an open-rule crop before a shifted chart grid below the table', () => {
  const caption = {
    page: 1,
    lines: ['Table 1: Benchmark scores.'],
    rect: [20, 10, 180, 20]
  }
  const items = [
    token('Method Score', 25, 45, 160),
    token('Alpha 0.91', 25, 65, 160),
    token('Beta 0.87', 25, 85, 160),
    token('Gamma 0.82', 25, 105, 160),
    token('Darcy 3×10−1', 55, 205, 160),
    token('Burgers 0.01', 55, 245, 160)
  ]
  const rules = [
    [20, 40, 220, 40],
    [100, 40, 100, 140],
    [160, 40, 160, 140],
    [20, 90, 220, 90],
    [20, 140, 220, 140],
    [50, 290, 220, 290],
    [50, 320, 220, 320]
  ]
  const [recovered] = recoverCaptionedRuledTables(items, rules, [caption], 1)
  expect(recovered.cropRect).toEqual([20, 40, 220, 140])
  expect(
    recovered.structure.objects.filter((object: { label: string }) => object.label === 'table row')
  ).toHaveLength(4)
})

it('does not add a prose-spanning open-rule duplicate when a complete table owns the caption', () => {
  const caption = {
    page: 1,
    lines: ['Table 15 | Benchmark scores.'],
    rect: [20, 150, 220, 160]
  }
  const items = [
    token('Method', 25, 50),
    token('Score', 125, 50),
    token('Alpha', 25, 75),
    token('0.91', 125, 75),
    token('Beta', 25, 100),
    token('0.87', 125, 100),
    token('Method Score', 25, 185, 160),
    token('Gamma 0.82', 25, 215, 160),
    token('Delta 0.79', 25, 245, 160)
  ]
  const rules = [
    [20, 180, 220, 180],
    [20, 205, 220, 205],
    [20, 275, 220, 275]
  ]
  const existing = {
    id: 'detector-table-above-caption',
    cropRect: [20, 40, 220, 120],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 0, 200, 25] },
        { label: 'table row', rect: [0, 25, 200, 50] },
        { label: 'table row', rect: [0, 50, 200, 75] },
        { label: 'table column', rect: [0, 0, 100, 80] },
        { label: 'table column', rect: [100, 0, 200, 80] }
      ]
    }
  }
  expect(recoverCaptionedRuledTables(items, rules, [caption], 1, [existing])).toEqual([])
})
