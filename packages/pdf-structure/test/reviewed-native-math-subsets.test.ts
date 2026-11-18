import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'
import { readPdfFixture } from './read-fixture'

const { repairPdfSymbolText } = await import(
  pathToFileURL(resolve('resources/literature-pdf-symbol-text.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/reviewed-legacy-math-subset-slots.jsonl'))

it.each(['native', 'font', 'type', 'code', 'width', 'unicode', 'encoding'])(
  'decodes a native CID Symbol comparison only with complete %s evidence',
  async (variant) => {
    const font = { name: 'ABCDEF+SymbolMT', type: 'CIDFontType2', differences: [] as string[] }
    const glyph = { originalCharCode: 3, unicode: '\uf0b3', width: 549 }
    if (variant === 'font') font.name = 'Times-Roman'
    if (variant === 'type') font.type = 'Type1'
    if (variant === 'code') glyph.originalCharCode = 4
    if (variant === 'width') glyph.width = 550
    if (variant === 'unicode') glyph.unicode = '\uf0b7'
    if (variant === 'encoding') font.differences[3] = 'three'
    const result = await repairPdfSymbolText(
      { commonObjs: { get: () => font } },
      { items: [{ str: glyph.unicode, fontName: 'math' }] },
      { fnArray: [OPS.setFont, OPS.showText], argsArray: [['math', 10], [[glyph]]] }
    )
    expect(result.items[0].str).toBe(variant === 'native' ? '≥' : glyph.unicode)
  }
)

it.each(Array.from({ length: 8 }, (_, n) => n))(
  'decodes reviewed native math subset %i while preserving ordinary digits and punctuation',
  async (n) => {
    const x = fixture()[n]
    const original = structuredClone(x)
    const operators = {
      fnArray: [OPS.setFont, OPS.showText, OPS.setFont, OPS.showText],
      argsArray: [
        ['math', 10],
        [x.glyphs],
        ['prose', 10],
        [
          [
            { originalCharCode: 54, unicode: '6', width: 500 },
            { originalCharCode: 56, unicode: '8', width: 500 },
            { originalCharCode: 75, unicode: 'K', width: 666 },
            { originalCharCode: 36, unicode: '$', width: 447 }
          ]
        ]
      ]
    }
    const content = {
      items: [
        { str: x.glyphs.map((g: { unicode: string }) => g.unicode).join(' '), fontName: 'math' },
        { str: '6 8 K $', fontName: 'prose' }
      ]
    }
    const result = await repairPdfSymbolText(
      {
        commonObjs: {
          get: (name: string) => (name === 'math' ? x.font : { name: 'Times-Roman', type: 'Type1' })
        }
      },
      content,
      operators
    )
    expect(result.items[0].str).toBe(
      x.glyphs.map((g: { expected: string }) => g.expected).join(' ')
    )
    expect(result.items[1].str).toBe('6 8 K $')
    expect(x).toEqual(original)
  }
)

it.each(['wrong-font', 'wrong-width', 'wrong-slot', 'different-encoding'])(
  'declines the technical eight slot with %s evidence',
  async (variant) => {
    const x = fixture()[0]
    if (variant === 'wrong-font') x.font.name = 'Times-Roman'
    if (variant === 'wrong-width') x.glyphs[0].width = 500
    if (variant === 'wrong-slot') x.glyphs[0].originalCharCode = 57
    if (variant === 'different-encoding') x.font.differences[55] = 'seven'
    const result = await repairPdfSymbolText(
      { commonObjs: { get: () => x.font } },
      { items: [{ str: '8', fontName: 'math' }] },
      { fnArray: [OPS.setFont, OPS.showText], argsArray: [['math', 10], [x.glyphs]] }
    )
    expect(result.items[0].str).toBe('8')
  }
)

it('requires the complete Universal subset encoding rather than its Latin glyph names alone', async () => {
  const x = fixture().find(
    (c: { font: { differences: unknown[] } }) => c.font.differences.filter(Boolean).length === 5
  )
  x.font.differences[27] = 'two'
  const text = x.glyphs.map((g: { unicode: string }) => g.unicode).join(' ')
  const result = await repairPdfSymbolText(
    { commonObjs: { get: () => x.font } },
    { items: [{ str: text, fontName: 'math' }] },
    { fnArray: [OPS.setFont, OPS.showText], argsArray: [['math', 10], [x.glyphs]] }
  )
  expect(result.items[0].str).toBe(text)
})

it.each(['native outline', 'different slot', 'remapped slot', 'outside gap'] as const)(
  'recovers a dropped Computer Modern mass subscript only from its positioned Type1 glyph (%s)',
  async (variant) => {
    const item = (str: string, x: number, width: number, height: number): TextItem => ({
      str,
      dir: 'ltr',
      width,
      height,
      transform: [9, 0, 0, 9, x, 81],
      fontName: 'body',
      hasEOL: false
    })
    const slot = { ...item(' ', 50, 6.3, 0), sourceItem: { pageNumber: 1, index: 1, text: ' ' } }
    const items = [item('( M', 34, 16, 9), slot, item(')', 56.3, 4, 9)]
    const widths = Object.assign([], { 12: 963 })
    const defaultEncoding = Object.assign([], { 12: '' })
    const font = {
      name: 'ABCDEF+CMSY6',
      type: 'Type1',
      widths,
      defaultEncoding,
      differences: variant === 'remapped slot' ? Object.assign([], { 12: 'circleplus' }) : []
    }
    const glyph = {
      originalCharCode: variant === 'different slot' ? 13 : 12,
      unicode: '\f',
      isInFont: true,
      width: 963,
      isSpace: false,
      accent: null
    }
    const x = variant === 'outside gap' ? 50.1 : 50
    const page = { commonObjs: { has: (name: string) => name === 'math', get: () => font } }
    const result = await repairPdfSymbolText(
      page,
      { items },
      {
        fnArray: [OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText],
        argsArray: [[], ['math', 6], [1, 0, 0, 1, x, 80], [[glyph]], []]
      }
    )
    if (variant === 'native outline') {
      expect(result.items[1]).toMatchObject({
        str: '⊙',
        transform: [6, 0, 0, 6, 50, 80],
        fontName: 'math',
        inlineSymbol: true
      })
      expect(result.items[1].sourceItem).toBeUndefined()
      expect(result.items[0]).toEqual(items[0])
      expect(result.items[2]).toEqual(items[2])
    } else {
      expect(result.items).toEqual(items)
    }
  }
)
