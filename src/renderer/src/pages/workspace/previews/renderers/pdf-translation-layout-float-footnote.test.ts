import { expect, it } from 'vitest'
import { readPdfTranslationCases } from '../../../../../../../test/fixtures/pdf-translation/read-cases'
import { groupPdfTranslationPages, type PdfLayoutPage } from './pdf-translation-layout'

const wide = readPdfTranslationCases<{
  pages: PdfLayoutPage[]
  source: string
  together: string[][]
  separate: string[][]
}>('wide-caption-cross-page-native.jsonl')[0]
const notes = readPdfTranslationCases<{
  page: PdfLayoutPage
  first: string[]
  second: string[]
  sources: string[]
}>('symbolic-footnote-native-wrap.jsonl')[0]

function extract(pages: PdfLayoutPage[]): ReturnType<typeof groupPdfTranslationPages> {
  const result = groupPdfTranslationPages({ pages }),
    expected = pages.flatMap((page) =>
      page.items.flatMap((part, index) =>
        part.str.trim() ? [[`${page.page}:${index}`, part.str]] : []
      )
    ),
    actual = result.units.flatMap((unit) =>
      unit.items.map((key, index) => [key, unit.originalStrings[index]])
    )
  expect(actual.toSorted((a, b) => a[0].localeCompare(b[0]))).toEqual(
    expected.toSorted((a, b) => a[0].localeCompare(b[0]))
  )
  expect(new Set(actual.map(([key]) => key)).size).toBe(actual.length)
  return result
}

for (const cleared of [false, true]) {
  it(`proves a complete cross-column page sentence while keeping its caption separate, cleared=${cleared}`, () => {
    const pages = structuredClone(wide.pages)
    if (cleared)
      for (const page of pages)
        page.items.splice(0, 0, {
          str: '',
          width: 0,
          height: 0,
          dir: 'ltr',
          hasEOL: true,
          transform: [0, 0, 0, 0, 0, 0]
        })
    const result = extract(pages),
      offset = cleared ? 1 : 0,
      owner = (key: string): (typeof result.units)[number] => {
        const [page, index] = key.split(':').map(Number)
        return result.units.find((unit) => unit.items.includes(`${page}:${index + offset}`))!
      }
    for (const [left, right] of wide.together) expect(owner(left)).toBe(owner(right))
    for (const [left, right] of wide.separate) expect(owner(left)).not.toBe(owner(right))
    expect(owner('1:2').source).toBe(wide.source)
    expect(owner('1:2').kind).toBe('prose-candidate')
    expect(owner('1:2').fragments.map((fragment) => fragment.page)).toEqual([1, 2])
  })
  it(`separates symbolic attribution notes and preserves the complete dedented tail, cleared=${cleared}`, () => {
    const page = structuredClone(notes.page)
    if (cleared)
      page.items.splice(0, 0, {
        str: '',
        width: 0,
        height: 0,
        dir: 'ltr',
        hasEOL: true,
        transform: [0, 0, 0, 0, 0, 0]
      })
    const { units } = extract([page]),
      offset = cleared ? 1 : 0
    for (const [index, keys] of [notes.first, notes.second].entries()) {
      const adjusted = keys.map((key) => `1:${Number(key.split(':')[1]) + offset}`),
        unit = units.find((unit) => unit.items.includes(adjusted[0]))!
      expect(unit.items).toEqual(adjusted)
      expect(unit.source).toBe(notes.sources[index])
    }
  })
}

