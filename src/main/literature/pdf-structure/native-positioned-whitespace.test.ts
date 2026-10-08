import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it } from 'vitest'
const { nativeWhitespaceGaps, splitPdfNumericRuns } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)
const glyphs = (text: string): { unicode: string; width: number; isSpace: boolean }[] =>
  [...text].map((unicode) => ({ unicode, width: 500, isSpace: false }))
type Operators = { fnArray: number[]; argsArray: unknown[][] }
type Source = {
  content: {
    items: {
      str: string
      fontName: string
      height: number
      width: number
      dir: string
      transform: number[]
    }[]
  }
  operators: Operators
  viewport: {
    rotation: number
    scale: number
    convertToViewportPoint: (x: number, y: number) => number[]
  }
}
function source(): Source {
  const operators: Operators = { fnArray: [OPS.transform], argsArray: [[0.5, 0, 0, 0.5, 5, 10]] }
  for (const [text, x] of [
    ['AB', 30],
    ['CD', 50],
    ['12', 70]
  ] as const) {
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.moveText, OPS.showText, OPS.endText)
    operators.argsArray.push([], ['native', 10], [x, 100], [glyphs(text)], [])
  }
  const content = {
    items: [
      {
        str: 'AB CD 12',
        fontName: 'native',
        height: 5,
        width: 25,
        dir: 'ltr',
        transform: [5, 0, 0, 5, 20, 60]
      }
    ]
  }
  const viewport = {
    rotation: 0,
    scale: 1,
    convertToViewportPoint: (x: number, y: number): number[] => [x, y]
  }
  return { content, operators, viewport }
}
it('observes exact native positions across independent text operations without splitting content', () => {
  const x = source(),
    saved = structuredClone(x.content),
    observed = nativeWhitespaceGaps(x.content, x.operators, x.viewport)
  expect(observed).toHaveLength(1)
  expect(observed[0].gaps).toEqual([
    { left: 25, right: 30, index: 2 },
    { left: 35, right: 40, index: 4 }
  ])
  expect(observed[0].literalGlyphs).toEqual([...'ABCD12'])
  expect(new Set(observed[0].glyphRuns).size).toBe(3)
  expect(x.content).toEqual(saved)
  expect(splitPdfNumericRuns(x.content, x.operators)).toEqual(saved)
})
it.each(['width', 'origin', 'baseline', 'rotation', 'font', 'missing-origin', 'unsupported-state'])(
  'refuses an unproved combined observation: %s',
  (kind) => {
    const x = source()
    if (kind === 'width') x.content.items[0].width++
    if (kind === 'origin') x.content.items[0].transform[4]++
    if (kind === 'baseline') x.operators.argsArray[13] = [70, 102]
    if (kind === 'rotation') x.operators.argsArray[0] = [0.5, 0.1, 0, 0.5, 5, 10]
    if (kind === 'font') x.operators.argsArray[12] = ['native', 11]
    if (kind === 'missing-origin') x.operators.fnArray[13] = OPS.dependency
    if (kind === 'unsupported-state') x.operators.fnArray[13] = OPS.setGState
    expect(nativeWhitespaceGaps(x.content, x.operators, x.viewport)).toEqual([])
  }
)
it('preserves the graphics transform across saved path operations between text runs', () => {
  const x = source()
  x.operators.fnArray.splice(6, 0, OPS.save, OPS.transform, OPS.restore)
  x.operators.argsArray.splice(6, 0, [], [1, 0, 0, 1, 100, 50], [])
  expect(nativeWhitespaceGaps(x.content, x.operators, x.viewport)[0].gaps).toEqual([
    { left: 25, right: 30, index: 2 },
    { left: 35, right: 40, index: 4 }
  ])
})
