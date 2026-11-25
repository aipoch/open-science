import { expect, it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from '../../src/reader/layout.js'

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  hasEOL = true
): PdfLayoutTextItem => ({
  str,
  dir: 'ltr',
  width,
  height: 10,
  transform: [10, 0, 0, 10, x, y],
  hasEOL,
  fontName: 'Body',
  fontAscent: 0.8,
  fontDescent: -0.2,
  fontVertical: false
})

const makePage = (page: number, items: PdfLayoutTextItem[]): PdfLayoutPage => ({
  page,
  width: 600,
  height: 800,
  rotation: 0,
  items
})

it.each([
  ['Dover', true],
  ['Palmer', false]
])('joins the continuation only when the second author is witnessed by %s', (author, joined) => {
  const first = makePage(1, [
    item('The field team saved the instrument records throughout', 50, 370, 230),
    item('the winter season. Several instruments stayed in use', 50, 358, 230),
    item('until the final observation, when the team carried', 50, 346, 230),
    item('them back to the laboratory for inspection.', 50, 334, 195),
    item('The second record covers several data collections', 320, 108, 230),
    item('that the field team used in its earlier analysis of', 320, 96, 230),
    item('background conditions. The independent archive contains', 320, 84, 230),
    item('other observations that are not directly comparable', 320, 72, 230),
    item('to those collected for the report by Reed &', 320, 60, 230),
    item('1', 298, 22, 4, false)
  ])
  const next = makePage(2, [
    item(
      'Fig. 1.— The earliest observations from the first two stations and the full series from the field',
      50,
      454,
      490
    ),
    item('team in the following season.', 50, 442, 130),
    item('Dover collection. Even so, the reading at the first', 50, 410, 230),
    item('station agrees with the estimate for the sample at', 50, 398, 230),
    item(`the second station reported by Reed & ${author} in 2004.`, 50, 386, 230),
    item('The values from each observation remain comparable.', 50, 374, 210),
    item('The remaining stations were selected during the first', 320, 410, 230),
    item('season to retain good coverage of the study area. The', 320, 398, 230),
    item('field team retrieved and stored the results for later', 320, 386, 230),
    item('analysis during routine visits in the following year.', 320, 374, 225),
    item('2', 298, 22, 4, false)
  ])
  const input = { pageCount: 2, pages: [first, next] }
  const before = structuredClone(input)
  const result = groupPdfTranslationPages(input)
  const owner = (key: string): (typeof result.units)[number] | undefined =>
    result.units.find((unit) => unit.items.includes(key))
  const prior = owner('1:8')
  const continuation = owner('2:2')
  expect(prior).toBeDefined()
  expect(continuation).toBeDefined()
  expect(prior === continuation).toBe(joined)
  expect(prior?.source.includes('Reed & Dover collection.')).toBe(joined)
  expect(prior).not.toBe(owner('2:6'))
  expect(owner('2:0')).toBe(owner('2:1'))
  expect(prior).not.toBe(owner('2:0'))
  expect(prior).not.toBe(owner('1:9'))
  expect(prior?.fragments.map((fragment) => fragment.page)).toEqual(joined ? [1, 2] : [1])
  const keys = result.units.flatMap((unit) => unit.items)
  expect(keys).toHaveLength(first.items.length + next.items.length)
  expect(new Set(keys).size).toBe(keys.length)
  expect(input).toEqual(before)
})
