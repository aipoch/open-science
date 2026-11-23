import assert from 'node:assert/strict'
import { it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutTextItem,
  type PdfTranslationLayout
} from '../../src/reader/layout.js'

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  font = 8,
  hasEOL = false,
  fontName = 'body'
): PdfLayoutTextItem => ({
  str,
  width,
  height: font,
  fontName,
  dir: 'ltr',
  hasEOL,
  transform: [font, 0, 0, font, x, y],
  fontAscent: 0.69,
  fontDescent: -0.19,
  fontVertical: false
})

it('preserves merged cells of a complete count table without holding an independent label', () => {
  const caption = [
    item('Table 2.', 312, 762, 30, 9, false, 'bold'),
    item('Number of observations in each group across the', 345, 762, 195, 9, true),
    item('whole survey.', 312, 751, 49, 9, true)
  ]
  const header = [
    item('Group', 312, 733, 20),
    item('Items', 386, 733, 23),
    item('Kinds', 444, 733, 19),
    item('Distinct kinds', 475, 733, 65, 8, true)
  ]
  const row = (name: string, y: number, counts: [string, string, string]): PdfLayoutTextItem[] => [
    item(name, 312, y, 24),
    ...counts.map((value, i) => {
      const width = value.length * 4
      return item(value, [409, 463, 540][i] - width, y, width, 8, i === 2)
    })
  ]
  const data = [
    ...row('Alpha', 718, ['18,264,647', '41', '38']),
    ...row('Beta', 707, ['12,782,697', '21,185', '10,393']),
    ...row('Gamma', 696, ['7,925,317', '74,185', '50,382'])
  ]
  const following = item(
    'Further counts are explained in the following section.',
    312,
    657,
    205,
    9,
    true
  )
  const left = Array.from({ length: 15 }, (_, n) =>
    item(
      'Several independent observations provide context for the survey.',
      57,
      762 - n * 10.4,
      227,
      9,
      true
    )
  )
  const parse = (records: PdfLayoutTextItem[]): PdfTranslationLayout['units'] =>
    groupPdfTranslationPages({
      pages: [
        {
          page: 1,
          width: 600,
          height: 840,
          rotation: 0,
          items: [...left, ...caption, ...header, ...records, following]
        }
      ]
    }).units
  const isJoinedHeader = (unit: PdfTranslationLayout['units'][number]): boolean =>
    unit.source === 'Items Kinds Distinct kinds'
  const valid = parse(data)
  assert.equal(valid.find(isJoinedHeader)?.sourceOnly, true)
  assert.equal(Boolean(valid.find((u) => u.source === 'Group')?.sourceOnly), false)
  const drifted = [...data]
  const fourthValue = drifted.at(-1)!
  const matrix = [...fourthValue.transform]
  matrix[4] += 4
  drifted[drifted.length - 1] = { ...fourthValue, transform: matrix }
  const unproved = parse(drifted).find(isJoinedHeader)
  assert.ok(unproved)
  assert.equal(Boolean(unproved.sourceOnly), false)
})

it('exempts the complete centered table caption locally inside a bibliography', () => {
  const title = 'Table 2. Reliable measurements for the selected groups'
  const bibliography = item('REFERENCES', 276, 400, 60, 10, true, 'section')
  const folio = item('2', 560, 742, 5, 9, true)
  const caption = [
    item('Table 2.', 187, 692, 36, 9, false, 'bold'),
    item('Reliable measurements for the selected groups', 227, 692, 198, 9, true, 'caption')
  ]
  const header = ['Name', 'Count', 'Score', 'Mean', 'Peak', 'References', 'Notes'].map((str, i) =>
    item(
      str,
      [95, 154, 197, 232, 274, 378, 460][i],
      668,
      [22, 22, 20, 17, 18, 39, 24][i],
      8,
      i === 6
    )
  )
  const row = (n: number): PdfLayoutTextItem[] => {
    const y = 604 - n * 11.5
    return [
      item(`201${n}-1a`, 88, y, 32),
      item(`${25 + n}.2`, 146, y, 21),
      item(`${15 + n}.5`, 190, y, 21),
      item(`${32 + n}.4`, 231, y, 21),
      item('41.3', 272, y, 19),
      item('1,2', 389, y, 12),
      item('Estimated', 460, y, 29, 8, true)
    ]
  }
  const finalReference = 'Miller, T. 2020, Journal of Literature, 39, 185.'
  const parse = (rows: PdfLayoutTextItem[][]): PdfTranslationLayout['units'] =>
    groupPdfTranslationPages({
      pages: [
        { page: 1, width: 612, height: 792, rotation: 0, items: [bibliography] },
        {
          page: 2,
          width: 612,
          height: 792,
          rotation: 0,
          items: [folio, ...caption, ...header, ...rows.flat()]
        },
        {
          page: 3,
          width: 612,
          height: 792,
          rotation: 0,
          items: [item(finalReference, 55, 713, 225, 9, true)]
        }
      ]
    }).units
  const proof = parse([row(0), row(1), row(2)])
  const eligibleCaption = proof.find((u) => u.source === title)
  assert.ok(eligibleCaption)
  assert.equal(Boolean(eligibleCaption.sourceOnly), false)
  assert.equal(proof.find((u) => u.source === finalReference)?.preserve, 'reference')
  assert.ok(
    proof.filter((u) => u.fragments[0].page === 2 && u.source !== title).every((u) => u.sourceOnly)
  )
  assert.equal(parse([row(0), row(1)]).find((u) => u.source === title)?.preserve, 'reference')
})
