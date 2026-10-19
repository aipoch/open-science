import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const regions = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-regions.mjs')).href
)
type Token = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
  sourceItem: { pageNumber: number; index: number; text: string }
  sourceSegment?: unknown
}
function fixture(): {
  table: {
    id: string
    cropRect: number[]
    structure: { objects: { label: string; rect: number[] }[] }
  }
  items: Token[]
  rules: number[][]
  captions: { page: number; lines: string[]; rect: number[] }[]
} {
  let index = 0
  const items: Token[] = []
  for (const side of [0, 1])
    for (let row = 0; row < 4; row++)
      for (let col = 0; col < 3; col++) {
        const text = row ? String(side * 10 + row + col) : `H${col}`,
          x = side ? [130, 160, 195][col] : [10, 45, 85][col],
          y = 25 + row * 20
        items.push({
          text,
          rect: [x, y, x + 12, y + 8],
          baseline: y + 8,
          height: 8,
          horizontal: true,
          sourceItem: { pageNumber: 1, index: index++, text }
        })
      }
  return {
    table: {
      id: 'anonymous-right-table',
      cropRect: [90, 18, 222, 102],
      structure: {
        objects: [
          ...[90, 153, 186].map((x, col) => ({
            label: 'table column',
            rect: [x - 90, 2, [153, 186, 220][col] - 90, 82]
          })),
          ...[20, 40, 60, 80].map((y) => ({
            label: 'table row',
            rect: [0, y - 18, 130, y + 20 - 18]
          })),
          { label: 'table column header', rect: [0, 2, 130, 22] }
        ]
      }
    },
    items,
    rules: [
      ...[20, 40, 100].map((y) => [0, y, 100, y]),
      ...[20, 40, 100].map((y) => [120, y, 220, y])
    ],
    captions: [
      { page: 1, lines: ['Table 1: First trial'], rect: [10, 0, 90, 12] },
      { page: 1, lines: ['Table 2: Second trial'], rect: [130, 0, 210, 12] }
    ]
  }
}
it('assigns complete neighboring table sources once before refining the right candidate', () => {
  const f = fixture(),
    result = refineTable(f.table, f.items, f.captions, [], f.rules)
  expect(result.grid.slice(1)).toEqual([
    ['11', '12', '13'],
    ['12', '13', '14'],
    ['13', '14', '15']
  ])
  expect(
    result.cells
      .flatMap((c: { sourceItems?: { index: number }[] }) =>
        (c.sourceItems ?? []).map((i) => i.index)
      )
      .sort((a: number, b: number) => a - b)
  ).toEqual(f.items.slice(12).map((i) => i.sourceItem.index))
  expect(result.cropRect[0]).toBe(120)
})

it('bounds the mirrored left candidate without reversing native ownership', () => {
  const f = fixture(),
    width = f.table.cropRect[2] - f.table.cropRect[0]
  const mirror = (r: number[]): number[] => [-r[2], r[1], -r[0], r[3]]
  f.table.cropRect = mirror(f.table.cropRect)
  f.table.structure.objects = f.table.structure.objects.map((o) => ({
    ...o,
    rect: [width - o.rect[2], o.rect[1], width - o.rect[0], o.rect[3]]
  }))
  f.items = f.items.map((i) => ({ ...i, rect: mirror(i.rect) })).reverse()
  f.rules = f.rules.map(mirror).reverse()
  f.captions = f.captions.map((c) => ({ ...c, rect: mirror(c.rect) })).reverse()
  const result = refineTable(f.table, f.items, f.captions, [], f.rules)
  expect(result.cropRect[2]).toBe(-120)
  expect(result.grid.slice(1)).toEqual([
    ['13', '12', '11'],
    ['14', '13', '12'],
    ['15', '14', '13']
  ])
  expect(
    result.cells
      .flatMap((c: { sourceItems?: { index: number }[] }) =>
        (c.sourceItems ?? []).map((i) => i.index)
      )
      .sort((a: number, b: number) => a - b)
  ).toEqual(Array.from({ length: 12 }, (_, i) => i + 12))
})
it.each([
  'missing-rule',
  'missing-caption',
  'cross-gutter',
  'overlapping-frames',
  'item-alias',
  'segment-alias',
  'dual-carrier',
  'wrong-original',
  'competing-caption'
])('refuses independent ownership without complete evidence: %s', (variant) => {
  const f = fixture(),
    original = f.items[14]
  if (variant === 'missing-rule') f.rules.splice(2, 1)
  if (variant === 'missing-caption') f.captions.pop()
  if (variant === 'cross-gutter')
    f.items.push({
      ...original,
      text: 'bridge',
      rect: [96, 45, 124, 53],
      sourceItem: { pageNumber: 1, index: 100, text: 'bridge' }
    })
  if (variant === 'overlapping-frames')
    f.rules = f.rules.map((r) => (r[0] === 0 ? [...r.slice(0, 2), 130, r[3]] : r))
  if (variant === 'item-alias') f.items.push({ ...original, rect: [500, 400, 512, 408] })
  if (variant === 'segment-alias')
    f.items.push({
      text: 'alias',
      rect: [500, 400, 512, 408],
      baseline: 408,
      height: 8,
      horizontal: false,
      sourceSegment: { ...original.sourceItem, start: 0, end: 1, rect: [500, 400, 512, 408] }
    } as Token)
  if (variant === 'dual-carrier')
    original.sourceSegment = {
      ...original.sourceItem,
      start: 0,
      end: original.text.length,
      rect: original.rect
    }
  if (variant === 'wrong-original') original.sourceItem = { ...original.sourceItem, text: 'other' }
  if (variant === 'competing-caption')
    f.captions.push({ ...f.captions[1], lines: ['Table 3: Ambiguous'] })
  const before = structuredClone(f)
  expect(regions.boundNativeSideBySideTable(f.table, f.items, f.captions, f.rules)).toBeUndefined()
  expect(f).toEqual(before)
})
it('leaves an already independent candidate unchanged', () => {
  const f = fixture()
  f.table.cropRect[0] = 120
  expect(regions.boundNativeSideBySideTable(f.table, f.items, f.captions, f.rules)).toBeUndefined()
})
it('ignores a foreign segment identity outside both table frames', () => {
  const f = fixture()
  f.items.push({
    text: 'foreign',
    rect: [500, 400, 512, 408],
    baseline: 408,
    height: 8,
    horizontal: false,
    sourceSegment: {
      pageNumber: 2,
      index: 14,
      text: 'foreign',
      start: 0,
      end: 7,
      rect: [500, 400, 512, 408]
    }
  } as Token)
  expect(
    regions.boundNativeSideBySideTable(f.table, f.items, f.captions, f.rules)?.cropRect[0]
  ).toBe(120)
})

