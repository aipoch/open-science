import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([
  { functionName: 'Q', argument: 'ε', index: 'i', shifted: false, duplicate: false },
  { functionName: 'R', argument: 'η', index: 'k', shifted: false, duplicate: false },
  { functionName: 'Q', argument: 'ε', index: 'i', shifted: true, duplicate: false },
  { functionName: 'Q', argument: 'ε', index: 'i', shifted: false, duplicate: true }
])(
  'checks raised sum ownership: $functionName($argument), shifted=$shifted, duplicate=$duplicate',
  ({ functionName, argument, index, shifted, duplicate }) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      height = 12,
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height,
      transform: [height, 0, 0, height, x, y],
      fontName,
      fontAscent: fontName === 'Operator' ? 0.04 : 0.7,
      fontDescent: fontName === 'Operator' ? -0.6 : -0.2,
      fontVertical: false,
      hasEOL
    })
    const items = [
      item('P', 295.4, 769, 12.6, 'Operator'),
      item(index, 308, 756.5, 2.9, 'Index', 8),
      item(') = 1', 251.7, 544, 26.1, 'Symbols'),
      item(duplicate ? '. Hence ≥P 1' : '. Hence', 277.8, 544, 57.6, 'Body'),
      item('ℓ', 342.6, 544, 4.9, 'Math'),
      item('z', 356.5, 544, 5.4, 'Math'),
      item('| ≥', 370.9, 544, 15.9, 'Relation'),
      item('1', 390.1, 544, 5.9, 'Symbols'),
      item('for each', 399.9, 544, 30.2, 'Body'),
      item(functionName, 334.5, 530, 9.2, 'Math'),
      item('(', 343.7, 530, 4.6, 'Symbols'),
      item(argument, 348.3, 530, 5.5, 'Math'),
      item(') =', 353.8, 530, 17.35, 'Symbols'),
      item('P', 374.9, 539, 12.6, 'Operator'),
      item('', 387.5, 526.5, 0, 'Index', 8, true),
      item(index, shifted ? 388.5 : 387.5, 526.5, 2.9, 'Index', 8),
      item(argument, 392.9, 530, 5.5, 'Math'),
      item('continue', 72, 516, 20.9, 'Body')
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 840, rotation: 0, items }]
    })
    const owner = units.find((unit) => unit.items.includes('1:13'))
    const bound = units.find((unit) => unit.items.includes('1:6'))
    if (shifted || duplicate) {
      expect(owner).toBe(bound)
      expect(bound?.source).toContain('≥P 1')
    } else {
      expect(owner).toMatchObject({
        source: `P ${index} ${argument}`,
        preserve: 'formula',
        sourceOnly: true
      })
      expect(bound?.source).toContain('≥ 1')
    }
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      items.flatMap((part, index) => (part.str ? [`1:${index}`] : [])).toSorted()
    )
  }
)

it.each([
  ['Extension', 0, true],
  ['Extension', 4, false],
  ['Body', 0, false]
] as const)(
  'retains an encoded display sum with its centered limit (%s, %s)',
  (font, offset, retained) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      height = 10,
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height,
      transform: [height, 0, 0, height, x, y],
      fontName,
      fontAscent: fontName === 'Extension' ? 0.03 : 0.7,
      fontDescent: fontName === 'Extension' ? -2.97 : -0.2,
      fontVertical: false,
      hasEOL
    })
    const items = [
      item('We obtain the following estimate.', 56, 440, 155, 'Body', 10, true),
      item('ÿ', 192, 420, 11, font),
      item('j', 190 + offset, 399, 5, 'Index', 7),
      item('P', 195 + offset, 399, 5, 'Relation', 7),
      item('S', 200 + offset, 399, 5, 'Index', 7, true),
      item('v', 207 + offset, 410.5, 6, 'Math'),
      item('p', 214 + offset, 410.5, 4, 'Relation'),
      item('j', 218 + offset, 410.5, 5, 'Math'),
      item('q', 223 + offset, 410.5, 4, 'Relation'),
      item('ą', 230 + offset, 410.5, 7, 'Relation'),
      item('0.', 240 + offset, 410.5, 8, 'Body', 10, true),
      item('This completes the estimate.', 56, 380, 139, 'Body', 10, true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 432, height: 520, rotation: 0, items }]
    })
    const sum = units.find((unit) => unit.items.includes('1:1'))
    const limit = units.find((unit) => unit.items.includes('1:2'))
    expect(sum?.items).toEqual(['1:1'])
    expect(limit?.items).toEqual(['1:2', '1:3', '1:4'])
    for (const unit of [sum, limit]) {
      expect(unit?.sourceOnly ?? false).toBe(retained)
      expect(unit?.preserve).toBe(retained ? 'formula' : undefined)
    }
    expect(units.find((unit) => unit.items.includes('1:0'))?.sourceOnly).toBeUndefined()
  }
)

