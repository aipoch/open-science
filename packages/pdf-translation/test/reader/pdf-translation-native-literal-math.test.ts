import { expect, it } from 'vitest'
import { nativeLiteralMathCandidates as literalMathCandidates } from '../../src/reader/native-literal-math.js'
type Content = Parameters<typeof literalMathCandidates>[1]
type Item = Extract<Content['items'][number], { str: string }>
type Unit = {
  id: string
  source: string
  sourceOnly?: true
  preserve?: 'formula'
  fragments: {
    pageNumber: number
    rect: { x: number; y: number; width: number; height: number }
    items: { index: number; text: string }[]
  }[]
}
type Fixture = {
  items: Item[]
  content: Content
  units: Unit[]
  read: () => ReadonlySet<string>
  find: (source: string) => Unit
}
const item = (str: string, x: number, y: number, height = 10): Item => ({
  str,
  width: str.length * height * 0.45,
  height,
  fontName: 'native',
  transform: [height, 0, 0, height, x, y],
  dir: 'ltr',
  hasEOL: false
})
function fixture(kind = 'display'): Fixture {
  const items: Item[] =
    kind === 'display'
      ? [
          item('Ordinary neighboring prose.', 40, 700),
          item('u', 100, 600),
          item('=', 110, 600),
          item('x', 125, 600),
          item('(1)', 500, 600),
          { ...item('', 0, 0, 0), hasEOL: true },
          item('=', 110, 586),
          item('p', 125, 584.5, 7),
          item('data', 128.15, 583.5, 5),
          item('log', 150, 586),
          item('x', 165, 586),
          item('u', 100, 450),
          item('=', 110, 450),
          item('x', 125, 450),
          item('(2)', 500, 450),
          { ...item('', 0, 0, 0), hasEOL: true },
          item('Following ordinary explanation.', 40, 420)
        ]
      : [
          item('Ordinary neighboring prose.', 40, 700),
          item('∇', 100, 600),
          item('θ', 110, 599, 7),
          item('1', 120, 607),
          item('m', 120, 593),
          item('m', 135, 610, 7),
          item('∑', 132, 605),
          item('i', 132, 587, 7),
          item('=1', 135, 587, 7),
          item('[', 145, 610),
          item('log', 150, 600),
          item('D', 165, 600),
          item(']', 185, 610),
          item('.', 190, 600),
          item('Following ordinary explanation.', 40, 570)
        ]
  const content: Content = {
    items,
    lang: null,
    styles: { native: { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: 'sans-serif' } }
  }
  const units: Unit[] = items.flatMap((i, index) =>
    i.str
      ? [
          {
            id: 'owner-' + index,
            source: i.str,
            sourceOnly: !['log', 'data', 'D'].includes(i.str) ? true : undefined,
            preserve: !['log', 'data', 'D'].includes(i.str) ? 'formula' : undefined,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.02 },
                items: [{ index, text: i.str }]
              }
            ]
          }
        ]
      : []
  )
  for (const u of units)
    if (u.source.includes('ordinary') || u.source.includes('Ordinary')) {
      delete u.sourceOnly
      delete u.preserve
    }
  return {
    items,
    content,
    units,
    read: () => literalMathCandidates(units, content, 1),
    find: (s: string): Unit => units.find((u) => u.source === s)!
  }
}
it('retains only whole native math owners after the printed equation number', () => {
  const f = fixture(),
    before = structuredClone(f.units),
    ids = f.read()
  expect([...ids].sort()).toEqual([f.find('data').id, f.find('log').id].sort())
  expect(f.units).toEqual(before)
})
it('retains detached operators in a native gradient/sum packet', () => {
  const f = fixture('algorithm')
  expect([...f.read()].sort()).toEqual([f.find('log').id, f.find('D').id].sort())
})
it.each([
  'missing-owner',
  'duplicate-owner',
  'changed-source',
  'exterior-prose-owner',
  'wrong-column',
  'far-row',
  'no-adjacent-number',
  'prose-in-row'
])('does not preserve an unproved numbered packet: %s', (fault) => {
  const f = fixture(),
    log = f.find('log')
  if (fault === 'missing-owner') f.units.splice(f.units.indexOf(log), 1)
  if (fault === 'duplicate-owner') f.units.push({ ...log, id: 'duplicate' })
  if (fault === 'changed-source') log.fragments[0].items[0].text = 'other'
  if (fault === 'exterior-prose-owner') {
    const p = f.find('Following ordinary explanation.')
    log.source += ' ' + p.source
    log.fragments.push(...p.fragments)
    f.units.splice(f.units.indexOf(p), 1)
  }
  if (fault === 'wrong-column') f.items[6].transform[4] += 20
  if (fault === 'far-row') for (let i = 6; i <= 10; i++) f.items[i].transform[5] -= 80
  if (fault === 'no-adjacent-number') {
    f.items[14].str = '(7)'
    f.find('(2)').source = '(7)'
    f.find('(7)').fragments[0].items[0].text = '(7)'
  }
  if (fault === 'prose-in-row') {
    f.items[9].str = 'ordinary statement'
    log.source = 'ordinary statement'
    log.fragments[0].items[0].text = 'ordinary statement'
  }
  expect([...f.read()]).toEqual([])
})
it.each(['unprotected-gradient', 'unprotected-sum', 'ordinary-prose', 'exterior-owner'])(
  'does not preserve an unproved gradient packet: %s',
  (fault) => {
    const f = fixture('algorithm')
    if (fault === 'unprotected-gradient') {
      delete f.find('∇').sourceOnly
      delete f.find('∇').preserve
    }
    if (fault === 'unprotected-sum') {
      delete f.find('∑').sourceOnly
      delete f.find('∑').preserve
    }
    if (fault === 'ordinary-prose') {
      f.items[10].str = 'ordinary statement'
      f.find('log').source = 'ordinary statement'
      f.find('ordinary statement').fragments[0].items[0].text = 'ordinary statement'
    }
    if (fault === 'exterior-owner') {
      const p = f.find('Following ordinary explanation.'),
        op = f.find('log')
      op.source += ' ' + p.source
      op.fragments.push(...p.fragments)
      f.units.splice(f.units.indexOf(p), 1)
    }
    expect([...f.read()]).toEqual([])
  }
)

