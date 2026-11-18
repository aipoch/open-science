import { expect, it } from 'vitest'
import { readPdfTranslationCases } from '../fixtures/read-cases'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

const fixture = readPdfTranslationCases<{ page: PdfLayoutPage }>(
  'justified-heading-native.jsonl'
)[0]
const read = (page: PdfLayoutPage): ReturnType<typeof groupPdfTranslationPages> =>
  groupPdfTranslationPages({ pages: [page], pageCount: 1 })

it('joins a justified title at its peer-proved hanging origin and stops at the body', () => {
  const page = structuredClone(fixture.page),
    result = read(page)
  const heading = result.units.find((unit) => unit.items.includes('1:2'))!
  expect(heading.source).toBe('2.3 Robust methods can support stable updates')
  expect(heading.items).toEqual(['1:2', '1:4', '1:5'])
  expect(result.units.find((unit) => unit.items.includes('1:7'))?.source).toMatch(
    /^Ordinary explanations/
  )
  const indices = page.items.flatMap((item, index) => (item.str.trim() ? [`1:${index}`] : []))
  const claims = result.units.flatMap((unit) => unit.items)
  expect(new Set(claims).size).toBe(claims.length)
  expect([...claims].sort()).toEqual(indices.sort())
})

it.each([
  'missing-peer',
  'wrong-rail',
  'wrong-font',
  'rotation',
  'native-gap',
  'body-font',
  'body-gap',
  'missing-body',
  'missing-line-end',
  'wrong-label-gap',
  'gap-font',
  'gap-width',
  'gap-rotation'
])('keeps an unproved title tail separate: %s', (fault) => {
  const page = structuredClone(fixture.page),
    items = page.items
  const main = items[4],
    tail = items[5],
    body = items[7],
    peer = items[9]
  if (fault === 'missing-peer') peer.str = '2.8'
  if (fault === 'wrong-rail') tail.transform[4] -= 8
  if (fault === 'wrong-font') tail.fontName = 'other'
  if (fault === 'rotation') main.transform[1] = 1
  if (fault === 'native-gap')
    items.splice(5, 0, { ...main, str: 'foreign', width: 20, transform: [12, 0, 0, 12, 300, 500] })
  if (fault === 'body-font') body.fontName = 'other'
  if (fault === 'body-gap') body.transform[5] -= 20
  if (fault === 'missing-body') items.splice(7, 1)
  if (fault === 'missing-line-end') main.hasEOL = false
  if (fault === 'wrong-label-gap') main.transform[4] -= 2
  if (fault === 'gap-font') items[3].fontName = 'other'
  if (fault === 'gap-width') items[3].width -= 3
  if (fault === 'gap-rotation') items[3].transform[1] = 1
  const heading = read(page).units.find((unit) => unit.items.includes('1:2'))!
  const tailIndex = items.findIndex((item) => item.str === 'stable updates')
  expect(heading.items).not.toContain(`1:${tailIndex}`)
})
