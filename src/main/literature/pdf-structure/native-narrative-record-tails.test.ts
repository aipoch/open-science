import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { repairWrappedTableRows } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
type Token = { text: string; rect: number[]; height: number; baseline: number; horizontal: boolean }
const token = (text: string, x: number, y: number, w: number): Token => ({
  text,
  rect: [x, y, x + w, y + 10],
  height: 10,
  baseline: y + 10,
  horizontal: true
})
it('merges a terminal stub-free continuation witnessed by a source hyphen in its own lane', () => {
  const rows = [
      { rect: [40, 75, 550, 95] },
      { rect: [40, 100, 550, 113] },
      { rect: [40, 115, 550, 130] }
    ],
    items = [
      token('Method', 40, 80, 60),
      token('Component', 170, 80, 100),
      token('Mechanism', 350, 80, 100),
      token('Alpha', 40, 100, 50),
      token('Distributed con-', 170, 100, 140),
      token('Uses roles with', 350, 100, 150),
      token('trol', 170, 115, 35),
      token('cross-checks', 350, 115, 110)
    ],
    repairs: string[] = []
  repairWrappedTableRows({
    rows,
    items,
    groups: [],
    columnRects: [
      [40, 70, 140, 140],
      [140, 70, 330, 140],
      [330, 70, 550, 140]
    ],
    rules: [
      [40, 75, 550, 75],
      [40, 95, 550, 95],
      [40, 135, 550, 135]
    ],
    right: 550,
    repairs,
    captioned: true,
    headers: []
  })
  expect(rows).toHaveLength(2)
  expect(rows[1].rect[3]).toBe(130)
})
it('keeps a new terminal record with its own stub or a separating native rule', () => {
  for (const withStub of [true, false]) {
    const rows = [
        { rect: [40, 75, 550, 95] },
        { rect: [40, 100, 550, 113] },
        { rect: [40, 115, 550, 130] }
      ],
      items = [
        token('Method', 40, 80, 60),
        token('Component', 170, 80, 100),
        token('Mechanism', 350, 80, 100),
        token('Alpha', 40, 100, 50),
        token('Distributed con-', 170, 100, 140),
        token('Uses roles with', 350, 100, 150),
        token('trol', 170, 115, 35),
        token('cross-checks', 350, 115, 110),
        ...(withStub ? [token('Beta', 40, 115, 50)] : [])
      ],
      repairs: string[] = []
    repairWrappedTableRows({
      rows,
      items,
      groups: [],
      columnRects: [
        [40, 70, 140, 140],
        [140, 70, 330, 140],
        [330, 70, 550, 140]
      ],
      rules: withStub ? [] : [[40, 114, 550, 114]],
      right: 550,
      repairs,
      captioned: true,
      headers: []
    })
    expect(rows).toHaveLength(3)
  }
})