it.each(['plain', 'numbered', 'misaligned'])(
  'protects the complete operators of a native minimum display (%s)',
  (shape) => {
    const shift = shape === 'misaligned' ? -4 : 0
    const items = [
      { ...item('Take the minimum in', 95, 624), hasEOL: true },
      ...(shape === 'numbered' ? [item('(2.3)', 95, 605)] : []),
      item('min', 250, 605),
      item('k', 248.3 + shift, 598, 7),
      item('∈', 251.8 + shift, 598, 7),
      item('S', 255.3 + shift, 598, 7),
      item('\\', 258.8 + shift, 598, 7),
      item('R', 262.3 + shift, 598, 7),
      item('\u0000', 266.2, 613),
      item('f', 271, 605),
      item('(', 276, 605),
      item('a', 281, 605),
      item(') +', 286, 605),
      item('g', 301, 605),
      item('\u0001', 307, 613),
      item('is attained under these conditions.', 95, 583)
    ]
    const source = (group: Item[]): string => group.map(({ str }) => str).join(' ')
    const units = items.reduce<Unit[]>((result, i, index) => {
      const group =
        i.str === 'min'
          ? [i, items[index + 3]]
          : i.str === 'k'
            ? [i, items[index + 1], items[index + 3], items[index + 4]]
            : ['∈', 'S', '\\', 'R'].includes(i.str)
              ? []
              : [i]
      if (!group.length) return result
      const protectedInk = ['\u0000', '\u0001'].includes(i.str) || /^\(|^[fga]$|^\) \+$/.test(i.str)
      result.push({
        id: 'native-' + index,
        source: source(group),
        ...(protectedInk ? ({ sourceOnly: true, preserve: 'formula' } as const) : {}),
        fragments: [
          {
            pageNumber: 1,
            rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.02 },
            items: group.map((part) => ({ index: items.indexOf(part), text: part.str }))
          }
        ]
      })
      return result
    }, [])
    const selected = literalMathCandidates(units, { items, lang: null, styles: {} }, 1)
    expect(units.filter(({ id }) => selected.has(id)).map(({ source }) => source)).toEqual(
      shape === 'misaligned' ? [] : ['min S', 'k ∈ \\ R']
    )
  }
)

