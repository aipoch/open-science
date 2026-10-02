import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const { splitPdfNumericRuns } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)

it.each([
  ['8.321 .254 32.76', 500, true],
  ['-.825 .237 -3.48', 500, true],
  ['8.321 .254 32.76', 250, false],
  ['12 345 678', 900, false],
  ['.125 .250', 900, true],
  ['-.825 .237', 900, true],
  ['.125 .250', 250, false]
] as const)(
  'requires a measured native gutter between decimal statistics: %s / %s',
  (str, gap, separate) => {
    const glyphs = [...str].map((unicode) => ({
      unicode,
      width: unicode === ' ' ? gap : 500,
      isSpace: unicode === ' '
    }))
    const item = {
      str,
      fontName: 'native',
      dir: 'ltr',
      width: glyphs.reduce((sum, g) => sum + g.width / 100, 0),
      height: 10,
      transform: [10, 0, 0, 10, 30, 50],
      hasEOL: true
    }
    const operators = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['native', 10], [glyphs]]
    }
    const result = splitPdfNumericRuns({ items: [item] }, operators).items
    if (!separate) expect(result).toEqual([item])
    else {
      expect(result.map((i: { str: string }) => i.str)).toEqual(str.split(' '))
      expect(
        result.map((i: { width: number }) => i.width).reduce((a: number, b: number) => a + b, 0) +
          (gap / 100) * (str.split(' ').length - 1)
      ).toBeCloseTo(item.width)
      expect(result.at(-1).hasEOL).toBe(true)
    }
  }
)
