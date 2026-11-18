import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { recoverNativeParallelNumericRows } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

type NativeToken = {
  text: string
  baseline: number
  rect: number[]
  height: number
  horizontal: boolean
}

type NativeItem = NativeToken & {
  sourceItem: { pageNumber: number; index: number; text: string }
}

type ModelCell = {
  row: number
  column: number
  rowSpan: number
  colSpan: number
  text: string
  rect: number[]
  sourceTokens: NativeToken[]
  sourceRects: number[][]
  sourceItems: NativeItem['sourceItem'][]
}

it.each(['complete', 'missing-enclosure', 'foreign-value'])(
  'splits merged numeric records only with matching native row evidence (%s)',
  (variant) => {
    const columns = 8
    const crop = [0, 80, 480, 192]
    const rules = [85, 128, 145, 188].map((y) => [0, y, 480, y])
    if (variant === 'missing-enclosure') rules.pop()
    const items: NativeItem[] = []
    const rows = []
    const cells: ModelCell[] = []
    const grid = []
    for (const [row, first] of [91, 151].entries()) {
      const rect = [0, first - 10.2, 480, first + 30]
      rows.push({ rect, origin: 'model' })
      const values = []
      for (let column = 0; column < columns; column++) {
        const x = column * 60 + 8
        const tokens = [120, 90, 60, 30].map((stub, offset) => {
          const text =
            column === 0
              ? String(stub)
              : variant === 'foreign-value' && row === 1 && column === 7 && offset === 2
                ? 'pending'
                : `${20 + column}.${offset + row}/0.${column + offset + row + 1}`
          const baseline = first + offset * 10
          const token = {
            text,
            baseline,
            rect: [x, baseline - 10.2, x + 44, baseline],
            height: 10.2,
            horizontal: true
          }
          items.push({ ...token, sourceItem: { pageNumber: 1, index: items.length, text } })
          return token
        })
        const text = tokens.map((token) => token.text).join(' ')
        values.push(text)
        cells.push({
          row,
          column,
          rowSpan: 1,
          colSpan: 1,
          text,
          rect: [column * 60, rect[1], (column + 1) * 60, rect[3]],
          sourceTokens: tokens,
          sourceRects: tokens.map((token) => token.rect),
          sourceItems: items.slice(-4).map((token) => token.sourceItem)
        })
      }
      grid.push(values)
    }
    const input = { cells, rows, grid, rules, crop, items }
    const original = structuredClone(input)
    const result = recoverNativeParallelNumericRows(cells, rows, grid, rules, crop, items)
    expect(input).toEqual(original)
    if (variant !== 'complete') {
      expect(result).toBeUndefined()
      return
    }
    expect(result.grid.map((row: string[]) => row[0])).toEqual([
      '120',
      '90',
      '60',
      '30',
      '120',
      '90',
      '60',
      '30'
    ])
    const sourceIds = result.cells
      .flatMap((cell: ModelCell) => cell.sourceItems.map((item) => item.index))
      .sort((a: number, b: number) => a - b)
    expect(sourceIds).toEqual(items.map((item) => item.sourceItem.index))
  }
)
