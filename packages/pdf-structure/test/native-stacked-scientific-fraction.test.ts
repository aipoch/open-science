import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { recoverNativeStackedScientificFractions, recoverNativeIndexedReciprocal } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-cell-text.mjs')).href
)

it.each(['proved', 'missing-bar', 'off-center', 'wide-numerator', 'unowned-glyph'])(
  'preserves division by an indexed letter only with a complete native bar: %s',
  (variant) => {
    const glyph = (
      text: string,
      x: number,
      baseline: number,
      width: number,
      height: number
    ): ReturnType<typeof fixture>['items'][number] & {
      sourceItem: { pageNumber: number; index: number; text: string }
    } => ({
      text,
      rect: [x, baseline - height, x + width, baseline],
      baseline,
      height,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: x, text }
    })
    const items = [
      glyph('1', 8, 10, 6, 12),
      glyph('α', 0, 22, 6, 12),
      glyph('j,', 6, 24, 10, 9),
      glyph('2', 16, 24, 6, 9)
    ]
    const paint = new Map([['0,12,22,12', [0, 11.7, 22, 12.3]]])
    if (variant === 'missing-bar') paint.clear()
    if (variant === 'off-center') {
      items[0].rect[0] += 7
      items[0].rect[2] += 7
    }
    if (variant === 'unowned-glyph') items.push(glyph('x', 25, 22, 6, 12))
    if (variant === 'wide-numerator') {
      items[0].rect[0] -= 20
      items[0].rect[2] += 20
    }
    const runs = [
      { text: '1 α', position: 'normal' },
      { text: 'j,2', position: 'subscript' }
    ]
    const result = recoverNativeIndexedReciprocal(items, paint, runs)
    if (variant === 'proved')
      expect(result).toEqual([
        { text: '1/α', position: 'normal' },
        { text: 'j,2', position: 'subscript' }
      ])
    else expect(result).toBeUndefined()
  }
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  const items = []
  const rules = []
  for (const [x, exponent] of [
    [0, '−3'],
    [40, '−5']
  ] as const) {
    const tokens = ['1', 'e', '−', exponent.slice(1)]
    let left = x
    for (const text of tokens) {
      const width = text === '−' ? 6 : 4
      items.push({
        text,
        rect: [left, 0, left + width, 9],
        baseline: 9,
        height: 9,
        horizontal: true
      })
      left += width
    }
    items.push({
      text: 'N',
      rect: [x + 6, 10, x + 14, 19],
      baseline: 19,
      height: 9,
      horizontal: true
    })
    rules.push([x, 11, left, 11])
  }
  return { items, rules }
}

it('serializes only natively proved scientific-notation fractions', () => {
  const { items, rules } = fixture()
  const recovered = recoverNativeStackedScientificFractions(items, rules, [
    { text: '[1eN−3, 1eN−5]', position: 'normal' }
  ])
  expect(recovered?.map((run) => run.text).join('')).toBe('[1e−3/N,1e−5/N]')
  expect(recovered).toEqual([{ text: '[1e−3/N,1e−5/N]' }])
})

it('leaves malformed script ordering alone when a matching native fraction bar is missing', () => {
  const { items, rules } = fixture()
  expect(
    recoverNativeStackedScientificFractions(items, rules.slice(0, 1), [
      { text: '[1eN−3, 1eN−5]', position: 'normal' }
    ])
  ).toBeUndefined()
})

it('preserves prose and other script runs outside the proved fractions', () => {
  const { items, rules } = fixture()
  expect(
    recoverNativeStackedScientificFractions(items, rules, [
      { text: 'use [1eN−3, 1eN−5] per step', position: 'normal' }
    ])
  ).toBeUndefined()
  expect(
    recoverNativeStackedScientificFractions(items, rules, [
      { text: '[1eN−3, 1eN−5] + x', position: 'normal' },
      { text: '2', position: 'superscript' }
    ])
  ).toBeUndefined()
})

it('serializes scientific numerators over native-proved numeric denominators', () => {
  const { items, rules } = fixture()
  items[0].text = '5'
  items[3].text = '4'
  items[4].text = '5000'
  items[4].rect = [0, 10, 18, 19]
  items[5].text = '5'
  items[8].text = '6'
  items[9].text = '5000'
  items[9].rect = [40, 10, 58, 19]
  const recovered = recoverNativeStackedScientificFractions(items, rules, [
    { text: '[5e−4 5000, 5e−6 5000]', position: 'normal' }
  ])
  expect(recovered?.map((run) => run.text).join('')).toBe('[5e−4/5000,5e−6/5000]')
})

it.each(['original', 'reversed', 'missing-bar', 'unrelated-prose', 'duplicate-bar'])(
  'recovers row-major fractions only with complete, unique native ownership: %s',
  (variant) => {
    const { items, rules } = fixture()
    const punctuation = (text: string, x: number): (typeof items)[number] => ({
      text,
      rect: [x, 0, x + 2, 9],
      baseline: 9,
      height: 9,
      horizontal: true
    })
    items.push(
      punctuation('[', -4),
      punctuation(',', 25),
      punctuation(']', 64),
      punctuation(' ', 28),
      punctuation('\b', 32)
    )
    let text = '[1e−3, 1e−5]NN'
    if (variant === 'reversed') items.reverse()
    if (variant === 'missing-bar') rules.pop()
    if (variant === 'duplicate-bar') rules.push([...rules[0]])
    if (variant === 'unrelated-prose') {
      items.push(punctuation('unrelated', 75))
      text += ' unrelated'
    }
    const result = recoverNativeStackedScientificFractions(items, rules, [
      { text, position: 'normal' }
    ])
    if (variant === 'original' || variant === 'reversed')
      expect(result).toEqual([{ text: '[1e−3/N,1e−5/N]' }])
    else expect(result).toBeUndefined()
  }
)

it.each(['wrapped-fraction', 'wrapped-comma'])(
  'keeps the source run order when a list spans multiple lines: %s',
  (variant) => {
    const { items, rules } = fixture()
    const comma = { ...items[0], text: ',', rect: [24, 0, 26, 9] }
    if (variant === 'wrapped-fraction') {
      for (const item of items.slice(5)) {
        item.rect = item.rect.map((value, i) => value + (i % 2 ? 30 : -48))
        item.baseline += 30
      }
      rules[1] = rules[1].map((value, i) => value + (i % 2 ? 30 : -48))
    } else {
      comma.baseline += 30
      comma.rect = [-4, 30, -2, 39]
    }
    expect(
      recoverNativeStackedScientificFractions([...items, comma], rules, [{ text: '1e−3N,1e−5N' }])
    ).toEqual([{ text: '1e−3/N,1e−5/N' }])
  }
)
