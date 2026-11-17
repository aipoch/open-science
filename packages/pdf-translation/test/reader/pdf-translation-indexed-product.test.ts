import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

function item(
  str: string,
  x: number,
  y: number,
  width: number,
  font = 'Body',
  height = 11,
  hasEOL = false,
  ascent = 0.7,
  descent = -0.2
): PdfLayoutPage['items'][number] {
  return {
    str,
    width,
    height,
    hasEOL,
    dir: 'ltr',
    transform: [height, 0, 0, height, x, y],
    fontName: font,
    fontAscent: ascent,
    fontDescent: descent,
    fontVertical: false
  }
}
it.each(['', 'flat-index', 'offset-limit'])(
  'preserves an isolated indexed product with native lowered glyphs: %s',
  (fault) => {
    const items = [
      item(
        'The following inequality holds for each applicable value',
        72,
        483,
        450,
        'Body',
        11,
        true
      ),
      item('3', fault === 'offset-limit' ? 230 : 224, 468, 5, 'Figure', 8),
      item('∏', 220, 465, 13, 'Extensible', 10, false, 0.04, -0.6),
      item('j', 218, 443, 4, 'Script', 8),
      item('=1', 222.5, 443, 12, 'Figure', 8),
      item('|', 236, 455, 3, 'Math'),
      item('ay', 239, 455, 12, 'Italic'),
      item('m', 251, fault === 'flat-index' ? 455 : 453.4, 4, 'Script', 8),
      item('−', 258, 455, 8, 'Math'),
      item('z', 269, 455, 7, 'Italic'),
      item('j', 276, 453.3, 4, 'Script', 8),
      item('| ≤', 281, 455, 14, 'Math'),
      item('1', 298, 455, 5, 'Digit'),
      item('(0', 320, 455, 10, 'Digit'),
      item('≤', 337, 455, 8, 'Math'),
      item('a', 348, 455, 4, 'Italic'),
      item('≤', 355, 455, 8, 'Math'),
      item('1).', 366, 455, 12, 'Digit'),
      item(
        'This bound applies to the appropriate range of parameters.',
        72,
        427,
        430,
        'Body',
        11,
        true
      )
    ]
    const result = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const owner = result.units.find((unit) => unit.items.includes('1:5'))!
    expect(owner.sourceOnly === true).toBe(!fault)
    expect(owner.preserve).toBe(fault ? undefined : 'formula')
    expect(owner.items.slice(0, 6)).toEqual(['1:5', '1:6', '1:7', '1:8', '1:9', '1:10'])
    expect(result.units.find((unit) => unit.items.includes('1:0'))?.sourceOnly).toBeUndefined()
    expect(result.units.find((unit) => unit.items.includes('1:18'))?.sourceOnly).toBeUndefined()
  }
)

it.each([true, false])(
  'retains an isolated angle-bracket assignment only with native lowered indices (%s)',
  (lowered) => {
    const items = [
      item(
        'The following identity holds for each supported basis.',
        70,
        330,
        320,
        'Body',
        11,
        true
      ),
      item('⟨', 170, 300, 4, 'Math'),
      item('q', 174.2, 300, 5, 'Variable'),
      item('∗', 179.4, 304, 4, 'Symbol', 8),
      item('j', 179.4, lowered ? 297.6 : 300, 4, 'Variable', lowered ? 8 : 11),
      item('z', 183.45, 300, 5, 'Variable'),
      item('k', 188.65, lowered ? 298.4 : 300, 4, 'Variable', lowered ? 8 : 11),
      item('⟩', 193, 300, 4, 'Math'),
      item('=', 203, 300, 8, 'Math'),
      item('B', 216, 300, 8, 'Variable'),
      item('δ', 226, 300, 5, 'Symbol'),
      item('rs', 231.2, 298.4, 8, 'Variable', 8),
      item(';', 241, 300, 3, 'Body', 11, true),
      item('The correlation between the components then vanishes.', 70, 270, 315, 'Body', 11, true)
    ]
    const result = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }]
    })
    const owner = result.units.find((unit) => unit.items.includes('1:1'))!
    expect(owner.items).toEqual(items.slice(1, -1).map((_, index) => `1:${index + 1}`))
    expect(owner.sourceOnly === true).toBe(lowered)
    expect(owner.preserve).toBe(lowered ? 'formula' : undefined)
    for (const index of [0, items.length - 1])
      expect(
        result.units.find((unit) => unit.items.includes(`1:${index}`))?.sourceOnly
      ).toBeUndefined()
  }
)

