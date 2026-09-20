import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { matchFigureSequence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-sequence.mjs')).href
)
const { associateFigures, associateAdjacentFigure, resolveFigureCaption } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { excludeRepeatedMarginContent } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-graphics.mjs')).href
)
const { refineTable, hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

type LegendPage = {
  pageNumber: number
  lines: { text: string; x: number; y: number; right: number; bottom: number }[]
}
const legendPage = (pageNumber: number, texts: string[]): LegendPage => ({
  pageNumber,
  lines: texts.map((text, i) => ({ text, x: 40, y: 60 + i * 15, right: 550, bottom: 72 + i * 15 }))
})
const sequence = (): LegendPage[] => [
  legendPage(20, ['Figure legends', 'Fig. 1. First experiment.', 'Panel A describes the result.']),
  legendPage(21, ['Panel B continues the first legend.', 'Fig. 2. Second experiment.']),
  legendPage(22, []),
  legendPage(23, []),
  legendPage(24, ['Highlights'])
]
it('associates an explicitly numbered legend section with its exact consecutive plate sequence', () => {
  const result = matchFigureSequence(sequence())
  expect([...result.keys()]).toEqual([22, 23])
  expect(result.get(22).page).toBe(20)
  expect(result.get(22).lines.at(-1)).toBe('Panel B continues the first legend.')
  expect(result.get(23).lines).toEqual(['Fig. 2. Second experiment.'])
})
it('does not guess plate ownership with absent headings, missing plates, or out-of-order numbers', () => {
  const noHeading = sequence()
  noHeading[0].lines.shift()
  const missingPlate = sequence().filter((p) => p.pageNumber !== 23)
  const wrongNumber = sequence()
  wrongNumber[1].lines[1].text = 'Fig. 3. Another figure.'
  for (const pages of [noHeading, missingPlate, wrongNumber])
    expect(matchFigureSequence(pages).size).toBe(0)
})
it('resolves a previous-page legend without borrowing another figure number', () => {
  const pointer = {
    page: 10,
    lines: ['Fig. 5 (See legend on previous page.)'],
    rect: [40, 700, 550, 715]
  }
  const full = {
    page: 9,
    lines: ['Fig. 5 EIF4A3 promotes circCCAR1 expression.'],
    rect: [40, 690, 550, 730]
  }
  expect(resolveFigureCaption(pointer, [full, pointer])).toBe(full)
  expect(resolveFigureCaption(pointer, [{ ...full, lines: ['Fig. 4 Other experiment.'] }])).toBe(
    pointer
  )
})
it('retains the upper vector panels of a tall figure whose caption is more than 400 points away', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [],
    invalidGraphicsBounds: 0,
    graphicsBounds: [
      { kind: 'path', normalizedRect: [0.1, 0.08, 0.4, 0.2] },
      { kind: 'image', normalizedRect: [0.1, 0.3, 0.9, 0.7] }
    ]
  }
  const result = associateFigures(page, [
    { page: 1, lines: ['Fig. 1. Multipanel experiment.'], rect: [40, 600, 560, 700] }
  ])
  expect(result[0].rect).toEqual([60, 64, 540, 560])
})
it('removes a repeated raster overlay while keeping distinct manuscript plates', () => {
  const watermark = { kind: 'image', imageHash: 'watermark', normalizedRect: [0.1, 0.2, 0.9, 0.8] }
  const pages = [1, 2, 3].map((pageNumber) => ({
    pageNumber,
    width: 600,
    height: 800,
    lines: [],
    graphicsBounds: [
      watermark,
      { kind: 'image', imageHash: `plate-${pageNumber}`, normalizedRect: [0.2, 0.3, 0.8, 0.7] }
    ]
  }))
  expect(
    excludeRepeatedMarginContent(pages).map((p: { graphicsBounds: { imageHash: string }[] }) =>
      p.graphicsBounds.map((g) => g.imageHash)
    )
  ).toEqual([['plate-1'], ['plate-2'], ['plate-3']])
  expect(
    excludeRepeatedMarginContent(pages.map((p) => ({ ...p, graphicsBounds: [watermark] })))[0]
      .graphicsBounds
  ).toHaveLength(1)
})
it('does not interpret consecutive manuscript line numbers beside fragmented prose as a data column', () => {
  const table = {
    cropRect: [0, 0, 600, 300],
    grid: Array.from({ length: 6 }, (_, i) => [
      String(101 + i),
      'A long prose sentence in the manuscript.'
    ]),
    issues: []
  }
  const items = table.grid.flatMap((row, i) => [
    {
      text: row[0],
      rect: [10, i * 30, 30, i * 30 + 12],
      baseline: i * 30 + 12,
      height: 12,
      horizontal: true
    },
    ...['The manuscript paragraph', 'continues across the', 'numbered lines of text.'].map(
      (text, j) => ({
        text,
        rect: [60 + j * 160, i * 30, 210 + j * 160, i * 30 + 12],
        baseline: i * 30 + 12,
        height: 12,
        horizontal: true
      })
    )
  ])
  expect(hasTableEvidence(table, undefined, items)).toBe(false)
  expect(hasTableEvidence(table, { lines: ['Table 1. Indexed records'] }, items)).toBe(true)
})
it('includes outer single-letter panel labels without widening the adjacent-page prose margin', () => {
  const page = {
    pageNumber: 1,
    rotation: 0,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: 'a', x: 77, y: 80, width: 8, height: 12 },
      { text: 'Unrelated prose', x: 77, y: 100, width: 90, height: 12 }
    ],
    graphicsBounds: [{ kind: 'image', normalizedRect: [1 / 6, 0.12, 0.95, 0.9] }]
  }
  const neighbor = { ...page, pageNumber: 2, lines: [], graphicsBounds: [] }
  const result = associateAdjacentFigure(
    page,
    [page, neighbor],
    [{ page: 2, lines: ['Fig. 1. Adjacent experiment.'], rect: [40, 60, 560, 120] }]
  )
  expect(result[0].rect).toEqual([77, 80, 570, 720])
})
it('recovers a single missing group label from the gap between complete numeric records', () => {
  const labels = ['Age', 'young', 'old', 'Sex', 'female', 'male', 'T stage', 'early', 'late']
  const source = {
    cropRect: [0, 0, 400, 200],
    structure: {
      objects: [
        ...[0, 100, 200, 300].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 200] })),
        ...labels.flatMap((_, i) =>
          i === 6
            ? []
            : [{ label: 'table row', rect: [0, i * 20, 400, i * 20 + (i === 5 ? 26 : 20)] }]
        )
      ]
    }
  }
  const items = labels.flatMap((label, i) =>
    [label, ...(i % 3 ? ['20', '8', '12'] : [])].map((text, c) => ({
      text,
      rect: [5 + c * 100, i * 20 + 4, 65 + c * 100, i * 20 + 16],
      baseline: i * 20 + 16,
      height: 12,
      horizontal: true
    }))
  )
  const result = refineTable(source, items)
  expect(result.grid).toHaveLength(9)
  expect(result.grid[6]).toEqual(['T stage', '', '', ''])
  expect(result.unassigned).toEqual([])
  expect(result.grid[7]).toEqual(['early', '20', '8', '12'])
})

