import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousCategoricalParentHeader } = await import(
  pathToFileURL(resolve('test/fixtures/categorical-parent-header.mjs')).href
)
const header = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-header-ownership.mjs')).href
)

it('preserves the native categorical parent and the stub between two header baselines', async () => {
  const f = await anonymousCategoricalParentHeader()
  try {
    const source = f.items.filter(
      (i: { baseline: number }) => i.baseline > 157.5 && i.baseline < 289.5
    )
    const before = JSON.stringify(source)
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
    expect([...plan.ownedTokens]).toHaveLength(10)
    expect(plan.cropRect).toEqual(f.table.cropRect)
    expect(JSON.stringify(source)).toBe(before)
  } finally {
    await f.cleanup()
  }
})

it.each([
  'partial',
  'short-partial',
  'duplicate-partial',
  'off-center',
  'white-rail',
  'extra-parent',
  'foreign-glyph',
  'foreign-paint',
  'asymmetric',
  'missing-value',
  'extra-value',
  'opening',
  'divider',
  'closing',
  'fake-source',
  'alias',
  'token',
  'font',
  'caption',
  'cross-rail',
  'stub-in-leaf-domain'
])('declines an incomplete or ambiguous categorical matrix: %s', async (mode) => {
  const f = await anonymousCategoricalParentHeader(mode)
  try {
    if (mode === 'opening') f.rules.shift()
    if (mode === 'divider') f.rules.splice(2, 1)
    if (mode === 'closing') f.rules.pop()
    const source = f.items.find((i: { text: string }) => i.text === 'Estimate')
    if (mode === 'fake-source') source.sourceItem.text = 'Fake'
    if (mode === 'alias') f.items.push({ ...source })
    if (mode === 'token') source.sourceToken = { sourceItem: source.sourceItem }
    if (mode === 'font') f.context.nativeGlyphContext.content.styles = {}
    if (mode === 'caption') f.captions[0].lines = ['Table 1: Foreign categories.']
    if (mode === 'cross-rail') source.rect[1] -= 40
    if (mode === 'stub-in-leaf-domain') {
      const stub = f.items.find((i: { text: string }) => i.text === 'Reference')
      stub.rect[0] += 150
      stub.rect[2] += 150
    }
    expect(
      header.recoverNativeTwoTierParentHeaderGrid(f.table, f.items, f.captions, f.rules, f.context)
    ).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})
