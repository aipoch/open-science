import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const { repairPdfSymbolText } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)

it.each([
  ['MathematicalPi-One', 44, 833, 'comma', '<'],
  ['MathematicalPi-Four', 53, 833, 'five', '='],
  ['AdvP80675', 44, 833, 'comma', '<'],
  ['AdvPSMP10', 100, 500, 'd', 'δ'],
  ['AdvOTddb58f6f', 98, 1000, 'b', '♉'],
  ['AdvP7DED', 53, 833, 'five', '='],
  ['AdvP7DED', 49, 833, 'one', '+']
] as const)(
  'recovers %s slot %s from its native encoding while preserving unrelated glyphs',
  async (name, code, width, glyphName, expected) => {
    for (const variant of ['native', 'wrong-font', 'wrong-width', 'conflicting-encoding']) {
      const unicode = String.fromCharCode(code)
      const content = { items: [{ str: unicode, fontName: 'native' }] }
      const page = {
        commonObjs: {
          get: () => ({
            name: variant === 'wrong-font' ? 'Times-Roman' : `ABCDEF+${name}`,
            defaultEncoding: { [code]: glyphName },
            differences: variant === 'conflicting-encoding' ? { [code]: 'unknown' } : []
          })
        }
      }
      const operators = {
        fnArray: [OPS.setFont, OPS.showText],
        argsArray: [
          ['native', 10],
          [
            [
              {
                originalCharCode: code,
                unicode,
                width: variant === 'wrong-width' ? width + 1 : width
              }
            ]
          ]
        ]
      }
      const result = await repairPdfSymbolText(page, content, operators)
      expect(result.items[0].str).toBe(variant === 'native' ? expected : unicode)
      expect(content.items[0].str).toBe(unicode)
    }
  }
)
