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
  font: number,
  fontName: string,
  hasEOL = true
): PdfLayoutTextItem => ({
  str,
  width,
  height: font,
  fontName,
  dir: 'ltr',
  hasEOL,
  transform: [font, 0, 0, font, x, y],
  fontAscent: 0.72,
  fontDescent: -0.21,
  fontVertical: false
})

function endMatter(skippedNumber = false): PdfLayoutTextItem[] {
  const closing = (y: number): PdfLayoutTextItem => item('', 0, y, 0, 0, 'none')
  const availability = [
    item('Data availability.', 315, 449, 68, 9, 'bold', false),
    item('The measurements and intermediate records are', 388, 449, 167, 8, 'body'),
    item(
      'available from the corresponding author for independent replication',
      315,
      439,
      239,
      8,
      'body'
    ),
    item(
      'and for later comparisons with additional observations.',
      315,
      429,
      249,
      8,
      'body',
      false
    ),
    closing(429),
    item('REFERENCES', 315, 406, 64, 9.4645, 'heading', false),
    closing(406)
  ]
  const entries: PdfLayoutTextItem[] = []
  let y = 391
  const h = 7.5716
  for (let number = 1; number <= 7; number++) {
    const wrapped = number === 3 || number === 6
    entries.push(
      item(`${number + (skippedNumber && number >= 4 ? 1 : 0)}.`, 315, y, 8, h, 'ref', false),
      item(
        `A. Writer and B. Coauthor, Journal of Measurements${wrapped ? ',' : ` 8, ${18 + number} (2000).`}`,
        332.7,
        y,
        223,
        h,
        'ref'
      )
    )
    if (wrapped) {
      y -= 10
      entries.push(item('9, 27 (2001).', 332.7, y, 45, h, 'ref'))
    }
    y -= 10
  }
  return [
    item('position (', 41.84, 603.24, 39.56, 8.9664, 'body', false),
    item('x', 81.51, 603.24, 3.98, 8.9664, 'italic', false),
    item('=', 90.45, 603.24, 7.27, 9.343, 'math', false),
    item('3), shown for this angle setting.', 102.56, 603.24, 138.57, 8.9664, 'body'),
    item(
      'varied measurement conditions across all groups.',
      41.57,
      574.4,
      216.33,
      8.9664,
      'body',
      false
    ),
    closing(574.4),
    ...availability,
    ...entries
  ]
}

it.each([false, true])('keeps a flush bibliography across columns (numbering gap=%s)', (gap) => {
  const references = (start: number, count: number, x: number, top: number): PdfLayoutTextItem[] =>
    Array.from({ length: count }, (_, offset) => {
      const n = start + offset + (gap && start > 1 && offset >= 2 ? 1 : 0)
      const y = top - offset * 29.04
      return [
        item(n + '.', x, y, n < 10 ? 6 : 9.8, 8, 'reference', false),
        item('A.', x + (n < 10 ? 7 : 10.6), y, 5, 8, 'reference', false),
        item(
          'Reader, "An instrument for the collection of signals',
          x + 20,
          y,
          226,
          8,
          'reference'
        ),
        item(
          'under stable conditions," Journal of Measurements 10(2),',
          x,
          y - 9.68,
          225,
          8,
          'reference'
        ),
        item('125-141 (2023).', x, y - 19.36, 56, 8, 'reference')
      ]
    }).flat()
  const { units } = groupPdfTranslationPages({
    pageCount: 1,
    pages: [
      {
        page: 1,
        width: 612,
        height: 792,
        rotation: 0,
        items: [
          item(
            'The experiment used independent instruments and the same protocol.',
            50,
            732,
            245,
            10,
            'body'
          ),
          item(
            'Each observation was recorded and compared with the control group.',
            50,
            720,
            245,
            10,
            'body'
          ),
          item(
            'Our analysis of recorded samples produced the following result.',
            50,
            459,
            245,
            10,
            'body'
          ),
          item('REFERENCES', 50, 408, 59, 11, 'heading'),
          ...references(1, 12, 50, 396),
          ...references(13, 17, 317, 730)
        ]
      }
    ]
  })
  const records = units.filter((unit) => /^\d+\. A\. Reader/u.test(unit.source))
  assert.equal(records.length, 29)
  assert.equal(records.filter((unit) => !unit.sourceOnly).length, gap ? 11 : 0)
  assert.equal(units.find((unit) => unit.source.startsWith('Our analysis'))?.sourceOnly, undefined)
})

it('detaches a terminal references heading from the preceding availability paragraph', () => {
  const parse = (skip: boolean): PdfTranslationLayout['units'] =>
    groupPdfTranslationPages({
      pageCount: 1,
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items: endMatter(skip) }]
    }).units
  const units = parse(false)
  const body = units.find((u) => u.source.startsWith('Data availability.'))
  assert.ok(body)
  assert.doesNotMatch(body.source, /REFERENCES/u)
  assert.equal(Boolean(body.sourceOnly), false)
  assert.equal(units.find((u) => u.source === 'REFERENCES')?.preserve, 'reference')
  const references = units.filter((u) => /^\d+\. A\. Writer/u.test(u.source))
  assert.equal(references.length, 7)
  assert.ok(references.every((u) => u.sourceOnly && u.preserve === 'reference'))
  const missing = parse(true).find((u) => u.source.startsWith('Data availability.'))
  assert.ok(missing)
  assert.match(missing.source, /REFERENCES$/u)
})
