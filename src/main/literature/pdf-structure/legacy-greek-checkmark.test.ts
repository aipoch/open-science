import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readPdfFixture } from './read-fixture'

const { repairPdfSymbolText } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)

it.each(['native', 'wrong-family', 'wrong-width', 'wrong-slot', 'wrong-unicode'])(
  'decodes legacy Greek and checkmark fonts only with matching %s evidence',
  async (variant) => {
    const cases = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/legacy-greek-checkmark-and-plus-encodings.jsonl'
      )
    )
    for (const { font, glyph, expected } of cases) {
      if (variant === 'wrong-family') font.name = 'ABCDEF+AbcdefTimes-Roman'
      if (variant === 'wrong-width') glyph.width++
      if (variant === 'wrong-slot') glyph.originalCharCode += 150
      if (variant === 'wrong-unicode') glyph.unicode = '?'
      const content = { items: [{ str: glyph.unicode, fontName: 'native' }] }
      const original = structuredClone(content)
      const result = await repairPdfSymbolText({ commonObjs: { get: () => font } }, content, {
        fnArray: [OPS.setFont, OPS.showText],
        argsArray: [['native', 10], [[glyph]]]
      })
      expect(result.items[0].str).toBe(variant === 'native' ? expected : glyph.unicode)
      expect(content).toEqual(original)
    }
  }
)
