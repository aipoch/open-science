import fractionOperator from '../fixtures/fraction-operator-native.json'
import { expect, it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutTextItem,
  type PdfTranslationLayout
} from '../../src/reader/layout.js'

const item = (
  str: string,
  x: number,
  size = 10,
  y = 100,
  width = str.length * 5
): PdfLayoutTextItem => ({
  str,
  width,
  height: size,
  dir: 'ltr',
  fontName: 'fixture',
  transform: [size, 0, 0, size, x, 800 - y]
})
const formula = (): PdfLayoutTextItem[] => [
  item('y', 80),
  item('=', 90),
  item('F', 100),
  item('(', 109),
  item('x', 113),
  item(',', 119),
  item('{', 124),
  item('W', 129),
  item('i', 134, 7, 101.5, 3),
  item('}', 138),
  item(') +', 144, 10, 100, 18),
  item('W', 166),
  item('s', 171, 7, 101.5, 3),
  item('x', 175),
  item('.', 181)
]
const extract = (items: PdfLayoutTextItem[]): PdfTranslationLayout['units'] =>
  groupPdfTranslationPages({
    pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }]
  }).units

it('preserves a complete equation with adjacent native base, subscript and operand glyphs', () => {
  const units = extract(formula())
  expect(units).toHaveLength(1)
  expect(units[0].source.replace(/\s/gu, '')).toBe('y=F(x,{Wi})+Wsx.')
  expect(units[0].sourceOnly).toBe(true)
  expect(units[0].originalStrings).toHaveLength(15)
})
it.each([
  'where z is a response variable.',
  'The trial included 90 patients (SD = 8.5).',
  'variable',
  '(SD = 8.5), while the trial continued.'
])('keeps prose beside native scripts eligible: %s', (tail) => {
  const units = extract([...formula(), item(tail, 190, 10, 100, tail.length * 5)])
  expect(units.some((unit) => unit.source.includes(tail) && !unit.sourceOnly)).toBe(true)
})

it('keeps letter-by-letter prose after a native formula eligible', () => {
  const tail = 'where z is the response variable.',
    units = extract([
      ...formula(),
      ...[...tail].map((char, n) => item(char, 190 + n * 3, 10, 100, 3))
    ])
  expect(units.some((unit) => unit.source.includes(tail) && !unit.sourceOnly)).toBe(true)
})

it('does not newly classify wrongly nested delimiters as a complete native expression', () => {
  const inputs = formula().map((part) =>
    part.str === '}' ? { ...part, str: ')' } : part.str === ') +' ? { ...part, str: '} +' } : part
  )
  expect(extract(inputs).some((unit) => !unit.sourceOnly)).toBe(true)
})

it.each(['same-size', 'no-lower', 'incomplete', 'zero-height', 'nonfinite'])(
  'does not treat unproven native operand geometry as a full expression: %s',
  (kind) => {
    let parts = formula()
    if (kind === 'same-size')
      parts = parts.map((part) =>
        part.height === 7
          ? { ...part, height: 10, transform: [10, 0, 0, 10, part.transform[4], 700] }
          : part
      )
    if (kind === 'no-lower')
      parts = parts.map((part) =>
        part.height === 7 ? { ...part, transform: [7, 0, 0, 7, part.transform[4], 700] } : part
      )
    if (kind === 'incomplete') parts = parts.filter((part) => part.str !== '}')
    if (kind === 'zero-height')
      parts = parts.map((part) => (part.height === 7 ? { ...part, height: 0 } : part))
    if (kind === 'nonfinite')
      parts = parts.map((part) => (part.str === 's' ? { ...part, width: Number.NaN } : part))
    // Without the native proof the complete symbolic line may still be protected
    // by the existing lexical classifier; this branch must not alter its text.
    const units = extract(parts)
    expect(units.flatMap((unit) => unit.originalStrings)).toEqual(parts.map((part) => part.str))
    expect(units.some((unit) => unit.source.includes('Wsx') && !unit.sourceOnly)).toBe(true)
  }
)

const fractionItems = (): PdfLayoutTextItem[] => structuredClone(fractionOperator.items)

