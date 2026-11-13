import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { anonymousTerminalNumericParentHeader } = await import(
  pathToFileURL(resolve('test/fixtures/terminal-numeric-parent-header.mjs')).href
)
const header = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-header-ownership.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

it('retains the complete common parent above three dose leaves without changing whole body Sources', async () => {
  const f = await anonymousTerminalNumericParentHeader()
  try {
    const result = refineTable(
      f.table,
      f.items,
      f.captions,
      [],
      f.rules,
      [],
      undefined,
      undefined,
      f.context
    )
    const parent = result.cells.find((cell: { text: string }) => cell.text === 'Common values (%)')
    expect(parent, 'the whole common header must own its three terminal leaves').toMatchObject({
      row: 0,
      column: 3,
      rowSpan: 1,
      colSpan: 3
    })
    expect(result.grid).toHaveLength(6)
    for (const column of [0, 1, 2])
      expect(
        result.cells.find(
          (cell: { row: number; column: number }) => cell.row === 0 && cell.column === column
        )
      ).toMatchObject({ rowSpan: 2, colSpan: 1 })
    expect(result.unassigned).toEqual([])
    const original = f.items.filter(
      (item: { baseline: number }) => item.baseline > 180 && item.baseline < 352.5
    )
    const claims = result.cells.flatMap(
      (cell: { sourceItems?: unknown[] }) => cell.sourceItems ?? []
    )
    expect(claims).toHaveLength(31)
    expect(new Set(claims.map((item: { index: number }) => item.index)).size).toBe(31)
    expect(
      [...claims].sort((a: { index: number }, b: { index: number }) => a.index - b.index)
    ).toEqual(
      original
        .map((item: { sourceItem: unknown }) => item.sourceItem)
        .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
    )
  } finally {
    await f.cleanup()
  }
})

it.each([
  'opening',
  'divider',
  'closing',
  'extra-parent',
  'unit-mismatch',
  'prose',
  'missing-value',
  'numeric-text',
  'fake-source',
  'alias',
  'source-token',
  'caption',
  'font',
  'five-columns'
])('declines an incomplete or ambiguous ordinary parent header: %s', async (mode) => {
  const f = await anonymousTerminalNumericParentHeader(mode)
  try {
    const source = f.items.find((item: { text: string }) => item.text === 'Common values (%)')
    if (mode === 'fake-source') source.sourceItem = { ...source.sourceItem, text: 'Foreign' }
    if (mode === 'alias') f.items.push({ ...source })
    if (mode === 'source-token') source.sourceToken = { sourceItem: source.sourceItem }
    if (mode === 'caption') f.captions[0].lines = ['Table 1: Foreign description.']
    if (mode === 'font') f.context.sourceContent.styles = {}
    if (mode === 'five-columns')
      f.table.structure.objects = f.table.structure.objects.filter(
        (object: { label: string; rect: number[] }) =>
          object.label !== 'table column' || object.rect[0] !== 5 * 55
      )
    const before = JSON.stringify(f.items)
    expect(
      header.recoverNativeTwoTierParentHeaderGrid(f.table, f.items, f.captions, f.rules, f.context)
    ).toBeUndefined()
    expect(JSON.stringify(f.items)).toBe(before)
  } finally {
    await f.cleanup()
  }
})
