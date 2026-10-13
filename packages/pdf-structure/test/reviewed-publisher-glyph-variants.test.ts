import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readPdfFixture } from './read-fixture'

const { repairPdfSymbolText } = await import(
  pathToFileURL(resolve('resources/literature-pdf-symbol-text.mjs')).href
)

it.each([
  'native',
  'wrong-family',
  'wrong-width',
  'wrong-slot',
  'wrong-encoding',
  'wrong-type',
  'wrong-unicode'
])('decodes reviewed publisher subsets only with %s evidence', async (variant) => {
  const fixture = readPdfFixture(resolve('test/fixtures/reviewed-publisher-glyph-variants.jsonl'))
  for (const sample of fixture.cases) {
    if (variant === 'wrong-family') sample.font.name = 'ABCDEF+Times-Roman'
    if (variant === 'wrong-type') sample.font.type = 'TrueType'
    if (variant === 'wrong-encoding') {
      if (sample.font.differences.length) sample.font.differences.push('unexpected')
      else sample.font.defaultEncoding[sample.glyphs[0].originalCharCode] = 'unexpected'
    }
    if (variant === 'wrong-unicode') sample.input = sample.glyphs.map(() => 'y').join(' ')
    for (const glyph of sample.glyphs) {
      if (variant === 'wrong-width') glyph.width += 1
      if (variant === 'wrong-slot') glyph.originalCharCode += 100
      if (variant === 'wrong-unicode') glyph.unicode = 'y'
    }
    const content = { items: [{ str: sample.input, fontName: 'native' }] }
    const operators = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['native', 10], [sample.glyphs]]
    }
    const original = structuredClone({ sample, content, operators })
    const result = await repairPdfSymbolText(
      { commonObjs: { get: () => sample.font } },
      content,
      operators
    )
    expect(result.items[0].str, sample.name).toBe(
      variant === 'native' ? sample.expected : sample.input
    )
    expect({ sample, content, operators }).toEqual(original)
  }
})

it.each(['native', 'resubset'])(
  'preserves ordinary text and source evidence beside %s symbols',
  async (variant) => {
    const fixture = readPdfFixture(resolve('test/fixtures/reviewed-publisher-glyph-variants.jsonl'))
    for (const sample of fixture.cases) {
      if (!sample.source) continue
      if (variant === 'resubset') sample.font.name = sample.font.name.replace('+', '+Abcdef')
      const sourceItem = { pageNumber: 7, index: 1, text: sample.input }
      const content = {
        items: [
          { str: sample.input, fontName: 'symbol', sourceItem, width: 10 },
          { str: '5 a b d g N', fontName: 'prose', width: 50 }
        ]
      }
      const result = await repairPdfSymbolText(
        {
          commonObjs: {
            get: (name: string) =>
              name === 'symbol'
                ? sample.font
                : { name: 'Times-Roman', type: 'Type1', differences: [] }
          }
        },
        content,
        { fnArray: [OPS.setFont, OPS.showText], argsArray: [['symbol', 10], [sample.glyphs]] }
      )
      expect(result.items[0]).toEqual({
        ...content.items[0],
        str: sample.expected,
        inlineSymbol: true
      })
      expect(result.items[0].sourceItem).toBe(sourceItem)
      expect(result.items[1]).toBe(content.items[1])
    }
  }
)
