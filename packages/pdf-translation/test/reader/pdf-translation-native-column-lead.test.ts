import { expect, it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from '../../src/reader/layout.js'
const word = (
  str: string,
  x: number,
  y: number,
  width: number,
  eol = true,
  size = 10
): PdfLayoutTextItem => ({
  str,
  width,
  height: size,
  dir: 'ltr',
  transform: [size, 0, 0, size, x, y],
  fontName: 'body',
  fontFamily: 'serif',
  fontAscent: 0.8,
  fontDescent: -0.2,
  fontVertical: false,
  hasEOL: eol
})
const fixture = (): { pages: PdfLayoutPage[] } => {
  const peer = [
    'The earlier paragraph establishes the ordinary body frame for every measured sample',
    'Each complete native row independently confirms the same measured column width',
    'The common type and paragraph margins remain stable throughout these ordinary lines',
    'A complete sentence closes this independent paragraph before the separate illustration.'
  ].map((s, n) => word(s, 40, 400 - n * 12, 250))
  let x = 50
  const opening = ['Reliable', 'signal', 'recognition', '(ABC)', 'has', 'been', 'an', 'active'].map(
    (s, n) => {
      const w = word(s, x, 100, s.length * 4.4, n === 7)
      x += w.width + 6
      return w
    }
  )
  const body = [
    'research remains useful for every observed input under changing conditions',
    'the complete record preserves each measured feature within the common frame',
    'each later row provides the same native type and stable right boundary',
    'and the final sentence closes the complete ordinary paragraph.'
  ].map((s, n) => word(s, 302, 600 - n * 12, n === 3 ? 220 : 250))
  return {
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        items: [
          ...peer,
          word('Fig. 1. A compact illustration.', 90, 130, 150, true, 8),
          ...opening,
          ...body,
          {
            ...word('Vertical margin note', 18, 200, 250, true, 20),
            transform: [0, 20, -20, 0, 18, 200]
          }
        ]
      }
    ]
  }
}
const joined = (
  raw: ReturnType<typeof fixture>
): ReturnType<typeof groupPdfTranslationPages>['units'][number] | undefined => {
  const items = raw.pages[0].items,
    head = items.findIndex((i) => i.str === 'Reliable'),
    tail = items.findIndex((i) => i.str.startsWith('research') || i.str.startsWith('Research'))
  return groupPdfTranslationPages(raw).units.find(
    (u) => u.items.includes(`1:${head}`) && u.items.includes(`1:${tail}`)
  )
}
it('restores a justified paragraph opening across independently witnessed body columns', () => {
  const raw = fixture(),
    u = joined(raw)!
  expect(u).toBeDefined()
  expect(u.kind).toBe('prose-candidate')
  expect(u.source).toMatch(/^Reliable signal recognition \(ABC\) has been an active research/)
  expect(u.fragments).toHaveLength(2)
  expect(u.items).toEqual(Array.from({ length: 12 }, (_, n) => `1:${n + 5}`))
  const original = raw.pages[0].items
  expect(u.originalStrings).toEqual(original.slice(5, 17).map((i) => i.str))
})
const controls: [string, (r: ReturnType<typeof fixture>) => void][] = [
  [
    'independent left body witness',
    (r) => {
      for (let i = 0; i < 4; i++) r.pages[0].items[i].fontName = 'foreign'
    }
  ],
  [
    'body continuation case',
    (r) =>
      (r.pages[0].items[13].str =
        'Research remains useful for every observed input under changing conditions')
  ],
  ['column width', (r) => (r.pages[0].items[14].width -= 4)],
  [
    'column gutter',
    (r) => {
      for (let i = 13; i < 17; i++) r.pages[0].items[i].transform[4] += 10
    }
  ],
  ['body type', (r) => (r.pages[0].items[8].fontName = 'heading')],
  ['native end of row', (r) => (r.pages[0].items[12].hasEOL = false)],
  ['native upright text', (r) => (r.pages[0].items[7].transform[1] = 1)],
  [
    'rotated foreign glyph overlap',
    (r) => {
      r.pages[0].items[17].transform[4] = 55
      r.pages[0].items[17].transform[5] = 100
    }
  ]
]
for (const [name, mutate] of controls)
  it(`requires ${name}`, () => {
    const r = fixture()
    mutate(r)
    expect(joined(r)).toBeUndefined()
  })

function wrappedProseLeadFixture(): { pages: PdfLayoutPage[] } {
  return {
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        items: [
          word(
            'The common measure remains stable across every complete example in this ordinary',
            55,
            620,
            330
          ),
          word('paragraph and its final sentence closes here.', 40, 608, 200),
          word('For this set of trials, the model is expected to show the following', 55, 596, 330),
          word('patterns', 40, 584, 44, false),
          word('', 84, 584, 0),
          { ...word('∑', 100, 565, 12), fontName: 'math', fontFamily: 'Symbol' },
          word(
            'The next ordinary paragraph remains separate from the complete mathematical display.',
            55,
            540,
            330
          ),
          word(
            'Every other source item retains its original independent ownership and boundary.',
            40,
            528,
            330
          ),
          word('The final sentence closes the independent body paragraph.', 40, 516, 280)
        ]
      }
    ]
  }
}

it('joins a lone wrapped prose word before an independent display', () => {
  const raw = wrappedProseLeadFixture()
  const { units } = groupPdfTranslationPages(raw)
  const owner = units.find((unit) => unit.items.includes('1:2'))
  const originalStrings = raw.pages[0].items.slice(2, 4).map((item) => item.str)
  expect(owner?.source).toBe(originalStrings.join(' '))
  expect(owner?.items).toEqual(['1:2', '1:3'])
  expect(owner?.originalStrings).toEqual(originalStrings)
  expect(owner?.fragments).toHaveLength(2)
  expect(owner?.sourceOnly).toBeFalsy()
  const display = units.find((unit) => unit.items.includes('1:5'))
  expect(display?.items).toEqual(['1:5'])
  expect(display?.sourceOnly).toBe(true)
})

const wrappedProseControls: [string, (items: PdfLayoutTextItem[]) => void][] = [
  ['different paragraph rail', (items) => (items[0].transform[4] += 6)],
  ['different tail font', (items) => (items[3].fontName = 'heading')],
  ['different tail pitch', (items) => (items[3].transform[5] -= 2)],
  ['uppercase tail', (items) => (items[3].str = 'Patterns')],
  ['overlapping glyph', (items) => items.push(word('x', 43, 584, 4))]
]
for (const [name, mutate] of wrappedProseControls) {
  it(`keeps the detached prose word separate with a ${name}`, () => {
    const raw = wrappedProseLeadFixture()
    mutate(raw.pages[0].items)
    const { units } = groupPdfTranslationPages(raw)
    expect(units.find((unit) => unit.items.includes('1:2'))?.items).not.toContain('1:3')
  })
}
