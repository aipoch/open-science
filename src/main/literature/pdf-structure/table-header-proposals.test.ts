import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { applySourceHeaderSpans, removeOverlappingMergeProposals } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-merges.mjs')).href
)

it.each([2, 3])('replaces only competing proposals in a %i-row source header', (headerRowCount) => {
  const baseCells = Array.from({ length: 5 }, (_, row) =>
    Array.from({ length: 3 }, (_, column) => ({ row, column }))
  ).flat()
  const crossing = {
    origin: 'model-span',
    slots: baseCells.filter(
      (c) => c.column === 0 && c.row >= headerRowCount - 1 && c.row <= headerRowCount
    )
  }
  const body = { origin: 'source-section', slots: baseCells.filter((c) => c.row === 4) }
  const proposals = [
    crossing,
    body,
    { origin: 'model-span', slots: baseCells.filter((c) => c.row === 0) }
  ]
  applySourceHeaderSpans(
    proposals,
    baseCells,
    [
      { row: 0, column: 1, rowSpan: 1, colSpan: 2 },
      { row: 0, column: 0, rowSpan: headerRowCount, colSpan: 1 }
    ],
    headerRowCount
  )
  expect(proposals).toHaveLength(3)
  expect(proposals[0]).toBe(body)
  expect(proposals[1]).toEqual({ origin: 'source-ruled-stub', slots: [baseCells[1], baseCells[2]] })
  expect(proposals[2].slots).toEqual(
    baseCells.filter((c) => c.column === 0 && c.row < headerRowCount)
  )
  expect(proposals[1].slots[0]).toBe(baseCells[1])
})

it.each([
  { rows: undefined, removed: [0, 1, 2, 3] },
  { rows: [0, 1], removed: [0, 1, 2] },
  { rows: [0], removed: [0, 1] },
  { rows: [], removed: [] }
])('limits overlapping replacements to rows $rows', ({ rows, removed }) => {
  const a = { row: 0, column: 0 }
  const b = { row: 0, column: 1 }
  const c = { row: 0, column: 2 }
  const header = { row: 1, column: 0 }
  const body = { row: 2, column: 0 }
  const originals = [
    { slots: [a, b], origin: 'model-span' },
    { slots: [b, c], origin: 'ruled-header-span' },
    { slots: [a, header], origin: 'model-span' },
    { slots: [a, body], origin: 'model-span' },
    { slots: [c], origin: 'model-span' },
    { slots: [{ ...a }, { ...b }], origin: 'model-span' },
    { slots: [], origin: 'model-span' }
  ]
  const before = structuredClone(originals)
  const proposals = [...originals]
  const slots = [a, b]
  removeOverlappingMergeProposals(proposals, slots, rows)
  const kept = originals.filter((_, index) => !removed.includes(index))
  expect(proposals).toEqual(kept)
  kept.forEach((proposal, index) => expect(proposals[index]).toBe(proposal))
  expect(originals).toEqual(before)
  expect(slots).toEqual([a, b])
})

it('leaves proposals intact when the replacement has no slots', () => {
  const proposal = { slots: [{ row: 0, column: 0 }], origin: 'model-span' }
  const proposals = [proposal]
  removeOverlappingMergeProposals(proposals, [])
  expect(proposals).toHaveLength(1)
  expect(proposals[0]).toBe(proposal)
})
