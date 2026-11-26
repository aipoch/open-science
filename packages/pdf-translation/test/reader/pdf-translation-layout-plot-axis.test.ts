import { expect, it } from 'vitest'
import { readPdfTranslationCases } from '../fixtures/read-cases'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

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

it.each([false, true])(
  'retains a contour minimum only on its native script rail (%s)',
  (offset) => {
    const row = (
      str: string,
      x: number,
      y: number,
      size: number,
      width: number,
      fontName = 'Body',
      hasEOL = true
    ): PdfLayoutPage['items'][number] => ({
      str,
      width,
      height: str ? size : 0,
      dir: 'ltr',
      hasEOL,
      transform: [size, 0, 0, size, x, y],
      fontName,
      fontAscent: 0.78,
      fontDescent: -0.22,
      fontVertical: false
    })
    const items = [
      row('0 1 2 3 4 5 6', 100, 470, 8, 250, 'Chart'),
      row('χ', 150, 670, 8, 4, 'Symbol', false),
      row('2', 154, 674, 6.4, 3.5, 'Chart'),
      row('min', offset ? 156 : 154, 666, 6.4, 10, 'Chart', false),
      row('', 205, 505, 8, 0, 'Symbol'),
      row('χ', 205, 505, 8, 4, 'Symbol', false),
      row('2', 209, 509, 6.4, 3.5, 'Chart'),
      row('min', 209, 501, 6.4, 10, 'Chart', false),
      row('+1', 219, 505, 8, 9, 'Chart', false),
      row('', 56, 420, 9, 0, 'Caption'),
      row('Figure 2.', 56, 420, 9, 45, 'Caption', false),
      row('Model contour. The curve labeled χ2min + 1 marks the threshold.', 104, 420, 9, 300)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }],
      pageCount: 1
    })
    const label = units.find((unit) => unit.items.includes('1:3'))
    expect(label?.items).toEqual(['1:3'])
    expect(label?.sourceOnly).toBe(offset ? undefined : true)
    expect(label?.preserve).toBe(offset ? undefined : 'formula')
    expect(units.find((unit) => unit.items.includes('1:10'))?.sourceOnly).toBeUndefined()
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      items.flatMap((item, index) => (item.str ? [`1:${index}`] : [])).sort()
    )
  }
)
