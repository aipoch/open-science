import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'
import { readPdfTranslationCases } from '../fixtures/read-cases'

const fixture = readPdfTranslationCases<{ page: PdfLayoutPage }>(
  'wrapped-inline-expression-native.jsonl'
)[0]

it('keeps a wrapped inline expression in the sentence without losing its native fragments', () => {
  const { units } = groupPdfTranslationPages({ pages: [fixture.page] })
  expect(units).toHaveLength(1)
  expect(units[0]).toMatchObject({
    source:
      'Each value describes a distinct sampling position. Let each mapping be a linear projection (A z + c for some A and c). The result forms an estimate for the current sample under the conditions given in the example.',
    items: fixture.page.items.map((_, index) => `1:${index}`),
    originalStrings: fixture.page.items.map(({ str }) => str)
  })
  expect(units[0].fragments).toHaveLength(3)
  expect(units[0].preserve).toBeUndefined()
})

const controls: [string, (page: PdfLayoutPage) => void][] = [
  ['different opening face', ({ items }) => (items[1].fontName = 'foreign')],
  ['nonhorizontal expression', ({ items }) => (items[3].transform[1] = 0.4)],
  ['expression on a separate row', ({ items }) => (items[3].transform[5] += 6)],
  [
    'open parentheses',
    ({ items }) => (items[9].str = '. The result supports the current estimate')
  ],
  ['broken return rail', ({ items }) => (items[10].transform[4] += 5)],
  ['different right edge', ({ items }) => (items[9].width -= 7)]
]

it.each(controls)('does not join without continuous native body evidence: %s', (_, change) => {
  const page = structuredClone(fixture.page)
  change(page)
  const { units } = groupPdfTranslationPages({ pages: [page] })
  expect(units.some((unit) => unit.items.includes('1:0') && unit.items.includes('1:10'))).toBe(
    false
  )
})

it.each([false, true])(
  'keeps a wrapped function call with a native predicate, raised=%s',
  (raised) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Body',
      hasEOL = false
    ): PdfLayoutPage['items'][number] => ({
      str,
      dir: 'ltr',
      width,
      height: 10,
      transform: [10, 0, 0, 10, x, y],
      fontName,
      fontAscent: 0.75,
      fontDescent: -0.25,
      fontVertical: false,
      hasEOL
    })
    const lead =
      'The preceding result applies. We next find another expression for the power series'
    const body =
      ') appearing there. The resulting identity contains no additional coefficient multiplying the free parameter'
    const items = [
      item(lead, 82, 743, 442, 'Body', true),
      item('S', 70, 731 + (raised ? 2 : 0), 6, 'Math'),
      item('(', 78, 731, 4),
      item('u, w', 82, 731, 15, 'Math'),
      item(body, 97, 731, 378),
      item('w', 479, 731, 5, 'Math'),
      item('.', 484, 731, 3, 'Body', true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const unit = units.find((candidate) => candidate.items.includes('1:0'))
    expect(unit).toBeDefined()
    if (raised) {
      expect(unit?.items).not.toContain('1:4')
      return
    }
    expect(unit?.source).toBe(`${lead} S (u, w${body} w.`)
    expect(unit?.items).toEqual(items.map((_, i) => `1:${i}`))
    expect(unit?.fragments).toHaveLength(3)
  }
)

it.each([false, true])(
  'keeps matching congruence operands across a native row wrap, raised=%s',
  (raised) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Body',
      hasEOL = false,
      height = 11
    ): PdfLayoutPage['items'][number] => ({
      str,
      dir: 'ltr',
      width,
      height,
      transform: [height, 0, 0, height, x, y],
      fontName,
      fontAscent: 0.75,
      fontDescent: -0.2,
      fontVertical: false,
      hasEOL
    })
    const lead = 'Applying the previous identity gives residues congruent to',
      second = 'modulo seven. The resulting counts fall within the intervals'
    const items = [
      item(lead, 142, 689, 309),
      item('7', 454, 689, 5.5, 'Numbers'),
      item('−', 462, 689, 8.5, 'Operator'),
      item('z', 473, 689, 4, 'Variables'),
      item('and', 481, 689, 18, 'Body', true),
      item('5', 96, 676, 5.5, 'Numbers'),
      item('−', 104, 676, 8.5, 'Operator'),
      item('q', 115, 676, 5.7, 'Variables'),
      item('2', 121, raised ? 677 : 674.4, 4.2, 'Script', false, 8),
      item(second, 130, 676, 216),
      item('[1, 3]', 350, 676, 22, 'Numbers'),
      item('and', 376, 676, 18),
      item('[4, 6]', 398, 676, 22, 'Numbers'),
      item(', respectively, so', 420, 676, 79, 'Body', true),
      item(
        'each interval describes a different class of possible outcomes for a trial.',
        96,
        663,
        403,
        'Body',
        true
      ),
      item(
        'The estimate can then be compared with observed results in the sample.',
        96,
        650,
        403,
        'Body',
        true
      ),
      item(
        'When both intervals are empty, no representative is returned.',
        96,
        637,
        319,
        'Body',
        true
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const owner = units.find((unit) => unit.items.includes('1:0'))
    expect(owner).toBeDefined()
    if (raised) {
      expect(owner?.items).not.toContain('1:9')
      return
    }
    expect(owner?.source).toContain(`${lead} 7 − z and 5 − q2 ${second}`)
    expect(owner?.items).toEqual(items.map((_, index) => `1:${index}`))
    expect(owner?.fragments).toHaveLength(3)
  }
)
