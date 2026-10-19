import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
type Data = ReturnType<typeof JSON.parse>

function fixture(): Data {
  const entries = [
    ['REFERENCES', 225, 10, 70, 9],
    ['Alpha, A., Beta, B., et al. 2021, Journal, 12,', 10, 40, 200, 8],
    ['45, doi: 10.1234/example.first', 18, 52, 140, 8],
    ['Gamma, C., Delta, D., et al. 2022, Journal, 34,', 310, 40, 200, 8],
    ['67, doi: 10.1234/example.second', 318, 52, 150, 8]
  ] as const
  return {
    table: {
      id: 'citation-candidate',
      cropRect: [0, 0, 550, 80],
      structure: {
        objects: [
          ...[
            [0, 275],
            [275, 550]
          ].map(([left, right]) => ({
            label: 'table column',
            rect: [left, 0, right, 80]
          })),
          ...[
            [35, 50],
            [50, 70]
          ].map(([top, bottom]) => ({
            label: 'table row',
            rect: [0, top, 550, bottom]
          }))
        ]
      }
    },
    items: entries.map(([text, x, y, width, height], index) => ({
      text,
      rect: [x, y, x + width, y + height],
      height,
      baseline: y + height,
      horizontal: true,
      sourceItem: { pageNumber: 1, index, text }
    })),
    rules: [],
    captions: []
  }
}
const run = (input: Data): Data =>
  refineTable(input.table, input.items, input.captions, [], input.rules)

it('preserves two complete hanging citations while suspending their row-major table claim', () => {
  const input = fixture(),
    before = structuredClone(input),
    result = run(input)
  expect(result.issues).toContain('native-table-structure-ambiguous')
  expect(result.reviewCandidate).toBe(false)
  expect(result.cropRect).toEqual(input.table.cropRect)
  expect(result.grid).toEqual([
    [input.items[1].text, input.items[3].text],
    [input.items[2].text, input.items[4].text]
  ])
  expect(result.cells.flatMap((cell: Data) => cell.sourceItems).map((s: Data) => s.index)).toEqual([
    1, 3, 2, 4
  ])
  expect(input).toEqual(before)
})

it.each([
  [
    'missing heading',
    (f: Data) => {
      f.items.shift()
    }
  ],
  [
    'heading merely mentioned',
    (f: Data) => {
      f.items[0].text = f.items[0].sourceItem.text = 'See references below'
    }
  ],
  [
    'uncentered heading',
    (f: Data) => {
      f.items[0].rect = [10, 10, 80, 19]
    }
  ],
  [
    'missing DOI',
    (f: Data) => {
      f.items[2].text = f.items[2].sourceItem.text = 'An ordinary continuation'
    }
  ],
  [
    'no hanging indent',
    (f: Data) => {
      f.items[2].rect[0] = 10
    }
  ],
  [
    'mismatched hanging indent',
    (f: Data) => {
      f.items[4].rect[0] = 322
    }
  ],
  [
    'no author head',
    (f: Data) => {
      f.items[1].text = f.items[1].sourceItem.text = 'Recorded data from 2021, report'
    }
  ],
  [
    'native row-major stream',
    (f: Data) => {
      f.items[2].sourceItem.index = 3
      f.items[3].sourceItem.index = 2
    }
  ],
  [
    'ruling',
    (f: Data) => {
      f.rules.push([0, 35, 550, 35])
    }
  ],
  [
    'explicit table caption',
    (f: Data) => {
      f.captions.push({ page: 1, lines: ['Table 1. Citation comparison.'], rect: [0, 20, 550, 29] })
    }
  ],
  [
    'foreign ink',
    (f: Data) => {
      f.items.push({
        ...structuredClone(f.items[2]),
        text: 'Note',
        rect: [240, 52, 270, 60],
        sourceItem: { pageNumber: 1, index: 9, text: 'Note' }
      })
    }
  ],
  [
    'source alias outside region',
    (f: Data) => {
      f.items.push({ ...structuredClone(f.items[2]), rect: [0, 200, 140, 208] })
    }
  ],
  [
    'invalid native geometry',
    (f: Data) => {
      f.items[2].rect[0] = NaN
    }
  ]
] as [string, (f: Data) => void][])(
  'does not classify %s as a proved bibliography table error',
  (_name, mutate) => {
    const input = fixture()
    mutate(input)
    expect(run(input).issues).not.toContain('native-table-structure-ambiguous')
  }
)
