import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

type NativeToken = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
  sourceItem: { pageNumber: number; index: number; text: string }
}

function centeredStubTable(scenario: string): {
  table: {
    id: string
    cropRect: number[]
    structure: { objects: { label: string; rect: number[] }[] }
  }
  items: NativeToken[]
  captions: { lines: string[]; rect: number[] }[]
  rules: number[][]
} {
  const crop = [98, 99, 282, 222]
  const cuts = [100, 132, 200, 280]
  const header = 118
  const pitch = 12
  const upper = 100
  const lower = 220
  const rules = [upper, header, lower].map((y) => [cuts[0], y, cuts[3], y])
  for (const x of cuts.slice(1, -1)) {
    rules.push([x, 103, x, 116])
    if (scenario !== 'missing-rail' || x === cuts[1]) rules.push([x, 121, x, 218])
  }
  const items: NativeToken[] = []
  function text(value: string, column: number, baseline: number): void {
    const x = cuts[column] + 5
    items.push({
      text: value,
      rect: [x, baseline - 10, x + 3 * value.length, baseline + 2],
      baseline,
      height: 10,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: items.length, text: value }
    })
  }
  for (const [column, value] of ['Part', 'Option A', 'Option B'].entries()) text(value, column, 113)
  for (const [row, step] of [0, 1, 3, 5, 6, 7].entries()) {
    const baseline = 130 + step * pitch
    text(String.fromCharCode(65 + row), 0, baseline)
    if (step !== 3) {
      text('Short value', 1, baseline)
      text('Other value', 2, baseline)
      continue
    }
    text('First pass', 1, baseline - pitch / 2)
    text('Second pass', 1, baseline + pitch / 2)
    text('Upper part', 2, baseline - pitch)
    text('Middle part', 2, baseline)
    text('Lower part', 2, baseline + (scenario === 'off-center' ? pitch / 2 : pitch))
  }
  const objects = [
    ...cuts.slice(1).map((x, column) => ({
      label: 'table column',
      rect: [cuts[column] - crop[0], 1, x - crop[0], 110]
    })),
    ...[100, 118, 130, 165, 180, 196].map((y, index, ys) => ({
      label: 'table row',
      rect: [2, y - crop[1], 182, (ys[index + 1] ?? 220) - crop[1]]
    }))
  ]
  return {
    table: { id: 'native-example', cropRect: crop, structure: { objects } },
    items,
    captions: [{ lines: ['Table 1. Part comparison.'], rect: [100, 80, 220, 91] }],
    rules
  }
}

it.each(['complete', 'missing-rail', 'off-center'])(
  'requires both ruled dividers and centered peer lines to recover one taller record (%s)',
  (scenario) => {
    const { table, items, captions, rules } = centeredStubTable(scenario)
    const result = refineTable(table, items, captions, [], rules)
    const repair = 'native-centered-stub-peer-records-recovered'
    if (scenario !== 'complete') {
      expect(result.repairs).not.toContain(repair)
      return
    }
    expect(result.repairs).toContain(repair)
    expect(result.grid).toHaveLength(7)
    expect(result.grid[3]).toEqual([
      'C',
      'First pass Second pass',
      'Upper part Middle part Lower part'
    ])
    expect(result.unassigned).toEqual([])
    const owned = result.cells.flatMap((cell: { sourceItems: NativeToken['sourceItem'][] }) =>
      cell.sourceItems.map((item) => item.index)
    )
    expect(owned.sort((a: number, b: number) => a - b)).toEqual(
      items.map((item) => item.sourceItem.index)
    )
  }
)