it.each(['paired display', 'missing companion', 'flat index'])(
  'retains a whole power-law row with two native indices and a companion: %s',
  (mode) => {
    const glyphs: Array<[string, string, number, number, number, number, boolean]> = [
      ['v', 'glyph-1', 81.437, 435.825, 3.597, 9.963, false],
      ['LAB', 'glyph-2', 85.034, 439.939, 16.923, 6.974, false],
      ['r', 'glyph-3', 85.034, 433.362, 3.01, 6.974, false],
      ['= (7', 'glyph-4', 105.223, 435.825, 19.374, 9.963, false],
      ['±', 'glyph-5', 126.808, 435.825, 7.749, 9.963, false],
      ['2)', 'glyph-4', 136.771, 435.825, 8.856, 9.963, false],
      ['×', 'glyph-5', 147.84, 435.825, 7.749, 9.963, false],
      ['10', 'glyph-4', 157.803, 435.825, 9.963, 9.963, false],
      ['−', 'glyph-6', 167.766, 439.939, 6.227, 6.974, false],
      ['4', 'glyph-2', 173.992, 439.939, 3.972, 6.974, false],
      ['×', 'glyph-5', 180.676, 435.825, 7.749, 9.963, false],
      ['m', 'glyph-1', 190.638, 435.825, 4.67, 9.963, false],
      ['(1', 'glyph-2', 195.308, 439.939, 7.085, 6.974, false],
      ['.', 'glyph-3', 202.393, 439.939, 2.366, 6.974, false],
      ['4', 'glyph-2', 204.759, 439.939, 3.972, 6.974, false],
      ['±', 'glyph-6', 208.73, 439.939, 6.227, 6.974, false],
      ['0', 'glyph-2', 214.957, 439.939, 3.972, 6.974, false],
      ['.', 'glyph-3', 218.928, 439.939, 2.366, 6.974, false],
      ['3)', 'glyph-2', 221.294, 439.939, 7.085, 6.974, false],
      [',', 'glyph-1', 228.877, 435.825, 2.768, 9.963, true],
      ['v', 'glyph-1', 89.399, 419.059, 3.597, 9.963, false],
      ['Q', 'glyph-3', 92.997, 423.487, 5.072, 6.974, false],
      ['2', 'glyph-7', 98.069, 422.491, 3.39, 4.981, false],
      ['r', 'glyph-3', 92.997, 416.607, 3.01, 6.974, false],
      ['= (8', 'glyph-4', 105.223, 419.059, 19.374, 9.963, false],
      ['±', 'glyph-5', 126.808, 419.059, 7.749, 9.963, false],
      ['2)', 'glyph-4', 136.771, 419.059, 8.856, 9.963, false],
      ['×', 'glyph-5', 147.84, 419.059, 7.749, 9.963, false],
      ['10', 'glyph-4', 157.803, 419.059, 9.963, 9.963, false],
      ['−', 'glyph-6', 167.766, 423.173, 6.227, 6.974, false],
      ['4', 'glyph-2', 173.992, 423.173, 3.972, 6.974, false],
      ['×', 'glyph-5', 180.676, 419.059, 7.749, 9.963, false],
      ['m', 'glyph-1', 190.638, 419.059, 4.67, 9.963, false],
      ['(1', 'glyph-2', 195.308, 423.173, 7.085, 6.974, false],
      ['.', 'glyph-3', 202.393, 423.173, 2.366, 6.974, false],
      ['3', 'glyph-2', 204.759, 423.173, 3.972, 6.974, false],
      ['±', 'glyph-6', 208.73, 423.173, 6.227, 6.974, false],
      ['0', 'glyph-2', 214.957, 423.173, 3.972, 6.974, false],
      ['.', 'glyph-3', 218.928, 423.173, 2.366, 6.974, false],
      ['2)', 'glyph-2', 221.294, 423.173, 7.085, 6.974, false],
      [',', 'glyph-1', 228.877, 419.059, 2.768, 9.963, false],
      ['(8)', 'glyph-4', 266.351, 419.059, 12.73, 9.963, true]
    ]
    const items = [
      item(
        'The measured series follows this independently calibrated pair:',
        60,
        466,
        230,
        'body',
        9.963,
        true,
        0.75,
        -0.25
      ),
      ...glyphs
        .slice(0, mode === 'missing companion' ? 20 : undefined)
        .map(([text, face, x, y, width, font, end]) =>
          item(text, x, y, width, face, font, end, 0.75, -0.25)
        ),
      item(
        'The adjacent ordinary paragraph describes two different regimes.',
        60,
        396,
        235,
        'body',
        9.963,
        true,
        0.75,
        -0.25
      )
    ]
    if (mode === 'flat index') items[2].transform[5] = items[1].transform[5]
    const result = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const owner = result.units.find((unit) => unit.items.includes('1:1'))!
    expect(owner.items).toEqual(Array.from({ length: 20 }, (_, index) => `1:${index + 1}`))
    expect(owner.sourceOnly === true).toBe(mode === 'paired display')
    expect(owner.preserve).toBe(mode === 'paired display' ? 'formula' : undefined)
    expect(result.units.find((unit) => unit.items.includes('1:0'))?.sourceOnly).toBeUndefined()
  }
)
