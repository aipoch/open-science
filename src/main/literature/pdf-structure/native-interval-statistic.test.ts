import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readPdfFixture } from './read-fixture'

const { splitPdfNumericRuns } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/interval-and-probability-in-separate-native-runs.jsonl'
    )
  )

it('separates an interval and probability using independent native glyph advances', () => {
  const x = fixture()
  const before = structuredClone(x)
  const result = splitPdfNumericRuns(x.content, x.operators)
  expect(result.items.map((i: { str: string }) => i.str)).toEqual(x.expected)
  expect(result.items[1].transform[4]).toBeCloseTo(165.7475, 4)
  expect(result.items[1].width).toBe(10.625)
  expect(x).toEqual(before)
})

it.each(['incompatible-stream', 'reversed-axis', 'narrow-gap'])(
  'preserves the joined item with %s evidence',
  (variant) => {
    const x = fixture()
    if (variant === 'incompatible-stream') x.operators.argsArray[2][0][0].unicode = '9'
    if (variant === 'reversed-axis') x.content.items[0].transform[0] = -8.5
    if (variant === 'narrow-gap') x.content.items[0].width -= 1
    expect(splitPdfNumericRuns(x.content, x.operators).items).toEqual(x.content.items)
  }
)

it('preserves an ordinary inline interval and probability separated by a space', () => {
  const x = fixture()
  const glyphs = [
    ...x.operators.argsArray[2][0],
    { unicode: ' ', width: 100, isSpace: true },
    ...x.operators.argsArray[4][0]
  ]
  x.operators = { fnArray: [OPS.setFont, OPS.showText], argsArray: [['native-font', 1], [glyphs]] }
  x.content.items[0].width = glyphs.reduce(
    (sum: number, g: { width: number }) => sum + (g.width * 8.5) / 1000,
    0
  )
  expect(splitPdfNumericRuns(x.content, x.operators).items).toEqual(x.content.items)
})