it('retains a numbered display logarithm with a native lowered base and no page-wide metrics', () => {
  const f = fixture()
  f.items.splice(
    0,
    f.items.length,
    item('Ordinary neighboring prose.', 40, 700),
    item('S', 120, 600),
    item('=', 128, 600),
    item('Tr', 136, 600),
    item('log', 149, 600),
    { ...item('2', 162.7, 597.5, 7), fontName: 'subscript' },
    item('λ', 168, 600),
    item('.', 175, 600),
    { ...item('(1)', 225, 600), hasEOL: true },
    { ...item('(2)', 225, 500), hasEOL: true },
    item('Following ordinary explanation.', 40, 420)
  )
  f.units.splice(
    0,
    f.units.length,
    ...f.items.map((i, index): Unit => ({
      id: 'owner-' + index,
      source: i.str,
      ...(index > 0 && index < 10 && index !== 4
        ? { sourceOnly: true as const, preserve: 'formula' as const }
        : {}),
      fragments: [
        {
          pageNumber: 1,
          rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.02 },
          items: [{ index, text: i.str }]
        }
      ]
    }))
  )
  const read = (): ReadonlySet<string> => literalMathCandidates(f.units, f.content, 1, false)
  const before = structuredClone(f.units)
  expect([...read()]).toEqual([f.find('log').id])
  expect(f.units).toEqual(before)

  f.items[5].transform[5] = 600
  expect([...read()]).toEqual([])
  f.items[5].transform[5] = 597.5

  f.items[9].transform[4] -= 10
  expect([...read()]).toEqual([])
  f.items[9].transform[4] += 10

  const following = f.units.pop()!
  const logarithm = f.find('log')
  logarithm.source += ' ' + following.source
  logarithm.fragments.push(...following.fragments)
  expect([...read()]).toEqual([])
})

it.each([
  {
    limit: [
      item('v', 102.275, 579, 7),
      { ...item('∈', 105.425, 579, 7), fontName: 'symbol' },
      item('V', 108.575, 579, 7)
    ],
    term: item('x', 116, 590.5)
  },
  {
    limit: [item('j', 101.6, 577.8, 8), { ...item('∈B', 105.2, 577.8, 8), fontName: 'symbol' }],
    term: item('y', 117, 590.5, 11)
  },
  {
    limit: [
      item('i', 95.3, 577.8, 8),
      { ...item('∈', 98.9, 577.8, 8), fontName: 'symbol' },
      item('B', 102.5, 577.8, 8),
      { ...item('ij', 106.1, 576.8, 6), fontName: 'index' },
      { ...item('∩', 111.5, 577.8, 8), fontName: 'symbol' },
      item('D', 115.1, 577.8, 8)
    ],
    term: item('z', 121, 590.5, 11)
  }
])('retains a complete centered lower limit with $limit.length source runs', ({ limit, term }) => {
  const sum = { ...item('∑', 100, 600), width: 14 }
  const content = { ...fixture().content, items: [sum, ...limit, term] }
  const lowerIndexes = limit.map((_, i) => i + 1)
  const termIndex = limit.length + 1
  const makeUnit = (id: string, indexes: number[], sourceOnly?: true): Unit => ({
    id,
    source: indexes.map((i) => content.items[i].str).join(''),
    sourceOnly,
    preserve: sourceOnly ? 'formula' : undefined,
    fragments: [
      {
        pageNumber: 1,
        rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.02 },
        items: indexes.map((index) => ({ index, text: content.items[index].str }))
      }
    ]
  })
  const operator = makeUnit('operator', [0], true)
  const lower = makeUnit('lower', lowerIndexes)
  const body = makeUnit('body', [termIndex], true)
  const units = [operator, lower, body]
  expect([...literalMathCandidates(units, content, 1)]).toEqual(['lower'])
  expect([...literalMathCandidates(units, content, 1, false)]).toEqual([])
  expect([
    ...literalMathCandidates(
      [operator, makeUnit('mixed', [...lowerIndexes, termIndex])],
      content,
      1
    )
  ]).toEqual([])
  for (const part of limit) part.transform[4] += 3
  expect([...literalMathCandidates(units, content, 1)]).toEqual([])
})