it('matches a missing first plate number only when later plate numbers confirm the complete sequence', () => {
  const pages = [
    legendPage(16, ['List of Figures', 'Figure 1: Workflow.', 'Figure 2: Results.']),
    legendPage(17, []),
    legendPage(18, ['Panel A', 'Figure 2']),
    legendPage(19, ['Permissions'])
  ]
  expect([...matchFigureSequence(pages).keys()]).toEqual([17, 18])
  pages[2].lines[1].text = 'Figure 3'
  expect(matchFigureSequence(pages).size).toBe(0)
})

it('matches ordered manuscript plates after intervening numbered tables and a central illustration', () => {
  const pages = [
    legendPage(20, ['Figure legends', 'Figure 1: First plot.', 'Figure 2: Second plot.']),
    legendPage(21, ['The second legend continues.', 'Central Illustration: Study design.']),
    legendPage(22, ['The final illustration legend continues.']),
    legendPage(23, ['Table 1: Demographic characteristics.']),
    legendPage(24, ['Continued table notes.']),
    legendPage(25, []),
    legendPage(26, []),
    legendPage(27, []),
    legendPage(28, ['Supplemental methods'])
  ]
  const result = matchFigureSequence(pages)
  expect([...result.keys()]).toEqual([25, 26, 27])
  expect(result.get(26).lines).toEqual(['Figure 2: Second plot.', 'The second legend continues.'])
  expect(result.get(27).endPage).toBe(22)
  expect(result.get(27).lines).not.toContain('Table 1: Demographic characteristics.')
  pages.splice(6, 1)
  expect(matchFigureSequence(pages).size).toBe(0)
})
it('does not cross another figure sequence while skipping manuscript tables', () => {
  const pages = [
    legendPage(20, ['Figure legends', 'Figure 1: First.', 'Figure 2: Second.']),
    legendPage(21, ['Table 1: Results']),
    legendPage(22, ['Supplemental Figure 1: Different sequence.']),
    legendPage(23, []),
    legendPage(24, [])
  ]
  expect(matchFigureSequence(pages).size).toBe(0)
})
it('recognizes an explicit appendix flow-diagram title while rejecting ordinary appendix prose', async () => {
  const { captionKind } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
  )
  expect(captionKind('Appendix E. Consort flow diagram')).toBe('figure')
  expect(captionKind('Appendix A. Flowchart')).toBe('figure')
  expect(captionKind('Appendix E. Methods and results')).toBeUndefined()
  expect(captionKind('Appendix E. A flow diagram is discussed below')).toBeUndefined()
})
