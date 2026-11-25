import { expect, test } from 'vitest'
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
  hasEOL: boolean,
  fontName = 'Body'
): PdfLayoutTextItem => {
  const em = !str.trim() ? 0 : fontName === 'Heading' ? 9 : 10
  return {
    str,
    width,
    height: em,
    dir: 'ltr',
    transform: [em, 0, 0, em, x, y],
    hasEOL,
    fontName,
    fontAscent: 0.8,
    fontDescent: -0.2,
    fontVertical: false
  }
}

function sectionPages(lastNumber = 'IV.', shiftTail = 0): PdfLayoutPage[] {
  const section = (
    number: string,
    text: string,
    center: number,
    y: number,
    mainWidth: number,
    ending?: string
  ): PdfLayoutTextItem[] => {
    const x = center - mainWidth / 2
    return [
      item('', x, y, 0, true, 'Heading'),
      item(number, x, y, 12, false, 'Heading'),
      item(' ', x + 12, y, 10, false, 'Heading'),
      item(text, x + 22, y, mainWidth - 22, !!ending, 'Heading'),
      ...(ending ? [item(ending, center - 17 + shiftTail, y - 10.44, 34, false, 'Heading')] : []),
      item('', 0, 0, 0, true, 'Heading')
    ]
  }
  const paragraph = (left: number, y: number, short = false): PdfLayoutTextItem[] => [
    item(
      short
        ? 'Several field teams used independent equipment'
        : 'The working group evaluated several independent records together',
      left + 10,
      y,
      235,
      true
    ),
    item('before the results were added to the final study archive.', left, y - 11.52, 245, false)
  ]
  const page = (page: number, items: PdfLayoutTextItem[]): PdfLayoutPage => ({
    page,
    width: 612,
    height: 792,
    rotation: 0,
    items
  })
  return [
    page(1, [
      ...section('I.', 'OVERVIEW', 176.5, 600, 100),
      ...paragraph(54, 573),
      ...section('II.', 'OPERATING CONDITIONS FOR THE REGIONAL', 439.5, 340, 240, 'SURVEY'),
      ...paragraph(317, 304, true)
    ]),
    page(2, [
      ...section('III.', 'OBSERVATION SCHEDULE FOR THE COASTAL', 176.5, 340, 224, 'STUDY'),
      ...paragraph(54, 303)
    ]),
    page(3, paragraph(54, 640)),
    page(4, [...section(lastNumber, 'SUMMARY', 176.5, 600, 100), ...paragraph(54, 573)])
  ]
}

test('joins consecutive centered Roman heading wraps and keeps both native rows', () => {
  const units = groupPdfTranslationPages({
    pages: sectionPages(),
    pageCount: 4
  }).units
  for (const source of [
    'II. OPERATING CONDITIONS FOR THE REGIONAL SURVEY',
    'III. OBSERVATION SCHEDULE FOR THE COASTAL STUDY'
  ]) {
    const heading = units.find((unit) => unit.source === source)
    expect(heading?.kind).toBe('heading-candidate')
    expect(heading?.fragments).toHaveLength(2)
    expect(heading?.items).toHaveLength(3)
  }
  expect(units.some((unit) => unit.source === 'SURVEY' || unit.source === 'STUDY')).toBe(false)
})

test.each([
  ['missing subsequent Roman section', 'V.', 0],
  ['off-center second line', 'IV.', 3]
])('keeps the headings separate with %s', (_name, lastNumber, shiftTail) => {
  const units = groupPdfTranslationPages({
    pages: sectionPages(lastNumber, shiftTail),
    pageCount: 4
  }).units
  expect(units.some((unit) => unit.source === 'SURVEY')).toBe(true)
  expect(units.some((unit) => unit.source === 'STUDY')).toBe(true)
})

test.each([0, 4])(
  'joins compact small-caps heading rows on a shared column center (%d)',
  (offset) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      em = 10,
      hasEOL = true
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height: em,
      transform: [em, 0, 0, em, x, y],
      hasEOL,
      fontName: 'Body',
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false
    })
    const items = [
      row('The comparison independently reproduces the previous result.', 40.5, 485.5, 251),
      row('The earlier protocol has no further effect.', 40.5, 473.5, 135),
      row('V. S', 55.75, 443.5, 20, 10, false),
      row('TATISTICAL MODELS OF VARIATION WITH', 76.25, 443.5, 200, 8),
      row('SHARED PARAMETERS', 129 + offset, 431.5, 74, 8, false),
      row('', 0, 0, 0, 0),
      row('Subsequent experiments estimate how the parameters influence results', 50.5, 413, 241),
      row('under several operating conditions in the two separate groups.', 40.5, 401, 251)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const heading = units.find((unit) => unit.items.includes('1:2'))
    const qualifier = units.find((unit) => unit.items.includes('1:4'))
    expect(heading === qualifier).toBe(offset === 0)
    expect(heading?.source).toBe(
      'V. STATISTICAL MODELS OF VARIATION WITH' + (offset === 0 ? ' SHARED PARAMETERS' : '')
    )
    expect(units.find((unit) => unit.items.includes('1:6'))?.items).toEqual(['1:6', '1:7'])
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      items.flatMap((item, i) => (item.str ? ['1:' + i] : [])).toSorted()
    )
  }
)

test.each([0, 4])('keeps a centered Roman heading together after a determiner (%d)', (shift) => {
  const heading = 'IV. CALIBRATION AND VALIDATION OF THE'
  const items = [
    item('The previous series established a stable initial reading.', 54, 374, 245, true),
    item('Those results were saved.', 54, 362.5, 94, false),
    item('', 57, 330, 0, true, 'Heading'),
    item('IV.', 57, 330, 15, false, 'Heading'),
    item(' ', 72, 330, 10, false, 'Heading'),
    item(heading.slice(4), 82, 330, 214, true, 'Heading'),
    item('PROCEDURE', 148 + shift, 319.5, 57, false, 'Heading'),
    item('', 64, 294, 0, true),
    item('The next series followed the same schedule for each sample.', 64, 294, 235, true),
    item(
      'Independent measurements gave consistent results after calibration.',
      54,
      282.5,
      245,
      true
    )
  ]
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
  })
  const title = units.find((unit) => unit.items.includes('1:3'))
  expect(title?.source).toBe(heading + (shift ? '' : ' PROCEDURE'))
  expect(title?.items).toEqual(shift ? ['1:3', '1:5'] : ['1:3', '1:5', '1:6'])
  expect(title?.fragments).toHaveLength(shift ? 1 : 2)
  expect(units.find((unit) => unit.items.includes('1:8'))?.source).toMatch(/^The next series/u)
})
