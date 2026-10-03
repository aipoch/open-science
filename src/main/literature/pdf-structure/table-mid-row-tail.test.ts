/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { recoverNativeMidRowNarrativeTail } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-text.mjs')).href
)
const item = (text: string, x: number, y: number) => ({
  text,
  rect: [x, y, x + 50, y + 10],
  height: 10,
  horizontal: true,
  baseline: y + 10
})

it('recovers a lowercase wrapped narrative tail before the next row stub', () => {
  const prefix = item('Safety', 120, 110)
  const tail = item('handling continues', 120, 126)
  const stub = item('Outcome', 10, 142)
  const cell = { row: 0, column: 1, rowSpan: 1, colSpan: 1, rect: [100, 100, 300, 130] }
  const nextCell = { row: 1, column: 0, rowSpan: 1, colSpan: 1, rect: [0, 135, 100, 165] }
  const rows = [{ rect: [0, 100, 300, 135] }, { rect: [0, 135, 300, 170] }]
  const assignments = new Map([
    [prefix, cell],
    [stub, nextCell]
  ])
  const repairs: string[] = []
  expect(
    recoverNativeMidRowNarrativeTail({
      items: [prefix, tail, stub],
      cells: [cell, nextCell],
      rows,
      columnRects: [
        [0, 0, 100, 200],
        [100, 0, 300, 200]
      ],
      rules: [
        [0, 100, 300, 100],
        [0, 170, 300, 170],
        [0, 180, 300, 180]
      ],
      assignments,
      bottom: 180,
      repairs
    })
  ).toBe(true)
  expect(assignments.get(tail)).toBe(cell)
  expect(repairs).toEqual(['mid-row-narrative-tail-recovered'])
})
