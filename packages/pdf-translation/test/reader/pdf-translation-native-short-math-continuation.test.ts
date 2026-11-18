import { expect, it } from 'vitest'
import {
  shortMathContinuationPlans,
  applyShortMathContinuationPlans
} from '../../src/reader/native-short-math-continuation.js'
type Content = Parameters<typeof shortMathContinuationPlans>[1]
type Item = Extract<Content['items'][number], { str: string }>
type Unit = {
  id: string
  source: string
  sourceOnly?: true
  preserve?: 'formula' | 'literal'
  fragments: {
    pageNumber: number
    rect: { x: number; y: number; width: number; height: number }
    items: { index: number; text: string }[]
  }[]
}
type Fixture = {
  items: Item[]
  units: Unit[]
  content: Content
  read: () => ReturnType<typeof shortMathContinuationPlans>
  change: (index: number, text: string) => void
}
function fixture(): Fixture {
  const native = (
    str: string,
    x: number,
    y: number,
    height: number,
    width: number,
    fontName = 'body'
  ): Item => ({
    str,
    width,
    height,
    fontName,
    transform: [height, 0, 0, height, x, y],
    dir: 'ltr',
    hasEOL: false
  })
  const items = [
    native('The ordinary neighboring body paragraph reaches this right margin.', 60, 650, 10, 156),
    native('∑', 160, 607.5, 10, 8, 'sum'),
    native('j=1', 168, 597, 7, 12, 'script'),
    native('p(x)', 182, 600, 10, 20, 'math'),
    { ...native('To', 205.33, 600, 10, 10.67), hasEOL: true },
    native('complete this ordinary description.', 60, 586, 10, 120)
  ]
  const frag = (
    indices: number[],
    x: number,
    y: number,
    width: number,
    height: number
  ): Unit['fragments'][number] => ({
    pageNumber: 1,
    rect: { x: x / 600, y: y / 800, width: width / 600, height: height / 800 },
    items: indices.map((index) => ({ index, text: items[index].str }))
  })
  const units: Unit[] = [
    { id: 'peer', source: items[0].str, fragments: [frag([0], 60, 140, 156, 12)] },
    {
      id: 'sum',
      source: '∑',
      sourceOnly: true,
      preserve: 'formula',
      fragments: [frag([1], 160, 182.5, 8, 12)]
    },
    { id: 'prefix', source: 'j=1 p(x) To', fragments: [frag([2, 3, 4], 168, 190, 48, 16)] },
    { id: 'continuation', source: items[5].str, fragments: [frag([5], 60, 204, 120, 12)] }
  ]
  const content: Content = { items, styles: {}, lang: null }
  return {
    items,
    units,
    content,
    read: () => shortMathContinuationPlans(units, content, 1),
    change: (index: number, text: string) => {
      items[index].str = text
      for (const u of units)
        for (const f of u.fragments) for (const i of f.items) if (i.index === index) i.text = text
      units[2].source = units[2].fragments[0].items.map((i) => i.text).join(' ')
    }
  }
}
it('separates unchanged native math while binding a short body starter to its next row', () => {
  const f = fixture(),
    before = structuredClone(f.units),
    plans = f.read()
  expect(plans).toHaveLength(1)
  const result = applyShortMathContinuationPlans(f.units, plans, { width: 600, height: 800 })
  expect(f.units).toEqual(before)
  expect(result[2].sourceOnly).toBe(true)
  expect(result[2].preserve).toBe('literal')
  expect(result[2].source).toBe('j=1 p(x)')
  expect(result[3].source).toBe('To complete this ordinary description.')
  expect(result[3].fragments[1]).toEqual(before[3].fragments[0])
  expect(result[2].fragments[0].rect.width).toBeLessThan(before[2].fragments[0].rect.width)
  expect(result[2].fragments[0].rect.x).toBe(before[2].fragments[0].rect.x)
  expect(result[2].fragments[0].rect.y).toBe(before[2].fragments[0].rect.y)
  expect(result[2].fragments[0].rect.height).toBe(before[2].fragments[0].rect.height)
  const ownership = (
    us: Parameters<typeof applyShortMathContinuationPlans>[0]
  ): { index: number; text: string }[] =>
    us.flatMap((u) => u.fragments.flatMap((f) => f.items)).sort((a, b) => a.index - b.index)
  expect(ownership(result)).toEqual(ownership(before))
  expect(result[3].fragments[0].items).toEqual([{ index: 4, text: 'To' }])
  expect(result[3].fragments[0].rect.x).toBeGreaterThan(
    result[2].fragments[0].rect.x + result[2].fragments[0].rect.width
  )
})
it.each([
  'unprotected-sum',
  'nonformula-sum',
  'mixed-prose-prefix',
  'full-body-prefix',
  'bad-domain',
  'missing-next',
  'wrong-next-row',
  'wrong-next-font',
  'wrong-starter-font',
  'no-native-line-end',
  'noncontiguous-next',
  'shared-glyph',
  'changed-native-text',
  'wrong-margin',
  'missing-peer',
  'far-starter',
  'same-row-continuation',
  'prefix-multiple-fragments',
  'rotated-starter',
  'skewed-starter',
  'negative-starter-scale',
  'nan-starter-width',
  'rotated-following',
  'nan-domain-height',
  'bad-square-domain'
])('rejects an unproved math/prose seam: %s', (fault) => {
  const f = fixture()
  if (fault === 'unprotected-sum') delete f.units[1].sourceOnly
  if (fault === 'nonformula-sum') f.units[1].preserve = 'literal'
  if (fault === 'mixed-prose-prefix') {
    f.change(3, 'ordinary prose')
    f.items[3].fontName = 'body'
  }
  if (fault === 'full-body-prefix') f.items[3].fontName = 'body'
  if (fault === 'bad-domain') f.change(2, 'j 1')
  if (fault === 'missing-next') f.units.splice(3, 1)
  if (fault === 'wrong-next-row') f.items[5].transform[5] -= 30
  if (fault === 'wrong-next-font') f.items[5].fontName = 'math'
  if (fault === 'wrong-starter-font') f.items[4].fontName = 'math'
  if (fault === 'no-native-line-end') f.items[4].hasEOL = false
  if (fault === 'noncontiguous-next') {
    const other = { ...f.items[5], str: 'another owner', width: 1 }
    f.items.splice(5, 0, other)
    f.units[3].fragments[0].items[0].index = 6
    f.units.push({
      id: 'intruder',
      source: other.str,
      fragments: [{ ...f.units[3].fragments[0], items: [{ index: 5, text: other.str }] }]
    })
  }
  if (fault === 'shared-glyph') f.units[3].fragments[0].items.push({ index: 4, text: 'To' })
  if (fault === 'changed-native-text') f.units[2].fragments[0].items[0].text = 'other'
  if (fault === 'wrong-margin') f.items[5].transform[4] += 30
  if (fault === 'missing-peer') f.items[0].width -= 20
  if (fault === 'far-starter') f.items[4].transform[4] += 10
  if (fault === 'same-row-continuation') f.items[5].transform[5] = 600
  if (fault === 'prefix-multiple-fragments') f.units[2].fragments.push(f.units[2].fragments[0])
  if (fault === 'rotated-starter') f.items[4].transform[1] = 10
  if (fault === 'skewed-starter') f.items[4].transform[2] = 2
  if (fault === 'negative-starter-scale') f.items[4].transform[0] = -10
  if (fault === 'nan-starter-width') f.items[4].width = NaN
  if (fault === 'rotated-following') f.items[5].transform[1] = 2
  if (fault === 'nan-domain-height') f.items[2].height = NaN
  if (fault === 'bad-square-domain') f.change(2, 'j=[1)')
  expect(f.read()).toEqual([])
})
