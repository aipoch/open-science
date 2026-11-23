import { expect, it } from 'vitest'
import { readPdfTranslationCases } from '../fixtures/read-cases'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

type Fixture = {
  name: string
  pages: PdfLayoutPage[]
  expected: Partial<Record<'join' | 'separate' | 'sameRow' | 'differentRow', number[]>>
}
const fixtures = readPdfTranslationCases<Fixture>('native-source-boundaries.jsonl')
const fixture = (name: string): Fixture => structuredClone(fixtures.find((f) => f.name === name)!)
type Layout = ReturnType<typeof groupPdfTranslationPages>
const read = (
  input: Fixture
): {
  result: Layout
  owner: (index: number) => Layout['units'][number]
  row: (index: number) => Layout['pages'][number]['blocks'][number]['lines'][number]
} => {
  const original = structuredClone(input.pages)
  const result = groupPdfTranslationPages({ pages: input.pages })
  const expectedKeys = input.pages.flatMap((page) =>
    page.items.flatMap((item, index) => (item.str.trim() ? [`${page.page}:${index}`] : []))
  )
  const keys = result.units.flatMap((unit) => unit.items)
  expect(keys.toSorted()).toEqual(expectedKeys.toSorted())
  expect(new Set(keys).size).toBe(keys.length)
  for (const unit of result.units)
    unit.items.forEach((key, index) => {
      const [page, at] = key.split(':').map(Number)
      expect(unit.originalStrings[index]).toBe(
        input.pages.find((p) => p.page === page)!.items[at].str
      )
    })
  expect(input.pages).toEqual(original)
  const key = (index: number): string => `${input.pages[0].page}:${index}`
  return {
    result,
    owner: (index: number) => result.units.find((unit) => unit.items.includes(key(index)))!,
    row: (index: number) => {
      const row = result.pages
        .flatMap((page) => page.blocks)
        .flatMap((block) => block.lines)
        .find((line) => line.items.includes(key(index)))
      expect(row).toBeDefined()
      return row!
    }
  }
}

it.each(fixtures)('keeps native source boundaries for $name', (input) => {
  const r = read(structuredClone(input))
  for (const [kind, pair] of Object.entries(input.expected)) {
    const [a, b] = pair
    if (kind === 'join') expect(r.owner(a)).toBe(r.owner(b))
    if (kind === 'separate') expect(r.owner(a)).not.toBe(r.owner(b))
    if (kind === 'sameRow') expect(r.row(a)).toBe(r.row(b))
    if (kind === 'differentRow') expect(r.row(a)).not.toBe(r.row(b))
  }
})

it.each(['native-break', 'interrupted-source', 'displaced-operand', 'wrong-size', 'ordinary-word'])(
  'does not attach a spaced radical operand with %s',
  (fault) => {
    const f = fixture('spaced-radical'),
      items = f.pages[0].items
    let operand = 3
    if (fault === 'native-break') items[2].hasEOL = true
    if (fault === 'interrupted-source') {
      items.splice(3, 0, {
        ...items[0],
        str: 'Independent note.',
        width: 70,
        transform: [10, 0, 0, 10, 500, 500]
      })
      operand++
    }
    if (fault === 'displaced-operand') items[3].transform[4] += 12
    if (fault === 'wrong-size') {
      items[3].height = 7
      items[3].transform[0] = items[3].transform[3] = 7
    }
    if (fault === 'ordinary-word') items[3].str = 'ordinary words'
    const r = read(f)
    expect(r.row(2)).not.toBe(r.row(operand))
  }
)

it.each(['native-break', 'different-font', 'displaced-return', 'not-division'])(
  'does not reassign a nested power with %s',
  (fault) => {
    const f = fixture('nested-exponent'),
      items = f.pages[0].items
    if (fault === 'native-break') items[6].hasEOL = true
    if (fault === 'different-font') items[8].fontName = 'independent'
    if (fault === 'displaced-return') items[8].transform[4] += 12
    if (fault === 'not-division') items[8].str = ')'
    const r = read(f)
    expect(r.row(7)).not.toBe(r.row(6))
  }
)

it.each([
  'later-page',
  'independent-heading',
  'different-font',
  'displaced-center',
  'large-leading',
  'not-first-source',
  'interrupted-source'
])('keeps a modest title continuation separate with %s', (fault) => {
  const f = fixture('modest-title'),
    page = f.pages[0],
    items = page.items
  if (fault === 'later-page') page.page = 2
  if (fault === 'independent-heading')
    items[0].str = 'AN INDEPENDENT HEADING ABOUT SCIENTIFIC NETWORKS'
  if (fault === 'different-font') items[1].fontName = 'independent'
  if (fault === 'displaced-center') items[1].transform[4] += 30
  if (fault === 'large-leading') items[1].transform[5] -= 30
  if (fault === 'not-first-source')
    items.unshift({
      ...items[3],
      str: 'An independent preceding source.',
      transform: [12, 0, 0, 12, 40, 720]
    })
  if (fault === 'interrupted-source')
    items.splice(1, 0, {
      ...items[3],
      str: 'Independent note.',
      transform: [12, 0, 0, 12, 40, 500]
    })
  const r = read(f)
  const first = fault === 'not-first-source' ? 1 : 0
  const next = fault === 'not-first-source' || fault === 'interrupted-source' ? 2 : 1
  expect(r.owner(first)).not.toBe(r.owner(next))
})

