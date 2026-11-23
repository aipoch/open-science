import { expect, it } from 'vitest'
import { readPdfTranslationCases } from '../fixtures/read-cases'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

const fixture = readPdfTranslationCases<{
  page: PdfLayoutPage
  source: string
  firstIndex: number
  lastIndex: number
  neighborIndex: number
}>('paired-copular-definition-native.jsonl')[0]

function extract(page: PdfLayoutPage): ReturnType<typeof groupPdfTranslationPages> {
  const result = groupPdfTranslationPages({ pages: [page] }),
    actual = result.units.flatMap((unit) =>
      unit.items.map((key, index) => [key, unit.originalStrings[index]])
    ),
    expected = page.items.flatMap((part, index) =>
      part.str.trim() ? [[`1:${index}`, part.str]] : []
    )
  expect(actual.toSorted((a, b) => a[0].localeCompare(b[0]))).toEqual(
    expected.toSorted((a, b) => a[0].localeCompare(b[0]))
  )
  expect(new Set(actual.map(([key]) => key)).size).toBe(actual.length)
  return result
}

for (const cleared of [false, true]) {
  it(`keeps the complete paired definition apart from its formula and neighbor, cleared=${cleared}`, () => {
    const page = structuredClone(fixture.page)
    if (cleared)
      for (const part of page.items)
        if (!part.str.trim())
          Object.assign(part, { str: '', width: 0, height: 0, transform: [0, 0, 0, 0, 0, 0] })
    const { units } = extract(page),
      owner = units.find((unit) => unit.items.includes(`1:${fixture.firstIndex}`))!
    expect(owner.source).toBe(fixture.source)
    expect(owner.sourceOnly).toBeUndefined()
    expect(owner.items).toContain(`1:${fixture.lastIndex}`)
    expect(owner.items).not.toContain('1:0')
    expect(owner.items).not.toContain(`1:${fixture.neighborIndex}`)
  })
}

it.each([
  'raised-variable',
  'small-variable',
  'different-and-font',
  'different-body-font',
  'missing-font',
  'rotation',
  'nonfinite-transform',
  'native-interruption',
  'different-column',
  'operator',
  'same-variable',
  'incomplete-definition',
  'short-body',
  'different-native-row',
  'raised-tail'
])('rejects an unproven paired definition: %s', (fault) => {
  const page = structuredClone(fixture.page),
    items = page.items
  if (fault === 'raised-variable') items[7].transform[5] += 3
  if (fault === 'small-variable') {
    items[7].height = 7
    items[7].transform[0] = items[7].transform[3] = 7
  }
  if (fault === 'different-and-font') items[5].fontName = 'foreign-body'
  if (fault === 'different-body-font') items[9].fontName = 'foreign-body'
  if (fault === 'missing-font') delete items[7].fontName
  if (fault === 'rotation') items[7].transform[1] = 1
  if (fault === 'nonfinite-transform') items[7].transform[0] = NaN
  if (fault === 'native-interruption')
    items.splice(8, 0, { ...items[0], str: 'Unrelated native content.' })
  if (fault === 'different-column') for (const part of items.slice(9, 13)) part.transform[4] += 100
  if (fault === 'operator') items[9].str = '= q + r with further independent prose.'
  if (fault === 'same-variable') items[7].str = items[3].str
  if (fault === 'incomplete-definition') items[12].str = ', respectively'
  if (fault === 'short-body') items[9].str = 'are values'
  if (fault === 'different-native-row') items[7].hasEOL = true
  if (fault === 'raised-tail') items[11].transform[5] += 3
  const { units } = extract(page),
    owner = units.find((unit) => unit.items.includes('1:1'))!
  expect(owner.items).not.toContain(`1:${fault === 'native-interruption' ? 10 : 9}`)
})

it('keeps native terminal punctuation with its own column and proves the actual body continuation', () => {
  const { page, leftKeys, continuationKeys, separateKey } = readPdfTranslationCases<{
    page: PdfLayoutPage
    leftKeys: string[]
    continuationKeys: string[]
    separateKey: string
  }>('native-column-terminal-punctuation.jsonl')[0]
  const { units } = extract(page),
    owner = (key: string): (typeof units)[number] => units.find((unit) => unit.items.includes(key))!
  for (const key of leftKeys) expect(owner(key)).toBe(owner(leftKeys[0]))
  for (const key of continuationKeys) expect(owner(key)).toBe(owner(continuationKeys[0]))
  expect(owner(leftKeys[0])).not.toBe(owner(continuationKeys[0]))
  expect(owner(separateKey)).not.toBe(owner(continuationKeys[0]))
  expect(owner(leftKeys[0]).source).toContain(', and completes')
  expect(owner(continuationKeys[0]).source).toBe(
    'A distinct final left paragraph describes the stable bounds and the differences between neighboring values in the original samples under the same verified settings.'
  )
})

it.each([1.5, 3])('keeps a paired function definition with its lowered index (%s)', (drop) => {
  const native = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName = 'Body',
    height = 10
  ): PdfLayoutPage['items'][number] => ({
    str,
    width,
    height,
    fontName,
    dir: 'ltr',
    fontAscent: 0.75,
    fontDescent: -0.25,
    fontVertical: false,
    hasEOL: str.endsWith('.'),
    transform: [height, 0, 0, height, x, y]
  })
  const items = [
    native('The adjusted measurements are obtained from the equation below.', 126, 560, 284),
    native('Z(β) = T(β)/T₁(β)', 261, 537, 105, 'Math'),
    { ...native('(3)', 548, 537, 11), hasEOL: true },
    native('where', 126, 515, 26),
    native('T', 155, 515, 5, 'Math'),
    native('(', 160.5, 515, 4),
    native('β', 164.5, 515, 5.5, 'Math'),
    native(') and', 170, 515, 24),
    native('T', 197, 515, 5, 'Math'),
    native('1', 202.1, 515 - drop, 4, 'Script', 7),
    native('(', 206.4, 515, 4),
    native('β', 210.4, 515, 5.5, 'Math'),
    native(') represent the adjusted and raw readings, respectively.', 215.9, 515, 271),
    native('An independent measurement provided an estimate of the uncertainty.', 126, 464, 382)
  ]
  const { units } = extract({ page: 1, width: 600, height: 800, rotation: 0, items })
  const owner = units.find((unit) => unit.items.includes('1:3'))!
  expect(owner.sourceOnly).toBeUndefined()
  expect(owner.items.includes('1:12')).toBe(drop === 1.5)
  expect(owner.items).not.toContain('1:1')
  expect(owner.items).not.toContain('1:13')
})
