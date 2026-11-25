import { expect, it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from '../../src/reader/layout.js'

function inlineIntegralPage(operatorAscent: number): PdfLayoutPage {
  const run = (
    str: string,
    x: number,
    width: number,
    y: number,
    fontName = 'roman',
    height = 12,
    hasEOL = false
  ): PdfLayoutTextItem => ({
    str,
    width,
    height: str.trim() ? height : 0,
    dir: 'ltr',
    fontName,
    fontAscent: fontName === 'extension' ? operatorAscent : 0.7,
    fontDescent: fontName === 'extension' ? -0.6 : -0.2,
    fontVertical: false,
    transform: [height, 0, 0, height, x, y],
    hasEOL
  })
  return {
    page: 1,
    width: 596,
    height: 842,
    rotation: 0,
    items: [
      run(
        'The estimate depends on the location of the interval',
        89.5,
        450.5,
        575,
        'roman',
        12,
        true
      ),
      run('and on the shape of the profile. The identity follows from', 72, 328, 560.5),
      run('q', 404.8, 5.8, 560.5, 'italic'),
      run('(', 411.8, 4.6, 560.5),
      run('z', 416.4, 6.6, 560.5, 'italic'),
      run(')', 423, 4.5, 560.5),
      run('/z', 427.5, 12.5, 560.5, 'italic'),
      run('=', 444.2, 9.1, 560.5),
      run('R', 457.4, 5.6, 570.1, 'extension'),
      run('1', 465.4, 4.2, 567, 'numeral', 8, true),
      run('0', 463, 4.2, 556.4, 'numeral', 8),
      run('q', 472, 5.8, 560.5, 'italic'),
      run('′', 479.1, 2.3, 564.8, 'symbol', 8),
      run('(', 481.9, 4.6, 560.5),
      run('sz', 486.5, 10.8, 560.5, 'italic'),
      run(')', 497.3, 4.6, 560.5),
      run('ds', 503.9, 10.3, 560.5, 'italic'),
      run('for', 518.5, 21.5, 560.5, 'roman', 12, true),
      run(
        'every point in the open interval where the derivative exists.',
        72,
        468,
        546,
        'roman',
        12,
        true
      )
    ]
  }
}

it.each([0.04, 0.7])('checks a bounded inline integral with extension-font ascent %s', (ascent) => {
  const page = inlineIntegralPage(ascent)
  const { units } = groupPdfTranslationPages({ pages: [page] })
  const formula = units.find(({ source }) => source === 'q(z)/z= ∫^1_0 q′(sz)ds')
  if (ascent === 0.7) {
    expect(formula).toBeUndefined()
    expect(
      units
        .filter(({ sourceOnly }) => !sourceOnly)
        .map(({ source }) => source)
        .join(' ')
    ).toContain('intervalR 1')
    return
  }
  expect(formula).toMatchObject({
    sourceOnly: true,
    preserve: 'formula',
    items: Array.from({ length: 15 }, (_, n) => `1:${n + 2}`)
  })
  expect(units.filter(({ sourceOnly }) => !sourceOnly).map(({ source }) => source)).toEqual([
    'The estimate depends on the location of the interval and on the shape of the profile. The identity follows from',
    'for every point in the open interval where the derivative exists.'
  ])
  expect(units.flatMap(({ items }) => items).sort()).toEqual(
    page.items.map((_, index) => `1:${index}`).sort()
  )
})
