import { expect, it } from 'vitest'
import { readPdfTranslationCases } from '../../../../../../../test/fixtures/pdf-translation/read-cases'
import { groupPdfTranslationPages, type PdfLayoutPage } from './pdf-translation-layout'

const cases = readPdfTranslationCases<{
  name: string
  page: PdfLayoutPage
  source: string
  firstIndex: number
  prefixIndex: number
  tailIndex: number
  lastIndex: number
  neighborIndex: number
  joined: boolean
}>('wrapped-numeric-parameter-prose.jsonl')

for (const cleared of [false, true])
  it.each(cases)('proves the entire parameter paragraph: $name, cleared=' + cleared, (fixture) => {
    const page = structuredClone(fixture.page)
    if (cleared)
      for (const part of page.items)
        if (!part.str.trim())
          Object.assign(part, { str: '', width: 0, height: 0, transform: [0, 0, 0, 0, 0, 0] })
    const { units } = groupPdfTranslationPages({ pages: [page] }),
      actual = units.flatMap((unit) =>
        unit.items.map((key, at) => [key, unit.originalStrings[at]])
      ),
      expected = page.items.flatMap((part, at) => (part.str.trim() ? [[`1:${at}`, part.str]] : [])),
      owner = (index: number): (typeof units)[number] =>
        units.find((unit) => unit.items.includes(`1:${index}`))!
    expect(actual.toSorted((a, b) => a[0].localeCompare(b[0]))).toEqual(
      expected.toSorted((a, b) => a[0].localeCompare(b[0]))
    )
    expect(new Set(actual.map(([key]) => key)).size).toBe(actual.length)
    if (fixture.joined) {
      expect(owner(fixture.firstIndex).source).toBe(fixture.source)
      expect(owner(fixture.firstIndex).sourceOnly).toBeUndefined()
      expect(owner(fixture.prefixIndex)).toBe(owner(fixture.firstIndex))
      expect(owner(fixture.lastIndex)).toBe(owner(fixture.firstIndex))
      expect(owner(fixture.neighborIndex)).not.toBe(owner(fixture.firstIndex))
    } else expect(owner(fixture.prefixIndex)).not.toBe(owner(fixture.tailIndex))
  })