it.each([
  'finished-tail',
  'no-connector',
  'old-native-body',
  'missing-witness',
  'narrow-caption',
  'unlabelled-caption',
  'incomplete-caption',
  'caption-gap',
  'caption-risk',
  'body-interruption',
  'equation-interruption',
  'foreign-body',
  'missing-font',
  'rotation',
  'raised-scalar',
  'wrong-column',
  'margin-inside-body',
  'wrong-page'
])('rejects an unproven wide-caption page seam: %s', (fault) => {
  const pages = structuredClone(wide.pages),
    old = pages[0].items,
    next = pages[1].items
  if (fault === 'finished-tail') old[2].str += '.'
  if (fault === 'no-connector') old[2].str += ' evidence'
  if (fault === 'old-native-body') old.push({ ...old[2], str: 'Unaccounted body paragraph.' })
  if (fault === 'missing-witness') old[1].width -= 20
  if (fault === 'narrow-caption') for (const item of next.slice(0, 2)) item.width /= 2
  if (fault === 'unlabelled-caption') next[0].str = next[0].str.replace('Figure', 'Diagram')
  if (fault === 'incomplete-caption') next[1].str = next[1].str.replace(/[.]$/u, '')
  if (fault === 'caption-gap') for (const item of next.slice(2, 6)) item.transform[5] -= 30
  if (fault === 'caption-risk') next[1].str += ' undecoded ffi ffi'
  if (fault === 'body-interruption' || fault === 'equation-interruption')
    next.splice(2, 0, {
      ...next[2],
      str: fault === 'body-interruption' ? 'Independent body paragraph.' : 'q = r + s',
      hasEOL: true,
      transform: [10, 0, 0, 10, 40, 595]
    })
  if (fault === 'foreign-body') next[2].fontName = 'unrelated'
  if (fault === 'missing-font') delete next[2].fontName
  if (fault === 'rotation') next[2].transform[1] = 2
  if (fault === 'raised-scalar') next[3].transform[5] += 3
  if (fault === 'wrong-column') for (const item of next.slice(2, 6)) item.transform[4] += 20
  if (fault === 'margin-inside-body') old[3].transform[4] += 40
  if (fault === 'wrong-page') pages[1].page = 3
  const result = extract(pages),
    left = result.units.find((unit) => unit.items.includes('1:2'))!,
    right = result.units.find((unit) =>
      unit.items.includes(
        `${pages[1].page}:${next.indexOf(next.find((part) => part.str === 'a small proportion')!)}`
      )
    )!
  expect(left).not.toBe(right)
})

it.each([
  'single-note',
  'reversed-markers',
  'unknown-marker',
  'body-sized-marker',
  'low-marker',
  'peer-shift',
  'marker-gap',
  'not-at-bottom',
  'body-font',
  'tail-font',
  'tail-size',
  'tail-rotation',
  'native-interruption',
  'closed-sentence',
  'distant-tail',
  'large-leading'
])('rejects an unproven symbolic footnote wrap: %s', (fault) => {
  const page = structuredClone(notes.page),
    items = page.items
  if (fault === 'single-note') items[2].str = 'Unproven'
  if (fault === 'reversed-markers') [items[2].str, items[4].str] = [items[4].str, items[2].str]
  if (fault === 'unknown-marker') items[4].str = '§'
  if (fault === 'body-sized-marker')
    items[4].height = items[4].transform[0] = items[4].transform[3] = 9
  if (fault === 'low-marker') items[4].transform[5] -= 4
  if (fault === 'peer-shift') items[2].transform[4] -= 4
  if (fault === 'marker-gap') items[4].transform[4] -= 3
  if (fault === 'not-at-bottom') for (const item of items.slice(2)) item.transform[5] += 180
  if (fault === 'body-font') items[5].fontName = 'foreign'
  if (fault === 'tail-font') items[6].fontName = 'foreign'
  if (fault === 'tail-size') items[6].height = items[6].transform[0] = items[6].transform[3] = 7
  if (fault === 'tail-rotation') items[6].transform[1] = 2
  if (fault === 'native-interruption')
    items.splice(6, 0, { ...items[5], str: 'Independent note.', transform: [9, 0, 0, 9, 310, 86] })
  if (fault === 'closed-sentence') items[5].str += '.'
  if (fault === 'distant-tail') items[6].transform[4] -= 30
  if (fault === 'large-leading') items[6].transform[5] -= 10
  const result = extract([page]),
    tail = result.units.find((unit) => unit.source.includes('Laboratory.'))!
  expect(tail.items).not.toContain('1:5')
})