it.each(['display', 'inline', 'displaced', 'mixed prose'])(
  'protects only complete native stacked integral limits (%s)',
  (shape) => {
    const inline = shape === 'inline'
    const items = [
      { ...item('∫', 150, 600), width: inline ? 4.7 : 5.5, fontName: 'symbol' },
      {
        ...item('z', inline ? 157 : 160, 597.5, 7),
        width: 3,
        fontName: 'variable'
      },
      { ...item('stop', inline ? 160 : 163, 596.5, 5), width: 10, fontName: 'script' },
      {
        ...item('z', shape === 'displaced' ? 170 : inline ? 155 : 155.5, inline ? 588.4 : 577.3, 7),
        width: 3,
        fontName: 'variable'
      },
      {
        ...item('2', inline ? 158 : 158.5, inline ? 587.4 : 576.3, 5),
        width: 3,
        fontName: 'script'
      },
      item('φ', inline ? 172 : 176, inline ? 592 : 586.4),
      item('for every test function', 215, inline ? 592 : 586.4)
    ]
    const withUnit = (id: string, indices: number[], formula = false): Unit => ({
      id,
      source: indices.map((index) => items[index].str).join(' '),
      fragments: [
        {
          pageNumber: 1,
          rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
          items: indices.map((index) => ({ index, text: items[index].str }))
        }
      ],
      ...(formula ? { sourceOnly: true as const, preserve: 'formula' as const } : {})
    })
    const units = [
      withUnit('upper', [0, 1], true),
      withUnit('upper-script', shape === 'mixed prose' ? [2, 6] : [2]),
      ...(inline
        ? [withUnit('integrand', [3, 4, 5], true)]
        : [withUnit('lower', [3, 4]), withUnit('integrand', [5], true)]),
      ...(shape === 'mixed prose' ? [] : [withUnit('ordinary-prose', [6])])
    ]
    const before = structuredClone(units)
    expect(literalMathCandidates(units, { items, styles: {}, lang: null }, 1)).toEqual(
      new Set(shape === 'display' ? ['upper-script', 'lower'] : inline ? ['upper-script'] : [])
    )
    expect(units).toEqual(before)
  }
)

it.each(['stacked argument', 'flat argument'])(
  'retains the exponential operator only beside its complete native argument: %s',
  (geometry) => {
    const items = [
      item('An adjacent explanation remains available to translate.', 40, 630),
      item('q=', 120, 600),
      item('exp', 150, 600),
      item('\u0010', 165, 611),
      item('−', 170, 600),
      item('r', 176, 607),
      item('na', 176, geometry === 'flat argument' ? 600 : 593),
      item('\u0011', 190, 611),
      item(',', 212, 600),
      { ...item('(3)', 262, 600), hasEOL: true },
      { ...item('(4)', 262, 560), hasEOL: true }
    ]
    const units: Unit[] = items.flatMap((_, index) => {
      if (index === 5 || index === 6) return []
      const owned = index === 4 ? [4, 5, 6] : [index]
      return [
        {
          id: `owner-${index}`,
          source: owned.map((j) => items[j].str).join(' '),
          ...(index > 0 && index !== 2 ? { sourceOnly: true, preserve: 'formula' } : {}),
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.02 },
              items: owned.map((j) => ({ index: j, text: items[j].str }))
            }
          ]
        }
      ]
    })
    const before = structuredClone(units)
    const selected = literalMathCandidates(units, { items, lang: null, styles: {} }, 1)
    expect([...selected]).toEqual(geometry === 'stacked argument' ? ['owner-2'] : [])
    expect(units).toEqual(before)
  }
)