it.each(['log', 'exp', 'sin', 'cos', 'tan', 'min', 'max', 'det'])(
  'preserves a native %s operator centered beside a stacked fraction',
  (operator) => {
    const inputs = fractionItems()
    inputs[0].str = operator
    const units = extract(inputs)
    expect(units.find((unit) => unit.originalStrings.includes(operator))?.sourceOnly).toBe(true)
    expect(units.flatMap((unit) => unit.originalStrings).sort()).toEqual(
      inputs.map((part) => part.str).sort()
    )
  }
)
it.each(['log', 'min', 'max'])(
  'keeps an ordinary %s heading eligible without fraction geometry',
  (operator) => {
    const inputs = fractionItems()
    inputs[0].str = operator
    expect(extract([inputs[0]])[0].sourceOnly).toBeUndefined()
    for (const offset of [
      [-60, 0],
      [0, 30],
      [0, -30]
    ]) {
      const shifted = inputs.map((part, index) =>
        index
          ? part
          : {
              ...part,
              transform: [
                ...part.transform.slice(0, 4),
                part.transform[4] + offset[0],
                part.transform[5] + offset[1]
              ]
            }
      )
      const candidate = extract(shifted).find((unit) => unit.source === operator)
      expect(candidate).toBeDefined()
      expect(candidate?.sourceOnly).toBeUndefined()
    }
  }
)
it('keeps prose beside a fraction eligible instead of treating it as an operator', () => {
  const inputs = fractionItems()
  inputs[0].str = 'where'
  const candidate = extract(inputs).find((unit) => unit.source === 'where')
  expect(candidate).toBeDefined()
  expect(candidate?.sourceOnly).toBeUndefined()
})

it.each(['stacked argument', 'different closing face', 'unstaggered argument'])(
  'keeps a native exponential operator original only with the proved argument (%s)',
  (fixture) => {
    const glyph = (
      str: string,
      x: number,
      y: number,
      width: number,
      height: number,
      fontName: string,
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      width,
      height,
      dir: 'ltr',
      transform: [height, 0, 0, height, x, y],
      fontName,
      fontAscent: fontName === 'extension' ? 0.04 : 0.7,
      fontDescent: fontName === 'extension' ? -0.6 : -0.2,
      fontVertical: false,
      hasEOL
    })
    const items = [
      glyph('\u0002', 100, 508, 4, 10, 'extension'),
      glyph('1', 104, 500, 4.6, 9, 'body'),
      glyph('−', 110, 500, 7.2, 9, 'symbol'),
      glyph('exp', 119, 500, 14.1, 9, 'body'),
      glyph('\u0000', 134, 508, 4.6, 10, 'extension'),
      glyph('−', 138.6, 500, 7.2, 9, 'symbol'),
      glyph('aβ', 150.5, 503.7, 8.1, 6, 'script', true),
      glyph('rT', 147, fixture === 'unstaggered argument' ? 500 : 497, 8.4, 6, 'script'),
      glyph('ab', 155.4, 496, 6.6, 5, 'subscript'),
      glyph('\u0001\u0003 ', 163.6, 508, 10.9, 10, 'extension')
    ]
    if (fixture === 'different closing face') items[9].fontName = 'other-extension'
    const units = extract(items)
    const operator = units.find((unit) => unit.items.includes('1:3'))
    expect(operator?.items).toEqual(['1:3'])
    expect(operator?.source).toBe('exp')
    expect(operator?.sourceOnly === true).toBe(fixture === 'stacked argument')
    if (fixture === 'stacked argument') expect(operator?.preserve).toBe('formula')
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      items.map((_, index) => `1:${index}`).sort()
    )
  }
)

it.each(['attached', 'misaligned number'])(
  'keeps only the native indexed terms of repeated numbered fractions original (%s)',
  (fixture) => {
    const run = (
      str: string,
      x: number,
      y: number,
      width: number,
      size: number,
      fontName: string,
      hasEOL = false
    ): PdfLayoutTextItem => ({
      ...item(str, x, size, 800 - y, width),
      fontName,
      fontAscent: 0.72,
      fontDescent: -0.22,
      fontVertical: false,
      hasEOL
    })
    const equation = (y: number, power: boolean): PdfLayoutTextItem[] => {
      const main = (
        str: string,
        x: number,
        width: number,
        font = 'body',
        eol = false
      ): PdfLayoutTextItem => run(str, x, y, width, 10, font, eol)
      return [
        run(
          'The two test potentials use the following expressions:',
          50,
          y + 24,
          320,
          10,
          'body',
          true
        ),
        main('ψ', 142, 6.5, 'math'),
        run('ABC+XY', 148.5, y - 1.5, 28, 7, 'index'),
        main('(', 177, 4),
        main('x, y', 181, 13.5, 'math'),
        main(') =', 195, 14),
        main('ax', 212, 8.5, 'math'),
        main(power ? '+' : '−', 223, 8),
        run('γ', 234.5, y + 6.75, 5.2, 10, 'math'),
        run('tag', 239.7, y + 5.25, 10.8, 7, 'index'),
        ...(power
          ? [run('u', 251, y + 6.75, 4.5, 10, 'math'), run('2', 255.8, y + 10.4, 4, 7, 'index')]
          : []),
        run('2', power ? 244.65 : 240, y - 6.8, 5, 10, 'body'),
        main('cos(2', power ? 263.2 : 253.5, 22),
        main('θ', power ? 285.4 : 275.7, 5, 'math'),
        main(')', power ? 290.6 : 280.9, 4),
        main(power ? '(3)' : '(4)', power || fixture === 'attached' ? 548 : 554, 13, 'body', true),
        run('The comparison then resumes in ordinary prose.', 50, y - 25, 280, 10, 'body', true)
      ]
    }
    const items = [...equation(550, true), ...equation(360, false)]
    const units = extract(items)
    for (const [index, run] of items.entries()) {
      if (run.str !== 'tag') continue
      const unit = units.find((candidate) => candidate.items.includes(`1:${index}`))
      expect(unit?.source).toBe(index < 15 ? 'tagu2' : 'tag')
      expect(unit?.sourceOnly === true).toBe(fixture === 'attached')
      if (fixture === 'attached') expect(unit?.preserve).toBe('formula')
    }
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      items.map((_, index) => `1:${index}`).sort()
    )
  }
)

