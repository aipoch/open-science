import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { nativeWhitespaceGaps, splitPdfNumericRuns } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)
it.each([false, true])(
  'observes only the matched native glyph span while preserving a real space glyph (%s)',
  async (spaceGlyph) => {
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const firstWidth = spaceGlyph ? 38 : 39
    const content = {
      items: [
        {
          str: 'EM (500)',
          fontName: 'native',
          height: 10,
          width: firstWidth,
          dir: 'ltr',
          transform: [10, 0, 0, 10, 20, 100]
        },
        {
          str: '11',
          fontName: 'native',
          height: 10,
          width: 10,
          dir: 'ltr',
          transform: [10, 0, 0, 10, 20 + firstWidth, 100]
        }
      ]
    }
    const glyph = (
      unicode: string,
      width = 500
    ): { unicode: string; width: number; isSpace: boolean } => ({
      unicode,
      width,
      isSpace: unicode === ' '
    })
    const operators = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [
        ['native', 10],
        [
          [
            glyph('E'),
            glyph('M'),
            spaceGlyph ? glyph(' ', 300) : -400,
            ...Array.from('(500)11').map((c) => glyph(c))
          ]
        ]
      ]
    }
    const viewport = {
      rotation: 0,
      scale: 1,
      convertToViewportPoint: (x: number, y: number): number[] => [x, y]
    }
    const saved = structuredClone(content)
    const observed = nativeWhitespaceGaps(content, operators, viewport)
    expect(observed).toHaveLength(2)
    expect(observed[0].literalGlyphs).toEqual(
      spaceGlyph ? ['E', 'M', ' ', '(', '5', '0', '0', ')'] : ['E', 'M', '(', '5', '0', '0', ')']
    )
    expect(observed[1].literalGlyphs).toEqual(['1', '1'])
    expect(observed[0].glyphRuns).toHaveLength(7)
    expect(observed[1].glyphRuns).toHaveLength(2)
    expect(observed[0].gaps).toEqual([{ left: 30, right: spaceGlyph ? 33 : 34, index: 2 }])
    expect(content).toEqual(saved)
    expect(splitPdfNumericRuns(content, operators)).toEqual(saved)
  }
)
