import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const { repairPdfSymbolText } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)

it.each([
  'native',
  'mapped-mark',
  'zero-advance',
  'different-cid',
  'different-stream',
  'spacing',
  'rotated',
  'missing-map',
  'different-width'
])('recovers only proven unmapped CID advances: %s', async (variant) => {
  const code = 0x0301
  const font = {
    composite: true,
    type: 'CIDFontType2',
    fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    toUnicode: { _map: {} as Record<number, string> },
    widths: { [code]: 620 }
  }
  const glyph = { unicode: '\u0301', originalCharCode: code, width: 620, isSpace: false }
  const item = {
    str: '\u0301',
    fontName: 'native',
    width: 0,
    height: 9,
    dir: 'ltr',
    transform: [9, 0, 0, 9, 30, 50]
  }
  const operators = {
    fnArray: [OPS.setFont, OPS.setCharSpacing, OPS.showText],
    argsArray: [['native', 9], [0], [[glyph]]]
  }
  if (variant === 'mapped-mark') font.toUnicode._map[code] = glyph.unicode
  if (variant === 'zero-advance') glyph.width = 0
  if (variant === 'different-cid') glyph.originalCharCode++
  if (variant === 'different-stream') glyph.unicode = 'x'
  if (variant === 'spacing') operators.argsArray[1] = [Number.NaN]
  if (variant === 'rotated') item.transform = [0, 9, -9, 0, 30, 50]
  if (variant === 'missing-map') delete (font as Partial<typeof font>).toUnicode
  if (variant === 'different-width') font.widths[code] = 500
  const content = { items: [item] },
    before = structuredClone({ font, operators, content })
  const result = await repairPdfSymbolText({ commonObjs: { get: () => font } }, content, operators)
  expect(result.items[0].str).toBe(item.str)
  expect(result.items[0].width).toBeCloseTo(variant === 'native' ? 5.58 : 0)
  expect({ font, operators, content }).toEqual(before)
})
