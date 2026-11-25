import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each(['complete', 'displaced tail', 'unraised byline mark', 'unmatched affiliation'])(
  'joins the first-page title above a numbered byline with %s evidence',
  (evidence) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      height: number,
      fontName: string,
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      width,
      height,
      dir: 'ltr',
      transform: [height, 0, 0, height, x, y],
      hasEOL,
      fontName,
      fontAscent: 0.72,
      fontDescent: -0.22,
      fontVertical: false
    })
    const title = 'Tracking persistent shifts across a network of low-energy'
    const tail = 'channels during repeated sampling'
    const items = [
      {
        ...item('Sample preprint metadata', 32, 180, 380, 20, 'Margin'),
        transform: [0, 20, -20, 0, 32, 180]
      },
      item('', 73, 702, 0, 0, 'Title', true),
      item(title, 73, 702, 470, 12, 'Title', true),
      item(tail, evidence === 'displaced tail' ? 220 : 215, 688, 186, 12, 'Title'),
      item('', 185, 663, 0, 0, 'Author', true),
      item('Dana Sample', 185, 663, 106, 10, 'Author'),
      item('1', 291, 667, 4, 7, 'Raised mark'),
      item(', Eli Field', 295, 663, 131, 10, 'Author'),
      item('2', 427, evidence === 'unraised byline mark' ? 663 : 667, 4, 7, 'Raised mark'),
      item('', 174, 657, 0, 0, 'Office mark', true),
      item('1', 174, 657, 4, 6, 'Office mark'),
      item('Department of Measurements, Sample University', 179, 653, 263, 9, 'Office'),
      item('', 188, 647, 0, 0, 'Office mark', true),
      item(evidence === 'unmatched affiliation' ? '3' : '2', 188, 647, 4, 6, 'Office mark'),
      item('Laboratory of Applied Methods, Field College', 193, 643, 235, 9, 'Office'),
      item('', 258, 632, 0, 0, 'Abstract', true),
      item('(Dated: February 9, 2012)', 258, 632, 100, 9, 'Abstract', true),
      ...Array.from({ length: 5 }, (_, n) =>
        item(
          'We test the measurements across several different settings.',
          110,
          614 - n * 10,
          396,
          9,
          'Abstract',
          true
        )
      ),
      ...[54, 317].flatMap((x) =>
        Array.from({ length: 12 }, (_, n) =>
          item(
            'The following results include all measurements.',
            x,
            520 - n * 12,
            245,
            10,
            'Author',
            true
          )
        )
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const head = units.find((unit) => unit.items.includes('1:2'))
    const continuation = units.find((unit) => unit.items.includes('1:3'))
    if (evidence === 'complete') {
      expect(head?.source).toBe(title + ' ' + tail)
      expect(head?.items).toEqual(['1:2', '1:3'])
      expect(head?.fragments).toHaveLength(2)
      expect(head?.sourceOnly).toBeUndefined()
      expect(continuation).toBe(head)
    } else {
      expect(head?.source).toBe(title)
      expect(continuation?.source).toBe(tail)
    }
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      items.flatMap((entry, index) => (entry.str.trim() ? [`1:${index}`] : [])).toSorted()
    )
  }
)

it.each([true, false])('keeps a wrapped author byline with centered surname=%s', (centered) => {
  const item = (
    str: string,
    x: number,
    y: number,
    width: number,
    height = 11,
    hasEOL = false
  ): PdfLayoutTextItem => ({
    str,
    width,
    height,
    dir: 'ltr',
    transform: [height || 11, 0, 0, height || 11, x, y],
    hasEOL,
    fontName: 'body',
    fontAscent: 0.72,
    fontDescent: -0.22,
    fontVertical: false
  })
  const tail = centered ? 276 : 250
  const items = [
    item('Watching layered materials react under varied sunlight', 108, 745, 384, 28),
    item('', 100, 729, 0, 0, true),
    item('T. Pines', 100, 729, 50),
    item('1', 150, 733.3, 3.2, 6.4),
    item(', D. Brook', 153.2, 729, 61.8),
    item('2', 215, 733.3, 3.2, 6.4),
    item(', J. Hall', 218.2, 729, 50.8),
    item('1', 269, 733.3, 3.2, 6.4),
    item(', L. MacIntyre', 272.2, 729, 88.8),
    item('2', 361, 733.3, 3.2, 6.4),
    item(', G. Harper', 364.2, 729, 65.8),
    item('2', 430, 733.3, 3.2, 6.4),
    item(', and A.', 433.2, 729, 66.8),
    item('', tail, 715.3, 0, 0, true),
    item('Willow', tail, 715.3, 44.8),
    item('2', tail + 44.8, 719.6, 3.2, 6.4),
    item('', 108, 698, 0, 0, true),
    item('1', 108, 698, 3.2, 6.4),
    item('University of Grove, Department of Materials, Westridge', 111.2, 693.7, 380.8),
    item('', 165, 676.4, 0, 0, true),
    item('2', 165, 676.4, 3.2, 6.4),
    item('North College, Material Studies, Florence', 168.2, 672.1, 266.8),
    item('', 86, 590, 0, 0, true),
    item('Samples reacted consistently throughout the study.', 86, 590, 400, 11, true)
  ]
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 600, height: 840, rotation: 0, items }]
  })
  for (const key of ['1:2', '1:14']) {
    const row = units.find((unit) => unit.items.includes(key))
    expect(row).toBeDefined()
    expect(Boolean(row?.sourceOnly)).toBe(centered)
  }
  expect(units.find((unit) => unit.items.includes('1:0'))?.sourceOnly).toBeUndefined()
  expect(units.find((unit) => unit.items.includes('1:18'))?.sourceOnly).toBeUndefined()
})