it('recovers a clipped inner edge and conserves both complete table inventories together', () => {
  const f = fixture()
  const left = {
    id: 'anonymous-left-clipped',
    cropRect: [-2, 18, 90, 102],
    structure: {
      objects: [
        ...[0, 33, 66].map((x, c) => ({
          label: 'table column',
          rect: [x + 2, 2, [33, 66, 90][c] + 2, 82]
        })),
        ...[20, 40, 60, 80].map((y) => ({ label: 'table row', rect: [2, y - 18, 92, y + 2] })),
        { label: 'table column header', rect: [2, 2, 92, 22] }
      ]
    }
  }
  const result = [left, f.table].map((table) =>
    refineTable(table, f.items, f.captions, [], f.rules)
  )
  expect(result[0].cropRect[2]).toBe(100)
  expect(result[0].grid.slice(1)).toEqual([
    ['1', '2', '3'],
    ['2', '3', '4'],
    ['3', '4', '5']
  ])
  const originals = result.flatMap((t) =>
    t.cells.flatMap((c: { sourceItems?: { index: number; text: string }[] }) => c.sourceItems ?? [])
  )
  expect(
    originals.map((i: { index: number }) => i.index).sort((a: number, b: number) => a - b)
  ).toEqual(f.items.map((i) => i.sourceItem.index))
  expect(originals.flatMap((i: { text: string }) => [...i.text]).sort()).toEqual(
    f.items.flatMap((i) => [...i.text]).sort()
  )
})
it.each(['sourceItem', 'sourceSegment'] as const)(
  'rejects a nested %s alias outside the table area',
  (carrier) => {
    const f = fixture(),
      original = f.items[14]
    f.items.push(
      Object.assign(
        {
          ...original,
          rect: [500, 400, 512, 408],
          sourceItem: { ...original.sourceItem, index: 100 }
        },
        {
          sourceToken: {
            [carrier]: { ...original.sourceItem, start: 0, end: 1, rect: original.rect }
          }
        }
      )
    )
    expect(
      regions.boundNativeSideBySideTable(f.table, f.items, f.captions, f.rules)
    ).toBeUndefined()
  }
)

it('rejects a direct sourceToken identity alias outside the table area', () => {
  const f = fixture(),
    original = f.items[14]
  f.items.push(
    Object.assign(
      {
        ...original,
        rect: [500, 400, 512, 408],
        sourceItem: { ...original.sourceItem, index: 100 }
      },
      { sourceToken: { ...original.sourceItem } }
    )
  )
  expect(regions.boundNativeSideBySideTable(f.table, f.items, f.captions, f.rules)).toBeUndefined()
})

it('refuses a native token carrying its own identity through sourceToken as well', () => {
  const f = fixture()
  Object.assign(f.items[14], { sourceToken: { ...f.items[14].sourceItem } })
  expect(regions.boundNativeSideBySideTable(f.table, f.items, f.captions, f.rules)).toBeUndefined()
})
