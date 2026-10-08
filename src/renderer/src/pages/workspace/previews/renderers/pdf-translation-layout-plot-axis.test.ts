import { expect, it } from 'vitest'
import { readPdfTranslationCases } from '../../../../../../../test/fixtures/pdf-translation/read-cases'
import { groupPdfTranslationPages, type PdfLayoutPage } from './pdf-translation-layout'

it.each(
  readPdfTranslationCases<{
    name: string
    page: PdfLayoutPage
    accepted: boolean
    bodyKey: string
    tickKey: string
    neighborKey: string
    axisKeys: string[]
  }>('adjacent-plot-axis-native.jsonl')
)(
  'proves both plot axes before separating a near-body numeric object: $name',
  ({ page, accepted, bodyKey, tickKey, neighborKey, axisKeys }) => {
    for (const cleared of [false, true]) {
      const raw = structuredClone(page)
      if (cleared)
        for (const item of raw.items)
          if (!item.str.trim())
            Object.assign(item, {
              str: '',
              width: 0,
              height: 0,
              transform: [0, 0, 0, 0, 0, 0],
              fontName: undefined
            })
      const { units } = groupPdfTranslationPages({ pages: [raw] }),
        actual = units.flatMap((unit) =>
          unit.items.map((key, n) => [key, unit.originalStrings[n]])
        ),
        expected = raw.items.flatMap((item, index) =>
          item.str.trim() ? [[`1:${index}`, item.str]] : []
        ),
        body = units.find((unit) => unit.items.includes(bodyKey))!
      expect(actual.toSorted((a, b) => a[0].localeCompare(b[0]))).toEqual(
        expected.toSorted((a, b) => a[0].localeCompare(b[0]))
      )
      expect(new Set(actual.map(([key]) => key)).size).toBe(actual.length)
      expect(body.items.includes(tickKey)).toBe(!accepted)
      expect(body.items).not.toContain(neighborKey)
      if (accepted) {
        expect(body.source).toContain('careful conclusion.')
        for (const key of axisKeys) {
          const owner = units.find((unit) => unit.items.includes(key))!
          expect(owner).not.toBe(body)
          expect(owner.sourceOnly).toBe(true)
        }
      }
    }
  }
)

it.each(
  readPdfTranslationCases<{ name: string; pages: PdfLayoutPage[]; accepted: boolean }>(
    'side-float-page-native.jsonl'
  )
)(
  'joins narrowed page-end prose only across independently owned floats: $name',
  ({ pages, accepted }) => {
    const { units } = groupPdfTranslationPages({ pages }),
      left = units.find((unit) => unit.source.startsWith('The controlled'))!,
      right = units.find((unit) => unit.source.includes('linear measurements.'))
    const actual = units.flatMap((unit) =>
        unit.items.map((key, n) => [key, unit.originalStrings[n]])
      ),
      expected = pages.flatMap((page) =>
        page.items.flatMap((item, index) =>
          item.str.trim() ? [[`${page.page}:${index}`, item.str]] : []
        )
      )
    expect(actual.toSorted((a, b) => a[0].localeCompare(b[0]))).toEqual(
      expected.toSorted((a, b) => a[0].localeCompare(b[0]))
    )
    expect(new Set(actual.map(([key]) => key)).size).toBe(actual.length)
    if (accepted) {
      expect(right).toBe(left)
      expect(left.source).toContain('are linear measurements.')
      expect(left.source).toContain('are confirmed.')
    } else expect(right).not.toBe(left)
    expect(left.source).not.toContain('Figure')
    expect(left.source).not.toContain('neighboring')
  }
)
