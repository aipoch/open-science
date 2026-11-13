import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { joinHorizontalTableRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-rules.mjs')).href
)

import fixture from './fixtures/segmented-native-table-titles.json'

const input = (): ReturnType<typeof JSON.parse> => structuredClone(fixture)

it('keeps independent upper titles when complete native rails are painted per column', () => {
  const f = input(),
    before = structuredClone(f)
  expect(
    associateTableCaptions(f.page, f.tables, f.captions, f.rules).map(
      (t: ReturnType<typeof JSON.parse>) => t.caption
    )
  ).toEqual(f.captions)
  expect(f).toEqual(before)
})

it.each(['broken-gap', 'staggered-rail'])(
  'preserves a real %s and leaves the existing independent fallback available',
  (reason) => {
    const f = input()
    if (reason === 'broken-gap') f.rules[3][0] += 2
    if (reason === 'staggered-rail') f.rules[3][1] = f.rules[3][3] += 1
    expect(
      joinHorizontalTableRules(f.rules).some(
        (r: number[]) => r[1] === 184.121 && r[0] === 124.5 && r[2] === 470.965
      )
    ).toBe(false)
    // Breaking the first opening also defeats the old below-caption match;
    // the independent legacy distance path can then retain the upper titles.
    expect(
      associateTableCaptions(f.page, f.tables, f.captions, f.rules).map(
        (t: ReturnType<typeof JSON.parse>) => t.caption
      )
    ).toEqual(f.captions)
  }
)

it('does not assign an independent title to an overlapping third owner', () => {
  const f = input()
  f.tables.push({ rect: [120, 230, 430, 280] })
  expect(associateTableCaptions(f.page, f.tables, f.captions, f.rules)[2].caption).toBeUndefined()
})
