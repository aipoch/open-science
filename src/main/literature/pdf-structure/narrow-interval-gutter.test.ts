import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { splitPdfNumericRuns } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/font-separated-intervals-with-narrow-native-gutter.jsonl'
    )
  )

it('separates interval tails using native advances and balanced neighboring fragments', () => {
  const source = fixture()
  const original = structuredClone(source)
  const result = splitPdfNumericRuns(source.content, source.operators)
  const fragments = result.items.filter(
    (item: { str: string }) => item.str === '165.0)' || item.str === '160.0 (156.0'
  )
  expect(fragments.map((item: { str: string }) => item.str)).toEqual(['165.0)', '160.0 (156.0'])
  expect(fragments[0].width).toBeCloseTo(21.36018768, 7)
  expect(fragments[1].transform[4]).toBeCloseTo(201.54203062, 7)
  expect(fragments[1].width).toBeCloseTo(42.1038904, 7)
  expect(source).toEqual(original)
})

it.each(['missing-prefix', 'different-baseline', 'normal-spacing'])(
  'preserves the joined source when evidence is %s',
  (variant) => {
    const source = fixture()
    const target = source.content.items.find(
      (item: { str: string }) => item.str === '165.0) 160.0 (156.0'
    )
    if (variant === 'missing-prefix') source.content.items[2].str = '160.0 [157.0'
    if (variant === 'different-baseline') source.content.items[3].transform[5] += 1
    if (variant === 'normal-spacing') {
      const advances = source.operators.argsArray.find(
        (args: unknown[]) => Array.isArray(args[0]) && args[0].includes(-463.4)
      )[0]
      advances[advances.indexOf(-463.4)] = -256.5
      const difference = (463.4 - 256.5) * 0.001 * target.height
      target.width -= difference
      source.content.items[5].transform[4] -= difference
      source.content.items[6].transform[4] -= difference
    }
    expect(splitPdfNumericRuns(source.content, source.operators).items).toContainEqual(target)
  }
)
