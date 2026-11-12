import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousSingleParentMathHeader } = await import(
  pathToFileURL(resolve('test/fixtures/single-parent-math-header.mjs')).href
)
const header = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-header-ownership.mjs')).href
)
it('preserves a complete single parent and split-font mathematical stubs without relaxing ordinary tiers', async () => {
  const f = await anonymousSingleParentMathHeader()
  try {
    const plan = header.recoverNativeTwoTierParentHeaderGrid(
      f.table,
      f.items,
      f.captions,
      f.rules,
      f.context
    )
    expect(plan).toBeDefined()
    expect(plan.rows).toHaveLength(4)
    expect(plan.columns).toHaveLength(3)
    expect(plan.spans).toEqual([
      { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
      { row: 0, column: 1, rowSpan: 1, colSpan: 2 }
    ])
    expect(
      [...plan.ownedTokens].some(
        (i: { text: string; height: number }) => i.text === '2' && i.height === 10.5
      )
    ).toBe(true)
  } finally {
    await f.cleanup()
  }
})

it.each([
  'extra-parent',
  'extra-leaf',
  'stub',
  'missing-value',
  'extra-value',
  'foreign-paint',
  'opening',
  'divider',
  'closing',
  'cross-rail',
  'fake-source',
  'alias',
  'token',
  'font'
])('declines incomplete or ambiguous native ownership: %s', async (mode) => {
  const f = await anonymousSingleParentMathHeader(mode)
  try {
    if (mode === 'opening') f.rules.shift()
    if (mode === 'divider') f.rules.splice(1, 1)
    if (mode === 'closing') f.rules.pop()
    const source = f.items.find((i: { text: string }) => i.text === 'Category')
    if (mode === 'cross-rail') source.rect[1] -= 40
    if (mode === 'fake-source') source.sourceItem.text = 'Fake'
    if (mode === 'alias') f.items.push({ ...source })
    if (mode === 'token') source.sourceToken = { sourceItem: source.sourceItem }
    if (mode === 'font') f.context.nativeGlyphContext.content.styles = {}
    expect(
      header.recoverNativeTwoTierParentHeaderGrid(f.table, f.items, f.captions, f.rules, f.context)
    ).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})