it.each([1, 1.2])('joins the first centered title at %s times body size', (ratio) => {
  const f = fixture('modest-title')
  for (const item of f.pages[0].items.slice(0, 2)) {
    item.height = 12 * ratio
    item.transform[0] = item.transform[3] = item.height
  }
  const r = read(f)
  expect(r.owner(0)).toBe(r.owner(1))
  expect(r.owner(0)).not.toBe(r.owner(2))
})

it.each([1, 2])('keeps the title, byline, and affiliation apart on page %s', (page) => {
  const f = fixture('centered-title-and-affiliation')
  f.pages[0].page = page
  const r = read(f)
  const owners = [r.owner(0), r.owner(2), r.owner(8)]
  expect(new Set(owners).size).toBe(3)
  expect(owners.map((owner) => owner.fragments.length)).toEqual([1, 1, 1])
})

it.each([true, false])('continues a late sentence start with matching folios: %s', (matching) => {
  const input = fixture('sentence-start-at-page-end')
  if (!matching) input.pages[2].items[0].str = 'x'
  const { result } = read(input)
  const unit = result.units.find((owner) => owner.items.includes('2:9'))!
  expect(unit.fragments.map((fragment) => fragment.page)).toEqual(matching ? [2, 3] : [2])
  expect(unit.items.includes('3:1')).toBe(matching)
  expect(unit.items).not.toContain('2:8')
})

it.each([true, false])('separates small-cap front headings with a matching face: %s', (matches) => {
  const input = fixture('small-cap-front-headings')
  if (!matches) {
    for (const mark of input.pages[0].items.slice(7, 10)) mark.fontName = 'Other'
  }
  const r = read(input)
  expect(r.owner(1) !== r.owner(4)).toBe(matches)
  expect(r.owner(7) !== r.owner(11)).toBe(matches)
  expect(r.owner(1)).toBe(r.owner(2))
  expect(r.owner(7)).toBe(r.owner(9))
})

it.each([true, false])(
  'separates front headings when the text returns to its rail: %s',
  (returns) => {
    const input = fixture('small-cap-front-headings'),
      items = input.pages[0].items
    for (const index of [4, 11]) {
      items[index].transform[4] -= 0.42
      items[index].width += 0.42
    }
    if (!returns) items[12].transform[4] -= 0.75
    const r = read(input)
    expect(r.owner(1) !== r.owner(4)).toBe(returns)
    expect(r.owner(7) !== r.owner(11)).toBe(returns)
  }
)

it.each([
  'new-paragraph',
  'different-process',
  'different-script-type',
  'finished-sentence',
  'ordinary-label'
])('keeps an independent scripted tail separate with %s', (fault) => {
  const f = fixture('scripted-theorem-tail'),
    items = f.pages[0].items
  if (fault === 'new-paragraph') for (const item of items.slice(5)) item.transform[4] += 15
  if (fault === 'different-process') items[6].str = 'Z'
  if (fault === 'different-script-type') items[7].fontName = 'independent'
  if (fault === 'finished-sentence') items[4].str += '.'
  if (fault === 'ordinary-label') items[0].str = 'A standalone ordinary label. A measured process '
  const r = read(f)
  expect(r.owner(0)).not.toBe(r.owner(5))
})

it.each(['shared emphasis', 'different face', 'intervening text'])(
  'continues coordinated terms across the native page edge (%s)',
  (proof) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Body',
      hasEOL = true
    ): PdfLayoutPage['items'][number] => ({
      str,
      width,
      height: 9,
      fontName,
      dir: 'ltr',
      fontAscent: 0.76,
      fontDescent: -0.2,
      fontVertical: false,
      hasEOL,
      transform: [9, 0, 0, 9, x, y]
    })
    const left = [
      item('The preceding analysis gives the calibration results for all samples.', 54, 500, 239),
      item('The independent measurements are summarized in the final section.', 54, 489, 238),
      item('After collecting measurements across all conditions, we introduce', 321, 83, 239),
      item('two related notions to distinguish the effects, namely', 316, 72, 175, 'Body', false),
      item('Signal stability', 493, 72, 50, 'Emphasis', false),
      item('and', 545, 72, 15, 'Body', false)
    ]
    const right = [
      ...(proof === 'intervening text' ? [item('Independent notes', 54, 752, 69)] : []),
      item(
        'Signal-based control',
        54,
        736,
        77,
        proof === 'different face' ? 'Other' : 'Emphasis',
        false
      ),
      item('which can be assessed independently with the', 133, 736, 161),
      item('reported observations. We continue with the results from each trial.', 54, 725, 240)
    ]
    const pages = [left, right].map((items, index) => ({
      page: index + 1,
      width: 612,
      height: 792,
      rotation: 0,
      items
    }))
    const result = groupPdfTranslationPages({ pages, pageCount: 2 })
    const owner = result.units.find(({ items }) => items.includes('1:5'))
    expect(owner?.fragments.map(({ page }) => page)).toEqual(
      proof === 'shared emphasis' ? [1, 2] : [1]
    )
    if (proof === 'shared emphasis')
      expect(owner?.source).toContain('Signal stability and Signal-based control which')
    expect(result.units.flatMap(({ items }) => items).sort()).toEqual(
      pages.flatMap(({ page, items }) => items.map((_, index) => `${page}:${index}`)).sort()
    )
  }
)
