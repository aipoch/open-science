import { expect, it } from 'vitest'
import { readPdfTranslationCases } from '../fixtures/read-cases'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

const fixture = readPdfTranslationCases<{ page: PdfLayoutPage }>(
  'inline-function-definition-native.jsonl'
)[0]
function extract(page: PdfLayoutPage): ReturnType<typeof groupPdfTranslationPages> {
  const result = groupPdfTranslationPages({ pages: [page] })
  const actual = result.units.flatMap((u) => u.items.map((key, n) => [key, u.originalStrings[n]]))
  const expected = page.items.flatMap((item, n) => (item.str.trim() ? [[`1:${n}`, item.str]] : []))
  expect(actual.toSorted((a, b) => a[0].localeCompare(b[0]))).toEqual(
    expected.toSorted((a, b) => a[0].localeCompare(b[0]))
  )
  expect(new Set(actual.map(([key]) => key)).size).toBe(actual.length)
  return result
}

it('joins a native closed function subject with its copular body without acquiring the display', () => {
  const { units } = extract(structuredClone(fixture.page)),
    owner = units.find((u) => u.items.includes('1:2'))!
  expect(owner.items).toEqual(['1:2', '1:3', '1:4', '1:5', '1:6', '1:7', '1:8'])
  expect(owner.source).toBe(
    'where f(·) is an ordinary non-linear function with stable outputs and gives a complete description for every tested input.'
  )
  expect(owner.sourceOnly).toBeUndefined()
  expect(units.find((u) => u.items.includes('1:1'))).toMatchObject({
    sourceOnly: true,
    preserve: 'formula'
  })
})

it.each(['raised-callee', 'wrong-body-font', 'native-eol'])(
  'rejects an unproven inline function definition: %s',
  (fault) => {
    const page = structuredClone(fixture.page)
    if (fault === 'raised-callee') page.items[3].transform[5] += 3
    if (fault === 'wrong-body-font') page.items[7].fontName = 'other'
    if (fault === 'native-eol') page.items[6].hasEOL = true
    const { units } = extract(page),
      owner = units.find((u) => u.items.includes('1:2'))!
    expect(owner.items).not.toContain('1:7')
    expect(units.find((u) => u.items.includes('1:1'))).toMatchObject({
      sourceOnly: true,
      preserve: 'formula'
    })
  }
)

function nativeDefinitionRow(variable: string): PdfLayoutPage {
  const items: PdfLayoutPage['items'] = []
  const add = (
    str: string,
    x: number,
    width: number,
    math = false,
    hasEOL = false,
    y = 372
  ): void => {
    items.push({
      str,
      dir: 'ltr',
      width,
      height: 9,
      transform: [9, 0, 0, 9, x, y],
      fontName: math ? 'Math' : 'Text',
      fontFamily: math ? 'sans-serif' : 'serif',
      fontAscent: math ? 0.705 : 0.75,
      fontDescent: math ? -0.218 : -0.25,
      fontVertical: false,
      hasEOL
    })
  }
  add('The required bound is', 133, 88, false, false, 384)
  add('|Q(H)| ≤ 2ψ(H),', 225, 70, true, true, 384)
  add('where', 133, 23.54)
  add('ψ', 159.6, 6.02, true)
  add('(', 165.6, 3.58)
  add('H', 169.2, 7.21, true)
  add(') is the boundary count of', 176.4, 113)
  add(variable, 292.44, 7.21, true)
  add('.', 299.64, 2.56, false, true)
  return { page: 1, width: 595, height: 842, rotation: 0, items }
}

it('keeps a same-row variable definition together with its closing parenthesis', () => {
  const { units } = extract(nativeDefinitionRow('H'))
  expect(units.map((unit) => unit.source)).toEqual([
    'The required bound is |Q(H)| ≤ 2ψ(H),',
    'where ψ(H) is the boundary count of H.'
  ])
  expect(units[1].fragments).toHaveLength(1)
  expect(units[1].sourceOnly).toBeUndefined()
})

it('keeps the same-row definition owners separate when their variables differ', () => {
  const { units } = extract(nativeDefinitionRow('M'))
  expect(units.map((unit) => unit.source)).toEqual([
    'The required bound is |Q(H)| ≤ 2ψ(H),',
    'where ψ(H',
    ') is the boundary count of M.'
  ])
})
