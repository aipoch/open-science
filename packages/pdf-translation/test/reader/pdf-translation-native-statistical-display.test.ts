import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([
  ['mean', true],
  ['variance', true],
  ['variance', false]
] as const)(
  'keeps both labelled terms in a native statistical display (%s, %s)',
  (kind, aligned) => {
    const variance = kind === 'variance'
    const body = (str: string, x: number, width: number, y = 170): PdfLayoutTextItem => ({
      str,
      width,
      height: 10,
      dir: 'ltr',
      fontName: 'body',
      fontVertical: false,
      fontAscent: 0.8,
      fontDescent: -0.2,
      hasEOL: false,
      transform: [10, 0, 0, 10, x, y]
    })
    const italic = (x: number): PdfLayoutTextItem => ({
      ...body('θ', x, 6),
      fontName: 'italic'
    })
    const label = (name: string, x: number, width: number): PdfLayoutTextItem => ({
      ...body(name, x, width, 168.6),
      height: 7,
      fontName: 'small',
      transform: [7, 0, 0, 7, x, 168.6]
    })
    const items = [
      {
        ...body('2. Compare the measurements from the upper and lower bands:', 64, 369, 190),
        hasEOL: true
      },
      ...(variance
        ? [body('Q2 = Var(', 252, 44), italic(296)]
        : [body('Q2 = ', 274, 26), body('¯', 301.3, 5, 172.6), italic(300)]),
      label('lower', variance ? 302 : 306, 18),
      ...(variance ? [body(')', 320.7, 4)] : []),
      { ...body('−', 328, 8), fontName: 'symbol' },
      ...(variance
        ? [body('Var(', 339, 19), italic(358)]
        : [body('¯', 341.3, 5, 172.6), italic(340)]),
      label('upper', (variance ? 364 : 346) + (aligned ? 0 : 2.5), 16),
      ...(variance ? [body(')', 380.7, 4)] : []),
      { ...body('.', variance ? 384.7 : 362.7, 2.7), fontName: 'italic' }
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const tail = units.find((unit) => unit.source.startsWith('lower'))
    expect(tail?.preserve === 'formula').toBe(aligned)
    expect(tail?.sourceOnly === true).toBe(aligned)
    expect(units.find((unit) => unit.source.startsWith('2. Compare'))?.sourceOnly).toBeUndefined()
  }
)

it.each([true, false])(
  'keeps the lowered tail of an encoded native comparison (%s)',
  (attached) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'body',
      height = 10,
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      width,
      height,
      dir: 'ltr',
      fontName,
      fontVertical: false,
      fontAscent: 0.8,
      fontDescent: -0.2,
      hasEOL,
      transform: [height, 0, 0, height, x, y]
    })
    const items = [
      item(
        'The two estimates converge whenever a large enough number of',
        50,
        656,
        241,
        'body',
        10,
        true
      ),
      item(
        'observations satisfy the stopping rule and their final scores',
        50,
        643.5,
        241,
        'body',
        10,
        true
      ),
      item('satisfy', 50, 631, 27.8),
      item('ρ', 81, 631, 6.1, 'math'),
      item('i', 87.1, 634.6, 2.8, 'script', 7),
      item('≤', 93.2, 631, 7.75, 'operator'),
      item('\u000f', 103.75, 631, 4.8, 'math'),
      item('s', attached ? 108.55 : 109.6, 629.5, 3, 'script', 7),
      item('.', 112, 631, 2.75, 'body', 10, true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const tail = units.find((unit) => unit.items.includes('1:7'))
    expect(tail?.source).toBe('s.')
    expect(tail?.sourceOnly === true).toBe(attached)
    expect(tail?.preserve === 'formula').toBe(attached)
    expect(
      units.find((unit) => unit.source.startsWith('The two estimates'))?.sourceOnly
    ).toBeUndefined()
  }
)

it.each([0, 2])('preserves word indices in a numbered native trace expression (%s)', (offset) => {
  const parts: [string, number, number, number, string, number?][] = [
    [
      'The paired transformations give the following value for the reconstructed states.',
      320,
      131,
      249,
      'body'
    ],
    ['F', 356, 105, 4.8, 'variable'],
    ['Q', 360.3, 103.3, 4.3, 'variable', 7],
    ['=', 368, 105, 7.3, 'symbol'],
    ['\u0010', 378, 115, 5.35, 'extension'],
    ['Tr', 383.45, 105, 8.25, 'body'],
    ['hq', 393.2, 115, 13.65, 'extension'],
    ['p', 406.85, 111, 9, 'extension'],
    ['σ', 416.05, 105, 4.5, 'math'],
    ['before', 420.65, 103, 24.85, 'body', 7],
    ['σ', 447.6, 105, 4.5, 'math'],
    ['after', 452.2, 103, 24.6, 'body', 7],
    ['p', 478.9, 111, 9, 'extension'],
    ['σ', 488.1, 105, 4.5, 'math'],
    ['before', 492.7, 103 - offset, 24.85, 'body', 7],
    ['i\u0011', 518.16, 115, 9.8, 'extension'],
    ['2', 528.08, 112.75, 3.5, 'body', 7],
    ['.', 533.56, 105, 2.24, 'body'],
    ['(4)', 560.8, 105, 10.5, 'number']
  ]
  const items: PdfLayoutTextItem[] = parts.map(([str, x, y, width, fontName, size = 9], i) => ({
    str,
    width,
    height: size,
    dir: 'ltr',
    fontName,
    fontVertical: false,
    fontAscent: 0.8,
    fontDescent: -0.2,
    hasEOL: i === 0,
    transform: [size, 0, 0, size, x, y]
  }))
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
  })
  for (const i of [5, 6, 9, 14]) {
    const owner = units.find((unit) => unit.items.includes(`1:${i}`))
    expect(owner).toBeDefined()
    expect(owner?.preserve === 'formula').toBe(offset === 0)
  }
  expect(units.find((unit) => unit.items.includes('1:0'))?.sourceOnly).toBeUndefined()
})
