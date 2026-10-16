/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { recoverNativeTerminalTaskTail, populateTableCellText } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-cell-text.mjs')).href
)

const item = (text: string, x: number, y: number) => ({
  text,
  rect: [x, y, x + 50, y + 10],
  height: 10,
  horizontal: true,
  baseline: y + 10
})

it.each(['unbounded', 'competing-row', 'partial-rule'])(
  'retains a task marker without unique native row boundaries: %s',
  (kind) => {
    const rows = [{ rect: [0, 100, 300, 130] }]
    if (kind === 'competing-row') rows.push({ rect: [0, 145, 300, 180] })
    const columnRects = [
      [0, 100, 100, 180],
      [100, 100, 300, 180]
    ]
    const cells = rows.flatMap((row, index) =>
      columnRects.map((column, columnIndex) => ({
        row: index,
        column: columnIndex,
        rowSpan: 1,
        colSpan: 1,
        rect: [column[0], row.rect[1], column[2], row.rect[3]],
        items: [],
        text: ''
      }))
    )
    const items = [item('First', 10, 110), item('Finished.', 120, 110), item('t42', 120, 126)]
    if (kind === 'competing-row') items.push(item('Other', 10, 148), item('next record', 120, 148))
    const rules =
      kind === 'unbounded'
        ? []
        : [
            [0, 100, 300, 100],
            [0, 150, kind === 'partial-rule' ? 150 : 300, 150]
          ]
    const issues = new Set<string>(),
      repairs: string[] = []
    const unassigned = populateTableCellText({
      cells,
      items,
      pageItems: items,
      rows,
      columnRects,
      headerRows: [],
      rules,
      bottom: 180,
      issues,
      repairs
    })
    expect(unassigned).toContain('t42')
    expect(cells[1].text).toBe('Finished.')
    expect(repairs).not.toContain('terminal-task-tail-recovered')
  }
)

it('recovers a uniquely owned terminal task line below a wrapped cell', () => {
  const prefix = item('runtime_seconds).', 120, 110)
  const tail = item('t86 Submits.', 120, 126)
  const cell = {
    row: 0,
    column: 1,
    rowSpan: 1,
    colSpan: 1,
    rect: [100, 100, 300, 130],
    items: []
  }
  const assignments = new Map([[prefix, cell]])
  const repairs: string[] = []
  expect(
    recoverNativeTerminalTaskTail({
      items: [prefix, tail],
      cells: [cell],
      columnRects: [
        [0, 0, 100, 200],
        [100, 0, 300, 200]
      ],
      rules: [
        [0, 100, 300, 100],
        [0, 150, 300, 150]
      ],
      assignments,
      bottom: 150,
      repairs
    })
  ).toBe(true)
  expect(assignments.get(tail)).toBe(cell)
  expect(repairs).toEqual(['terminal-task-tail-recovered'])
})

it('retains a terminal task line when another cell owns the same baseline', () => {
  const prefix = item('runtime_seconds).', 120, 110)
  const tail = item('t86 Submits.', 120, 126)
  const competing = item('t99 Other.', 120, 126)
  const cell = {
    row: 0,
    column: 1,
    rowSpan: 1,
    colSpan: 1,
    rect: [100, 100, 300, 130],
    items: []
  }
  const otherCell = {
    row: 0,
    column: 2,
    rowSpan: 1,
    colSpan: 1,
    rect: [300, 100, 500, 130],
    items: []
  }
  const assignments = new Map([
    [prefix, cell],
    [competing, otherCell]
  ])
  const repairs: string[] = []
  expect(
    recoverNativeTerminalTaskTail({
      items: [prefix, tail, competing],
      cells: [cell, otherCell],
      columnRects: [
        [0, 0, 100, 200],
        [100, 0, 300, 200],
        [300, 0, 500, 200]
      ],
      rules: [],
      assignments,
      bottom: 150,
      repairs
    })
  ).toBe(false)
  expect(assignments.has(tail)).toBe(false)
  expect(repairs).toEqual([])
})