it.each([-2.35, -0.22])('retains a detached extension-font union symbol (%s)', (descent) => {
  const items: PdfLayoutTextItem[] = [
    {
      str: 'These sets are disjoint and their union is given below.',
      width: 260,
      transform: [10, 0, 0, 10, 50, 495],
      fontName: 'Body',
      fontAscent: 0.72,
      fontDescent: -0.22,
      hasEOL: true
    },
    {
      str: '⋃',
      width: 9,
      transform: [10, 0, 0, 10, 190, 477],
      fontName: 'Operator',
      fontAscent: 0.04,
      fontDescent: descent,
      hasEOL: true
    },
    {
      str: 'A.',
      width: 9,
      transform: [10, 0, 0, 10, 219, 469],
      fontName: 'Body',
      fontAscent: 0.72,
      fontDescent: -0.22,
      hasEOL: true
    }
  ].map((item) => ({ ...item, height: 10, dir: 'ltr', fontVertical: false }))
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 400, height: 600, rotation: 0, items }]
  })
  const operator = units.find((unit) => unit.items.includes('1:1'))
  expect(operator?.items).toEqual(['1:1'])
  expect(operator?.sourceOnly ?? false).toBe(descent < -1)
})

it.each(['centered limit', 'shifted limit', 'unrelated variable'])(
  'retains a Greek variable only when it belongs to a native display sum (%s)',
  (shape) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      height = 12,
      fontName = 'Math',
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height,
      fontName,
      fontAscent: 0.76,
      fontDescent: -0.22,
      fontVertical: false,
      hasEOL,
      transform: [height, 0, 0, height, x, y]
    })
    const items = [
      item('The next equation expresses the total.', 90, 560, 225, 12, 'Body', true),
      item('𝑡', 169, 525, 6.6),
      item('(', 176, 525.6, 4.8),
      item('𝑥', 181, 525, 7.4),
      item(')', 189, 525.6, 4.8),
      item('=', 214, 525, 9),
      item('∑', 226, 525, 16),
      item('𝑞', 244, 525, 6.6),
      item('0', 249, 522.6, 4.9, 8.4),
      item('𝜃', shape === 'shifted limit' ? 234.8 : 230.8, 510, 6.4, 8.4),
      item('(', 256, 525.6, 4.8),
      item(shape === 'unrelated variable' ? '𝜓' : '𝜃', 261, 525, 8.2),
      item(')', 269, 525.6, 4.8),
      item('The result follows from the preceding estimate.', 90, 480, 255, 12, 'Body', true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const lower = units.find((unit) => unit.items.includes('1:9'))
    expect(lower).toMatchObject({ items: ['1:9'], source: '𝜃' })
    expect(Boolean(lower?.sourceOnly && lower.preserve === 'formula')).toBe(
      shape === 'centered limit'
    )
    expect(
      units.find((unit) => unit.source.startsWith('The result follows'))?.sourceOnly
    ).toBeUndefined()
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      items.map((_, index) => `1:${index}`).toSorted()
    )
  }
)
