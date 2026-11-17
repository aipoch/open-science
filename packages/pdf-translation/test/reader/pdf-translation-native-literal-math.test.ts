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
