import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([false, true])('retains a complete two-column bibliography (numbering gap=%s)', (gap) => {
  const item = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName = 'Body',
    hasEOL = true
  ): PdfLayoutTextItem => ({
    str,
    width,
    height: 10,
    dir: 'ltr',
    fontName,
    hasEOL,
    fontAscent: 0.75,
    fontDescent: -0.25,
    fontVertical: false,
    transform: [10, 0, 0, 10, x, y]
  })
  const records = (start: number, x: number, y: number): PdfLayoutTextItem[] =>
    Array.from({ length: 5 }, (_, offset) => {
      const number = start + offset + (gap && start > 1 && offset >= 2 ? 1 : 0)
      const baseline = y - offset * 32
      return [
        item(
          `[${number}] A. Sample, “Patterns of wind over the eastern slopes,”`,
          x,
          baseline,
          235
        ),
        item(`in Proc. Regional Field Studies, 201${offset}.`, x + 20, baseline - 12, 182, 'Venue')
      ]
    }).flat()
  const items = [
    item('5.', 125, 780, 7, 'Heading', false),
    item('ACKNOWLEDGMENTS', 138, 780, 119, 'Heading'),
    item('The research was supported by a regional field station.', 50, 758, 239),
    item('6.', 138, 712, 7, 'Heading', false),
    item('REFERENCES', 150, 712, 69, 'Heading'),
    ...records(1, 50, 694),
    ...records(6, 326, 776)
  ]
  const { units } = groupPdfTranslationPages({
    pageCount: 1,
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
  })
  const heading = units.find((unit) => unit.source === '6. REFERENCES')
  const firstRight = units.find((unit) => unit.items.includes('1:15'))
  expect(heading?.preserve).toBe('reference')
  expect(firstRight?.preserve).toBe(gap ? undefined : 'reference')
  expect(firstRight?.sourceOnly).toBe(gap ? undefined : true)
  expect(units.find((unit) => unit.items.includes('1:2'))?.sourceOnly).toBeUndefined()
  expect(units.flatMap(({ items }) => items).sort()).toEqual(
    items.map((_, index) => `1:${index}`).sort()
  )
})

it.each([
  { scenario: 'aligned', closed: false, continues: false, gap: false, retained: true },
  { scenario: 'numbering gap', closed: false, continues: false, gap: true, retained: false },
  { scenario: 'last-page column', closed: true, continues: false, gap: false, retained: true },
  { scenario: 'following page', closed: true, continues: true, gap: false, retained: false }
])(
  'classifies a bibliography above its facing heading ($scenario)',
  ({ closed, continues, gap, retained }) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      height = 8,
      fontName = 'Body',
      hasEOL = true
    ): PdfLayoutTextItem => ({
      str,
      width,
      height,
      dir: 'ltr',
      fontName,
      hasEOL,
      fontAscent: 0.76,
      fontDescent: -0.23,
      fontVertical: false,
      transform: [height, 0, 0, height, x, y]
    })
    const entries = (first: number, x: number, baselines: number[]): PdfLayoutTextItem[] =>
      baselines.flatMap((y, index) => [
        item(`${first + index + (gap && first > 1 ? 1 : 0)}.`, x, y, 7, 8, 'Body', false),
        item(`A. Reader, J. Field Stud. 12, 37 (${2010 + index}).`, x + 18, y, 146)
      ])
    const items = [
      item('Measurements in a controlled chamber were stable.', 42, closed ? 350 : 240, 230),
      item('We thank the readers who checked the manuscript.', 42, closed ? 320 : 217, 248),
      item('REFERENCES', 42, closed ? 272 : 180, 60, 10, 'Heading'),
      ...entries(1, 42, closed ? [245, 165, 92] : [158, 146, 134]),
      ...entries(4, 315, closed ? [738, 700, 655, 610, 565] : [330, 275, 210, 150, 138, 126])
    ]
    const pages = [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    if (continues) {
      pages.push({
        ...pages[0],
        page: 2,
        items: [item('The observatory restarted the survey the following year.', 42, 715, 248)]
      })
    }
    const { units } = groupPdfTranslationPages({ pages })
    const firstRight = units.find((unit) => unit.items.includes('1:9'))
    expect(firstRight?.sourceOnly).toBe(retained ? true : undefined)
    expect(firstRight?.preserve).toBe(retained ? 'reference' : undefined)
    if (!closed)
      expect(units.find((unit) => unit.items.includes('1:15'))?.preserve).toBe('reference')
    expect(units[0]?.sourceOnly).toBeUndefined()
    expect(units.flatMap(({ items }) => items).sort()).toEqual(
      pages.flatMap(({ page, items }) => items.map((_, index) => `${page}:${index}`)).sort()
    )
  }
)

