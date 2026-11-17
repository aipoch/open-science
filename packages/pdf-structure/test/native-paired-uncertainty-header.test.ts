import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'

const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { recoverNativeTwoTierParentHeaderGrid } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-header-ownership.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

function pairedCountGrid(variant = ''): ReturnType<typeof JSON.parse> {
  const height = 180
  const viewport = {
    width: 540,
    height,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, height],
    convertToViewportPoint: (x: number, y: number): number[] => [x, height - y]
  }
  const raw: ReturnType<typeof JSON.parse>[] = []
  const draw = (text: string, x: number, baseline: number, width: number): void => {
    raw.push({
      str: text,
      dir: 'ltr',
      width,
      height: 10,
      fontName: 'regular',
      transform: [10, 0, 0, 10, x, height - baseline],
      sourceItem: { pageNumber: 1, index: raw.length, text }
    })
  }
  const start = 20,
    finish = 500,
    opening = 35,
    divider = 62,
    closing = 122
  const center = (column: number): number => start + column * 60 + 30
  const title = 'Table 1: Paired measurements.'
  draw(title, 25, 30, 145)
  for (const [text, column] of [
    ['Site', 0],
    ['Input', 1],
    ['Pass', 6],
    ['Final', 7]
  ] as const)
    draw(text, center(column) - 12, 45, 24)
  draw('Sample A', variant === 'uncentered parent' ? 210 : 183, 45, 34)
  draw('Sample B', 303, 45, 34)
  for (const [text, column] of [
    ['Scale', 1],
    ['#', 2],
    ['〈Index〉', 3],
    ['#', 4],
    ['〈Index〉', 5],
    ['Share', 6],
    ['Score', 7]
  ] as const) {
    draw(text, center(column) - (text === '#' ? 3 : 15), 57, text === '#' ? 6 : 30)
  }
  for (const [row, y] of [76, 89, 102, 115].entries()) {
    draw(`Area ${row + 1}`, center(0) - 20, y, 33)
    draw('0.7', center(1) - 7, y, 14)
    draw(String(row + 3), center(2) - 3, y, 6)
    draw(String(row + 4), center(4) - 3, y, 6)
    draw('0.2', center(6) - 7, y, 14)
    for (const c of [3, 5, 7]) {
      draw('1.0', center(c) - 17, y, 12)
      draw(
        variant === 'nonliteral uncertainty' && row === 2 && c === 5 ? '/' : '±',
        center(c) - 3,
        y,
        6
      )
      draw('0.2', center(c) + 5, y, 12)
    }
  }
  return {
    table: {
      cropRect: [start, 28, finish, 124],
      readingRotation: 0,
      structure: {
        objects: Array.from({ length: 8 }, (_, column) => ({
          label: 'table column',
          rect: [column * 60, 0, (column + 1) * 60, 96]
        }))
      }
    },
    items: raw.map((item) => tableTextToken(item, viewport, 0)),
    captions: [{ page: 1, rect: [25, 20, 170, 30], lines: [title] }],
    rules: [opening, divider, closing].map((y) => [start, y, finish, y]),
    context: {
      viewport,
      sourceContent: {
        items: raw,
        styles: { regular: { fontFamily: 'serif', ascent: 0.75, descent: -0.25 } }
      }
    }
  }
}

it('preserves paired count and uncertainty columns under their printed parents', () => {
  const { table, items, captions, rules, context } = pairedCountGrid()
  const proof = recoverNativeTwoTierParentHeaderGrid(table, items, captions, rules, context)
  expect(proof?.spans.filter((span: { colSpan: number }) => span.colSpan === 2)).toEqual([
    { row: 0, column: 2, rowSpan: 1, colSpan: 2 },
    { row: 0, column: 4, rowSpan: 1, colSpan: 2 }
  ])
  const result = refineTable(table, items, captions, [], rules, [], undefined, undefined, context)
  expect(result.grid).toHaveLength(6)
  expect(result.grid[2]).toEqual([
    'Area 1',
    '0.7',
    '3',
    '1.0 ± 0.2',
    '4',
    '1.0 ± 0.2',
    '0.2',
    '1.0 ± 0.2'
  ])
  expect(result.unassigned).toEqual([])
  expect(result.cropRect[1]).toBeGreaterThan(captions[0].rect[3])
})

it.each(['nonliteral uncertainty', 'uncentered parent'])('requires proof of each %s', (variant) => {
  const { table, items, captions, rules, context } = pairedCountGrid(variant)
  expect(
    recoverNativeTwoTierParentHeaderGrid(table, items, captions, rules, context)
  ).toBeUndefined()
})
