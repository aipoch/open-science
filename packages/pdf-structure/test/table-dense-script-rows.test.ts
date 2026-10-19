import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { pairDenseStatisticalScriptRows } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-row-repair.mjs')).href
)

type SourceToken = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
  sourceItem: { pageNumber: number; index: number; text: string }
}

function fixture(scale = 1): {
  table: {
    id: string
    cropRect: number[]
    structure: { objects: { label: string; score: number; rect: number[] }[] }
  }
  items: SourceToken[]
} {
  let index = 0
  const token = (text: string, x: number, baseline: number, height: number): SourceToken => ({
    text,
    rect: [x, baseline - height, x + text.length * height * 0.5, baseline].map((n) => n * scale),
    baseline: baseline * scale,
    height: height * scale,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  const items = Array.from({ length: 10 }, (_, row) => {
    const baseline = 25 + row * 23
    return Array.from({ length: 10 }, (_, column) => {
      const x = 10 + column * 70
      const main = token(column === 0 ? `Record${row}` : `${column + row}.2`, x, baseline, 12)
      if (row === 0 || ![4, 7, 9].includes(column)) return [main]
      const right = main.rect[2] / scale
      return [
        token('+', right, baseline - 5, 9),
        token('3', right + 4.5, baseline - 5, 9),
        token('.', right + 9, baseline - 5, 9),
        token('4', right + 13.5, baseline - 5, 9),
        main
      ]
    }).flat()
  })
    .flat()
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  const cropRect = [0, 10, 700, 240].map((n) => n * scale)
  const table = {
    id: 'dense-script-records',
    cropRect,
    structure: {
      objects: [
        ...Array.from({ length: 10 }, (_, column) => ({
          label: 'table column',
          score: 1,
          rect: [column * 70, 10, (column + 1) * 70, 240].map((n) => n * scale)
        })),
        ...Array.from({ length: 10 }, (_, row) => ({
          label: 'table row',
          score: 1,
          rect: [0, 10 + row * 23, 700, 33 + row * 23].map((n) => n * scale)
        }))
      ]
    }
  }
  return { table, items }
}

it.each([1, 1.7])(
  'keeps raised numeric fragments in their dense source records at scale %s',
  (scale) => {
    const { table, items } = fixture(scale)
    const result = refineTable(table, items)
    expect(result.repairs).toContain('dense-statistical-rows-recovered')
    expect(result.grid).toHaveLength(10)
    expect(result.grid.filter((row) => row.every((text) => text === ''))).toEqual([])
    const source = result.cells.flatMap((cell) => cell.sourceItems ?? [])
    expect(source.sort((a, b) => a.index - b.index)).toEqual(
      items.map((item) => item.sourceItem).sort((a, b) => a.index - b.index)
    )
    expect(result.unassigned).toEqual([])
    expect(result.cells.flatMap((cell) => [...cell.text]).sort()).toEqual(
      items.flatMap((item) => [...item.text]).sort()
    )
  }
)

function scriptGroups(): SourceToken[][] {
  const { items } = fixture()
  return [...Map.groupBy(items, (item) => item.baseline).values()]
}

it.each(['whole', 'segment', 'nested whole', 'nested segment'])(
  'keeps script rows unchanged when a crop-external %s carrier aliases their native owner',
  (carrier) => {
    const groups = scriptGroups()
    const item = groups[1][0]
    const alias = {
      text: item.text,
      rect: [900, 10, 910, 20],
      ...(carrier === 'whole' ? { sourceItem: item.sourceItem } : {}),
      ...(carrier === 'segment'
        ? { sourceSegment: { ...item.sourceItem, start: 0, end: item.text.length } }
        : {}),
      ...(carrier === 'nested whole' ? { sourceToken: item } : {}),
      ...(carrier === 'nested segment'
        ? {
            sourceToken: { sourceSegment: { ...item.sourceItem, start: 0, end: item.text.length } }
          }
        : {})
    }
    expect(pairDenseStatisticalScriptRows(groups, [], [], [...groups.flat(), alias])).toBe(groups)
  }
)

it('accepts an unrelated native identity outside the dense script rows', () => {
  const groups = scriptGroups()
  const item = groups[1][0]
  const foreign = {
    text: item.text,
    rect: [900, 10, 910, 20],
    sourceItem: { pageNumber: 2, index: 10000, text: item.text },
    sourceToken: undefined,
    sourceSegment: undefined
  }
  expect(pairDenseStatisticalScriptRows(groups, [], [], [...groups.flat(), foreign])).toHaveLength(
    10
  )
})

it('pairs only script baselines without dropping or cloning any source token', () => {
  const groups = scriptGroups()
  const snapshot = structuredClone(groups)
  const paired = pairDenseStatisticalScriptRows(groups, [], [])
  expect(paired).toHaveLength(10)
  expect(groups).toEqual(snapshot)
  expect(paired.flat()).toHaveLength(groups.flat().length)
  expect(new Set(paired.flat())).toEqual(new Set(groups.flat()))
})

it.each([
  'rule',
  'span',
  'no-origin',
  'hidden-source',
  'duplicate-origin',
  'detached',
  'ordinary-row'
])('keeps the original dense row groups with %s evidence', (kind) => {
  const groups = scriptGroups()
  const rules: number[][] = []
  const objects: { label: string; rect: number[] }[] = []
  const scripts = groups[1]
  if (kind === 'rule') rules.push([0, 42, 700, 42])
  if (kind === 'span') objects.push({ label: 'table spanning cell', rect: [0, 30, 700, 52] })
  if (kind === 'no-origin') delete (scripts[0] as { sourceItem?: object }).sourceItem
  if (kind === 'hidden-source') scripts[0].sourceItem.text += ' hidden'
  if (kind === 'duplicate-origin') scripts[1].sourceItem = scripts[0].sourceItem
  if (kind === 'detached') scripts[0].rect = [650, 0, 655, 9]
  if (kind === 'ordinary-row') {
    for (const item of scripts) {
      item.height = 12
      item.rect[1] = item.baseline - 12
    }
  }
  const result = pairDenseStatisticalScriptRows(groups, rules, objects)
  if (kind === 'ordinary-row') {
    expect(result).toHaveLength(11)
    expect(
      result.some(
        (group) => group.length === scripts.length && scripts.every((i) => group.includes(i))
      )
    ).toBe(true)
  } else expect(result).toBe(groups)
})

it('keeps a script baseline with two geometrically plausible record owners', () => {
  const { items } = fixture()
  const main = items.find((item) => item.text === '1.2')!
  const upper = { ...main, baseline: 22, rect: [0, 10, 18, 22] }
  const lower = {
    ...main,
    baseline: 30,
    rect: [0, 18, 18, 30],
    sourceItem: { ...main.sourceItem, index: 10001 }
  }
  const script = {
    ...main,
    text: '3',
    height: 9,
    baseline: 26,
    rect: [18, 17, 22.5, 26],
    sourceItem: { pageNumber: 1, index: 10002, text: '3' }
  }
  const groups = [[upper], [script], [lower]]
  expect(pairDenseStatisticalScriptRows(groups, [], [])).toBe(groups)
})

it('preserves a source-owned whitespace token when pairing a script baseline', () => {
  const groups = scriptGroups()
  const last = groups[1][3]
  const whitespace = {
    ...last,
    text: ' ',
    rect: [last.rect[2], last.rect[1], last.rect[2] + 1, last.rect[3]],
    sourceItem: { pageNumber: 1, index: 10000, text: ' ' }
  }
  groups[1].splice(4, 0, whitespace)
  const paired = pairDenseStatisticalScriptRows(groups, [], [])
  expect(paired).toHaveLength(10)
  expect(paired.flat().filter((item) => item === whitespace)).toEqual([whitespace])
})

it.each([
  [1, false, false],
  [2, false, false],
  [1, true, false],
  [1, true, true]
] as const)(
  'does not recover adjacent wide records twice at scale %s with extra caption %s and partial frames %s',
  (scale, extraCaption, partialFrames) => {
    let index = 0
    const token = (text: string, column: number, y: number, height: number): SourceToken => ({
      text,
      rect: [column * 100 + 10, y, column * 100 + 10 + text.length * 5, y + height].map(
        (n) => n * scale
      ),
      baseline: (y + height) * scale,
      height: height * scale,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: index++, text }
    })
    const items = [
      ...Array.from({ length: 8 }, (_, column) => token(`H${column}`, column, 3, 10)),
      ...Array.from({ length: 5 }, (_, row) =>
        Array.from({ length: 8 }, (_, column) =>
          token(column ? `${row + column}.5` : `Record${row}`, column, 17 + row * 18, 18)
        )
      ).flat()
    ]
    const result = refineTable(
      {
        cropRect: [0, 0, 800, 112].map((n) => n * scale),
        structure: {
          objects: [
            ...Array.from({ length: 8 }, (_, column) => ({
              label: 'table column',
              rect: [column * 100, 0, (column + 1) * 100, 112].map((n) => n * scale)
            })),
            { label: 'table column header', rect: [0, 0, 800, 20].map((n) => n * scale) },
            { label: 'table row', rect: [0, 0, 800, 20].map((n) => n * scale) },
            ...Array.from({ length: 5 }, (_, row) => ({
              label: 'table row',
              rect: [0, 20 + row * 18, 800, 38 + row * 18].map((n) => n * scale)
            }))
          ]
        }
      },
      items,
      [
        { page: 1, lines: ['Table 1. Records'], rect: [0, -20, 200, -5].map((n) => n * scale) },
        ...(extraCaption
          ? [
              {
                page: 1,
                lines: ['Table 2. Other'],
                rect: [400, -20, 600, -5].map((n) => n * scale)
              }
            ]
          : [])
      ],
      [],
      partialFrames
        ? [0, 15, 110].flatMap((y) => [
            [0, y, 200, y],
            [400, y, 600, y]
          ])
        : []
    )
    expect(result.repairs).not.toContain('stacked-wide-record-rows-recovered')
    expect(result.grid).toHaveLength(6)
    expect(result.grid.filter((row: string[]) => row.every((text) => !text))).toHaveLength(0)
    expect(
      result.cells
        .flatMap((cell: { sourceItems?: Array<{ index: number }> }) =>
          (cell.sourceItems ?? []).map((item) => item.index)
        )
        .sort((a: number, b: number) => a - b)
    ).toEqual(items.map((item) => item.sourceItem.index))
  }
)
