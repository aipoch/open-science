import fractionOperator from '../../../../../../../test/fixtures/pdf-translation/fraction-operator-native.json'
import { expect, it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutTextItem,
  type PdfTranslationLayout
} from './pdf-translation-layout'

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
