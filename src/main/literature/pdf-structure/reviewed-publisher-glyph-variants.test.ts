import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readPdfFixture } from './read-fixture'

const { repairPdfSymbolText } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)

it.each(['native', 'wrong-family', 'wrong-width', 'wrong-slot', 'wrong-encoding', 'wrong-type'])(
  'decodes reviewed publisher subsets only with %s evidence',
  async (variant) => {
    const fixture = readPdfFixture(
      resolve('src/main/literature/pdf-structure/fixtures/reviewed-publisher-glyph-variants.jsonl')
    )
    for (const sample of fixture.cases) {
      if (variant === 'wrong-family') sample.font.name = 'ABCDEF+Times-Roman'
      if (variant === 'wrong-type') sample.font.type = 'TrueType'
      if (variant === 'wrong-encoding') {
        if (sample.font.differences.length) sample.font.differences.push('unexpected')
        else sample.font.defaultEncoding[sample.glyphs[0].originalCharCode] = 'unexpected'
      }
      for (const glyph of sample.glyphs) {
        if (variant === 'wrong-width') glyph.width += 1
        if (variant === 'wrong-slot') glyph.originalCharCode += 100
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
  }
)
