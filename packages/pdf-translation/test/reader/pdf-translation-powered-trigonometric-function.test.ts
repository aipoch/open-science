import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each(['raised', 'low power', 'different opener'])(
  'preserves a separately owned trigonometric power with a native argument (%s)',
  (variant) => {
    const runs: [string, number, number, number, number, string, boolean?][] = [
      ['These coefficients yield the displayed product:', 47.04, 562.6, 228, 9.963, 'Text'],
      [')', 177.0, 523.84, 3.866, 9.963, 'Text'],
      [' ', 180.866, 523.84, 1.654, 0, 'Text'],
      ['∏', 182.52, 531.28, 9.405, 9.963, 'Large operator'],
      ['j', 192.0, 528.88, 4.924, 6.974, 'Symbols'],
      ['−', 196.92, 528.88, 6.221, 6.974, 'Minus'],
      ['1', 203.16, 528.88, 3.968, 6.974, 'Digits'],
      ['', 192.0, 520.84, 0, 0, 'Symbols', true],
      ['k', 192.0, 520.84, 3.759, 6.974, 'Symbols'],
      ['=1', 195.72, 520.84, 10.088, 6.974, 'Digits'],
      [' ', 205.808, 520.84, 3.472, 0, 'Digits'],
      ['cot', 209.28, 523.84, 13.346, 9.963, 'Text'],
      ['2', 222.6, 527.44, 3.968, 6.974, 'Digits'],
      ['(', 227.04, 523.84, 3.866, 9.963, 'Text'],
      [' ', 230.905, 523.84, 1.175, 0, 'Text'],
      ['αβk', 232.08, 528.28, 12.519, 6.974, 'Symbols'],
      ['', 236.4, 520.36, 0, 0, 'Digits', true],
      ['3', 236.4, 520.36, 3.968, 6.974, 'Digits'],
      [' ', 240.368, 520.36, 5.392, 0, 'Digits'],
      ['))', 245.76, 523.84, 7.705, 9.963, 'Text'],
      ['1', 253.44, 526.72, 3.968, 6.974, 'Digits'],
      ['/', 257.4, 526.72, 4.08, 6.974, 'Symbols'],
      ['2', 261.48, 526.72, 3.968, 6.974, 'Digits'],
      [' ', 265.448, 526.72, 1.792, 0, 'Digits'],
      [',', 267.24, 532.24, 2.76, 9.963, 'Punctuation'],
      [' ', 270.0, 532.24, 9.36, 0, 'Punctuation'],
      ['(4)', 279.36, 532.24, 12.745, 9.963, 'Text', true],
      ['We study the remaining values separately below.', 47.04, 501.4, 235, 9.963, 'Text']
    ]
    const items: PdfLayoutTextItem[] = runs.map(
      ([str, x, y, width, height, fontName, hasEOL], index) => ({
        str: variant === 'different opener' && index === 13 ? '[' : str,
        width,
        height,
        dir: 'ltr',
        transform: [height, 0, 0, height, x, variant === 'low power' && index === 12 ? y - 3 : y],
        fontName,
        fontVertical: false,
        fontAscent: fontName === 'Large operator' ? 0.04 : 0.75,
        fontDescent: fontName === 'Large operator' ? -2.359 : -0.25,
        hasEOL
      })
    )
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 792, rotation: 0, items }]
    })
    const owner = units.find((unit) => unit.items.includes('1:11'))
    const retained = variant === 'raised'
    expect(owner?.source).toBe('cot2')
    expect(owner?.items).toEqual(['1:11', '1:12'])
    expect(owner?.sourceOnly).toBe(retained ? true : undefined)
    expect(owner?.preserve).toBe(retained ? 'formula' : undefined)
    expect(units.find((unit) => unit.items.includes('1:0'))?.sourceOnly).toBeUndefined()
  }
)