it.each([0, 4.94])(
  'retains a finite difference display with two raised orders (drop=%s)',
  (drop) => {
    const main = (
      text: string,
      x: number,
      y: number,
      width: number,
      face = 'roman',
      end = false
    ): PdfLayoutTextItem => ({
      ...item(text, x, 12, 800 - y, width),
      fontName: face,
      fontVertical: false,
      hasEOL: end
    })
    const superscript = (x: number, y: number): PdfLayoutTextItem => ({
      ...item('r', x, 8, 800 - y, 5.1),
      fontName: 'script',
      fontVertical: false,
      hasEOL: false
    })
    const units = groupPdfTranslationPages({
      pages: [
        {
          page: 1,
          width: 612,
          height: 792,
          rotation: 0,
          items: [
            main('The calculation applies to all positive integer values of', 111, 245.3, 375),
            main('r', 489, 245.3, 7, 'variable'),
            main(',', 496, 245.3, 3.3, 'roman', true),
            main('∆', 277, 216.3, 9.8),
            superscript(286.8, 221.24),
            main('s', 292.4, 216.3, 6.7, 'variable'),
            superscript(299.1, 221.24 - drop),
            main('=', 307.9, 216.3, 9.1),
            main('r', 320.5, 216.3, 7, 'variable'),
            main('!', 327.5, 216.3, 3.3),
            main('.', 330.8, 216.3, 3.3, 'variable', true),
            main(
              'After expanding the identity we compare the two resulting sums.',
              111,
              187.3,
              386,
              'roman',
              true
            )
          ]
        }
      ]
    }).units
    const identity = units.find(({ items }) => items.includes('1:3'))
    expect(identity?.items).toEqual(['1:3', '1:4', '1:5', '1:6', '1:7', '1:8', '1:9', '1:10'])
    expect(identity?.sourceOnly).toBe(drop ? undefined : true)
    expect(identity?.preserve).toBe(drop ? undefined : 'formula')
  }
)

it.each([true, false])(
  'retains both halves of a displayed invariant with a matching limit: %s',
  (matched) => {
    const run = (
      str: string,
      x: number,
      y: number,
      width: number,
      face = 'roman'
    ): PdfLayoutTextItem => {
      const height = face === 'script' ? 8 : face === 'symbol' ? 10 : 11
      return {
        str,
        width,
        height,
        dir: 'ltr',
        fontName: face,
        fontVertical: false,
        fontAscent: face === 'symbol' ? 0.04 : 0.69,
        fontDescent: face === 'symbol' ? -0.6 : -0.19,
        hasEOL: false,
        transform: [height, 0, 0, height, x, y]
      }
    }
    const end: PdfLayoutTextItem = {
      str: '',
      width: 0,
      height: 0,
      dir: 'ltr',
      hasEOL: true,
      transform: [0, 0, 0, 0, 0, 0]
    }
    const head = 'Proof. In any finite collection B, the parity of'
    const tail = 'does not change during an update. It must be even if B contains no members.'
    const units = extract([
      run(head, 72, 573, 246),
      end,
      run('∑', 282, 561.3, 14.5, 'symbol'),
      end,
      run(matched ? 'b' : 'c', 280.75, 539.1, 4.5, 'script'),
      run('∈B', 285.25, 539.1, 12.5, 'script'),
      end,
      run('1', 299.6, 551.5, 6.25),
      run('q', 305.85, 549.85, 4.25, 'script'),
      run('(', 310.6, 551.5, 4.24),
      run('b', 314.84, 551.5, 5.76, 'italic'),
      run(')', 320.6, 551.5, 4.25),
      end,
      run(tail, 72, 521.3, 352),
      end
    ])
    const prose = [head, tail].map((text) => units.find((unit) => unit.source === text))
    expect(prose.map((unit) => unit?.sourceOnly)).toEqual(
      matched ? [true, true] : [undefined, undefined]
    )
    expect(units.find((unit) => unit.source === (matched ? 'b∈B' : 'c∈B'))?.preserve).toBe(
      matched ? 'formula' : undefined
    )
  }
)
