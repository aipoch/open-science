import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { splitPdfNumericRuns } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/paired-range-numeric-runs.jsonl')
  )
it.each([0, 1])('splits paired ranges with original glyph advances: %s', (index) => {
  const x = fixture().cases[index]
  const r = splitPdfNumericRuns(x.content, x.operators).items
  expect(r.map((i: { str: string }) => i.str)).toEqual(
    index ? ['91.6 (81.5–99.8)', '96.9 (85.2–99.8)'] : ['95.5 (85.7–99.9)', '97.5 (90.5–100)']
  )
  expect(r[0].transform[4] + r[0].width).toBeLessThan(r[1].transform[4])
  expect(r[1].transform[4] + r[1].width).toBeCloseTo(
    x.content.items[0].transform[4] + x.content.items[0].width,
    6
  )
})
it.each(['font', 'width'])(
  'preserves combined ranges when native evidence disagrees: %s',
  (variant) => {
    const x = fixture().cases[0]
    if (variant === 'font') x.operators.argsArray[0][0] = 'other'
    else x.content.items[0].width += 100
    expect(splitPdfNumericRuns(x.content, x.operators).items).toEqual(x.content.items)
  }
)
