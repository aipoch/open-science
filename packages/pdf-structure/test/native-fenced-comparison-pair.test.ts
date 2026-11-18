import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

type SourceToken = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
}
type SourceOrigin = { pageNumber: number; index: number; text: string }
type NativeToken = SourceToken & { sourceItem: SourceOrigin }
type Cell = { sourceItems: SourceOrigin[] }

const { recoverNativeFencedComparisonPair } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
it.each(['complete', 'missing-fence', 'unowned-value'])(
  'separates two fully fenced comparison rows without moving their original scores (%s)',
  (fault) => {
    const cuts = [0, 30, 70, 115, 160, 205, 250]
    const bodyGuides = [
      [0, 80, 250, 80],
      [0, 110, 250, 110]
    ]
    const rules = fault === 'missing-fence' ? bodyGuides.slice(1) : bodyGuides
    const columns = cuts.length - 1
    const rows = [
      { rect: [0, 55, 250, 70] },
      { rect: [0, 81, 250, 108] },
      { rect: [0, 120, 250, 135] }
    ]
    const inventory: NativeToken[] = []
    const cells = []
    const grid = rows.map(() => Array(columns).fill(''))
    const add = (
      text: string,
      x: number,
      y: number,
      width: number,
      tokens: SourceToken[]
    ): SourceOrigin => {
      const token = {
        text,
        rect: [x, y - 9.5, x + width, y],
        baseline: y,
        height: 10,
        horizontal: true
      }
      tokens.push(token)
      const item = { ...token, sourceItem: { pageNumber: 1, index: inventory.length, text } }
      inventory.push(item)
      return item.sourceItem
    }
    for (const column of cuts.slice(1).keys()) {
      const sourceTokens: SourceToken[] = []
      const sourceItems = [92, 102].map((y, r) =>
        column === 0
          ? add(r ? 'Reference' : 'Candidate', 5, y, 33, sourceTokens)
          : column === 1
            ? add(r ? '(B)' : '(A)', 40, y, 12, sourceTokens)
            : add(column + r + '.3', cuts[column] + 9, y, 12, sourceTokens)
      )
      const text = sourceTokens.map((t) => t.text).join(' ')
      grid[1][column] = text
      cells.push({
        row: 1,
        column,
        rowSpan: 1,
        colSpan: 1,
        text,
        rect: [cuts[column], 81, cuts[column + 1], 108],
        sourceTokens,
        sourceItems,
        sourceRects: sourceTokens.map((i) => i.rect)
      })
    }
    if (fault === 'unowned-value') add('7.2', 190, 101, 9, [])
    const res = recoverNativeFencedComparisonPair(
      cells,
      rows,
      grid,
      rules,
      [0, 55, 250, 135],
      inventory
    )
    if (fault === 'complete') {
      expect(res?.rows).toHaveLength(2)
      expect(res.cells[0].colSpan).toBe(2)
      expect(res.grid.map((r: string[]) => r.slice(2))).toEqual([
        ['2.3', '3.3', '4.3', '5.3'],
        ['3.3', '4.3', '5.3', '6.3']
      ])
      expect(
        res.cells
          .flatMap((c: Cell) => c.sourceItems)
          .map((i: SourceOrigin) => i.index)
          .sort((a: number, b: number) => a - b)
      ).toEqual(inventory.map((i) => i.sourceItem.index))
    } else expect(res).toBeUndefined()
  }
)
