import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

const token = (
  text: string,
  x: number,
  y: number,
  width = Math.max(5, text.length * 4)
): {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
  font: string
} => ({
  text,
  rect: [x, y, x + width, y + 8],
  baseline: y + 8,
  height: 8,
  horizontal: true,
  font: 'Anonymous-Regular'
})

const sourceTable = (): ReturnType<typeof JSON.parse> => ({
  id: 'anonymous-source-record',
  page: 1,
  cropRect: [0, 0, 500, 220],
  structure: {
    objects: [
      ...Array.from({ length: 5 }, (_, column) => ({
        label: 'table column',
        score: 0.99,
        rect: [column * 100, 0, (column + 1) * 100, 220]
      })),
      ...[10, 28, 46, 64, 82, 100, 118, 136, 154].map((top, index) => ({
        label: index < 2 ? 'table column header' : 'table row',
        score: 0.99,
        rect: [0, top, 500, top + 12]
      }))
    ]
  }
})

const caption = [
  {
    page: 1,
    lines: ['TABLE V WGA (%) ON CELEBA-STD (RESNET-50)'],
    rect: [0, -40, 400, -30]
  }
]

const tokens = (misaligned = false): ReturnType<typeof token>[] => [
  token('WGA (%)', 220, 10, 50),
  ...['Method', 'Paradigm', 'Published', 'Reproduced', '+BFR'].map((text, column) =>
    token(text, column * 100 + 5, 28)
  ),
  ...['ERM', 'Baseline', '47.7', '49.1', '50.6'].map((text, column) =>
    token(text, column * 100 + 5, 46)
  ),
  ...['GroupDRO †', 'Supervised', '89.3', '88.0', '88.5'].map((text, column) =>
    token(text, column * 100 + 5, 136)
  ),
  token('HierDRO', 5, 154),
  token('†', 40, 154),
  token('Supervised ref.', 105, 154),
  token('90.4', misaligned ? 305 : 205, 154),
  token('—', 305, 154),
  token('—', 405, 154),
  token('note remains unstructured', 5, 205, 120)
]

it('preserves a complete source-owned final record and leaves its note unassigned', () => {
  const result = refineTable(sourceTable(), tokens(), caption, [], [])
  expect(result.grid.at(-1)).toEqual(['HierDRO †', 'Supervised ref.', '90.4', '—', '—'])
  expect(result.unassigned).toContain('note remains unstructured')
})

it('does not force a final source record when a value is in the wrong column', () => {
  const result = refineTable(sourceTable(), tokens(true), caption, [], [])
  expect(result.repairs).not.toContain('source-hierdro-record-recovered')
  expect(result.unassigned).toContain('note remains unstructured')
})