it.each([false, true])(
  'keeps an inline-numbered bibliography above its facing heading (broken=%s)',
  (broken) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      height = 9,
      fontName = 'Bib'
    ): PdfLayoutTextItem => ({
      str,
      width,
      height,
      dir: 'ltr',
      fontName,
      hasEOL: true,
      fontAscent: 0.75,
      fontDescent: -0.23,
      fontVertical: false,
      transform: [height, 0, 0, height, x, y]
    })
    const entries = (first: number, x: number, rows: number[]): PdfLayoutTextItem[] =>
      rows.flatMap((y, index) => {
        const number = first + index + (broken && first > 1 ? 1 : 0)
        return [
          item(`${number}. A. Reader, observations along the shore,`, x, y, 229),
          item(
            first > 1 && index === rows.length - 1
              ? 'B. Reader, and C. Author,'
              : `J. Field Stud. 12, 37 (${2010 + index}).`,
            x + 13,
            y - 11,
            132
          )
        ]
      })
    const first = [
      item('The instruments were installed beside the observation point.', 54, 210, 240, 10),
      item('References', 54, 182, 56, 10, 'Heading'),
      ...entries(1, 61, [165, 142, 119]),
      ...entries(4, 322, [738, 715, 690, 165, 142, 119]),
      item('1', 303, 24, 5, 10, 'Folio')
    ]
    const second = [item('“New observations,” J. Field Stud. 15, 21 (2018).', 74, 738, 211)]
    const { units } = groupPdfTranslationPages({
      pages: [
        { page: 1, width: 612, height: 792, rotation: 0, items: first },
        { page: 2, width: 612, height: 792, rotation: 0, items: second }
      ]
    })
    const firstRight = units.find((unit) => unit.items.includes('1:8'))
    expect(firstRight?.source).toMatch(/^\d+\. A\. Reader/u)
    expect(firstRight?.sourceOnly).toBe(broken ? undefined : true)
    expect(firstRight?.preserve).toBe(broken ? undefined : 'reference')
    expect(units.find((unit) => unit.items.includes('1:0'))?.sourceOnly).toBeUndefined()
    expect(units.flatMap(({ items }) => items).sort()).toEqual(
      [...first.map((_, index) => `1:${index}`), '2:0'].sort()
    )
  }
)

it.each([false, true])(
  'retains a journal bibliography across two native lanes (broken=%s)',
  (broken) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      height = 9,
      fontName = 'Bib'
    ): PdfLayoutTextItem => ({
      str,
      width,
      height,
      dir: 'ltr',
      fontName,
      hasEOL: true,
      fontAscent: 0.75,
      fontDescent: -0.23,
      fontVertical: false,
      transform: [height, 0, 0, height, x, y]
    })
    const records = (start: number, count: number, x: number, top: number): PdfLayoutTextItem[] =>
      Array.from({ length: count }, (_, index) => {
        const n = start + index + (broken && start > 1 && index >= 2 ? 1 : 0)
        const y = top - index * 22
        if (start > 1 && index === 3)
          return [
            item(`[${n}] The first measurement used a smaller chamber.`, x, y, 201),
            item('The second observation corroborated the measurement.', x + 15, y - 11, 200)
          ]
        return [
          item(`[${n}] A. Reader. Observations of seasonal variation.`, x, y, 215),
          item('Field Studies, 12(3):45–51, 2022.', x + 15, y - 11, 139, 9, 'Journal')
        ]
      }).flat()
    const items = [
      item('Measurements were repeated until the readings remained stable.', 54, 709, 238, 10),
      item('References', 54, 215, 54, 10, 'Heading'),
      ...records(1, 4, 58.5, 196),
      ...records(5, 8, 320, 728)
    ]
    const { units } = groupPdfTranslationPages({
      pageCount: 1,
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const rightStart = units.find((unit) => unit.items.includes('1:10'))
    expect(rightStart?.preserve).toBe(broken ? undefined : 'reference')
    expect(Boolean(rightStart?.sourceOnly)).toBe(!broken)
    expect(units.find((unit) => unit.items.includes('1:0'))?.sourceOnly).toBeUndefined()
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(items.map((_, i) => `1:${i}`).sort())
  }
)
