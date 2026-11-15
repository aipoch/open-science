import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

function fixture(): PdfLayoutPage {
  const row = (
    str: string,
    x: number,
    y: number,
    width: number
  ): PdfLayoutPage['items'][number] => ({
    str,
    width,
    height: 10,
    dir: 'ltr',
    transform: [10, 0, 0, 10, x, y],
    fontName: 'Body',
    fontAscent: 0.8,
    fontDescent: -0.2,
    fontVertical: false,
    hasEOL: true
  })
  return {
    page: 1,
    width: 600,
    height: 800,
    rotation: 0,
    items: [
      row('Figure 1. This caption describes the measured responses.', 50, 760, 300),
      row('Each condition is recorded using the same reference scale.', 50, 748, 300),
      row('All displayed values retain the original measured units.', 50, 736, 300),
      row('The final comparison uses the same selected sample group.', 50, 724, 300),
      row('Calibration remains stable for every measured reference sample', 50, 620, 300),
      row('and all selected results remain consistent across groups.', 50, 600, 240),
      row(
        'For every sampled experimental group and each matched reference control, we measured cali-',
        65,
        580,
        285
      ),
      row('bration properties under the same conditions.', 50, 560, 220)
    ]
  }
}
function grouped(input: PdfLayoutPage): ReturnType<typeof groupPdfTranslationPages>['units'] {
  const result = groupPdfTranslationPages({ pages: [input] })
  const entries = result.units.flatMap((u) => u.items.map((key, n) => [key, u.originalStrings[n]]))
  expect(entries.toSorted()).toEqual(
    input.items.flatMap((i, n) => (i.str.trim() ? [[`1:${n}`, i.str]] : [])).toSorted()
  )
  expect(new Set(entries.map(([key]) => key)).size).toBe(entries.length)
  return result.units
}

it('joins a closed native word wrap with a separately witnessed word and local row pitch', () => {
  const input = fixture(),
    units = grouped(input),
    first = units.find((u) => u.items.includes('1:6'))!
  expect(first).toBe(units.find((u) => u.items.includes('1:7')))
  expect(first.source).toContain('measured calibration properties')
  expect(first.originalStrings).toEqual([input.items[6].str, input.items[7].str])
  expect(first.fragments).toHaveLength(2)
})

it.each([
  'no word witness',
  'compound witness',
  'different font',
  'different point',
  'rotated',
  'missing metrics',
  'foreign',
  'foreign out of order',
  'zero advance foreign',
  'column',
  'right edge',
  'pitch',
  'math',
  'table',
  'caption',
  'no EOL'
])('rejects a word join without the complete native proof: %s', (fault) => {
  const input = fixture()
  if (fault === 'no word witness')
    input.items[4].str = input.items[4].str.replace('Calibration', 'Alignment')
  if (fault === 'compound witness') input.items[4].str += ' cali-bration'
  if (fault === 'different font') input.items[7].fontName = 'Other'
  if (fault === 'different point') {
    input.items[7].height = 9
    input.items[7].transform[0] = 9
    input.items[7].transform[3] = 9
  }
  if (fault === 'rotated') input.items[7].transform = [0, 10, -10, 0, 50, 560]
  if (fault === 'missing metrics') delete input.items[7].fontAscent
  if (fault === 'zero advance foreign')
    input.items.push({ ...input.items[7], str: 'z', width: 0, transform: [10, 0, 0, 10, 100, 570] })
  if (fault === 'foreign' || fault === 'foreign out of order') {
    const item = {
      ...input.items[7],
      str: 'foreign',
      width: 20,
      transform: [10, 0, 0, 10, 100, 570]
    }
    if (fault === 'foreign') input.items.splice(7, 0, item)
    else input.items.push(item)
  }
  if (fault === 'column') input.items[7].transform[4] = 380
  if (fault === 'right edge') input.items[6].width -= 50
  if (fault === 'pitch') input.items[5].transform[5] += 5
  if (fault === 'math')
    input.items[6].str =
      'For every sampled experimental group x = y and each matched control, we measured cali-'
  if (fault === 'table')
    input.items.splice(7, 0, {
      ...input.items[6],
      str: '42',
      width: 20,
      transform: [10, 0, 0, 10, 400, 580]
    })
  if (fault === 'caption')
    input.items[6].str = 'Figure 2. For every sampled group we measured cali-'
  if (fault === 'no EOL') input.items[6].hasEOL = false
  const units = grouped(input),
    tail = input.items.findIndex((i) => i.str.startsWith('bration'))
  expect(units.find((u) => u.items.includes('1:6'))).not.toBe(
    units.find((u) => u.items.includes(`1:${tail}`))
  )
})

it('does not change an ordinary nonhyphen phrase boundary', () => {
  const input = fixture()
  input.items[6].str = 'The observed response remains stable across every condition. On'
  input.items[7].str = 'the other hand, the control follows a separate response.'
  const units = grouped(input)
  expect(units.find((u) => u.items.includes('1:6'))).not.toBe(
    units.find((u) => u.items.includes('1:7'))
  )
})
