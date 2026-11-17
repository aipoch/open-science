import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([
  'publication link',
  'legacy publication link',
  'unrelated link',
  'body-size text'
] as const)('keeps an inline publication notice at its native position with %s', (condition) => {
  const item = (
    str: string,
    x: number,
    baseline: number,
    width: number,
    height: number,
    fontName: string,
    hasEOL = true
  ): PdfLayoutTextItem => ({
    str,
    width,
    height,
    dir: 'ltr',
    fontName,
    hasEOL,
    fontVertical: false,
    transform: [height, 0, 0, height, x, baseline]
  })
  const notice = '© 2022 Example Research Press'
  const items = [
    item('We tested the instrument against independent samples and', 50, 520, 230, 10, 'Body'),
    item('measured a repeatable change over the observation interval.', 50, 508, 230, 10, 'Body'),
    item('The measurements improved.', 50, 496, 97, 10, 'Body', false),
    item(notice, 154, 496, 110, condition === 'body-size text' ? 10 : 7.5, 'Imprint'),
    item(
      condition === 'unrelated link'
        ? 'https://example.org/study'
        : condition === 'legacy publication link'
          ? 'http://dx.doi.org/10.1000/example'
          : 'https://doi.org/10.1000/example',
      50,
      477,
      115,
      8.5,
      'Imprint'
    )
  ]
  const units = groupPdfTranslationPages({
    pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }]
  }).units
  const owner = units.find((unit) => unit.items.includes('1:3'))
  if (condition === 'publication link' || condition === 'legacy publication link') {
    expect(owner).toMatchObject({ source: notice, sourceOnly: true, items: ['1:3'] })
    expect(units.find((unit) => unit.items.includes('1:2'))).toMatchObject({
      source: expect.stringMatching(/The measurements improved\.$/u)
    })
  } else {
    expect(owner?.sourceOnly).toBeUndefined()
  }
  expect(units.flatMap((unit) => unit.items).sort()).toEqual(items.map((_, i) => '1:' + i))
})
