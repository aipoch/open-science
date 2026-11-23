import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'
import { readPdfTranslationCases } from '../fixtures/read-cases.js'

const [{ page }] = readPdfTranslationCases<{ page: PdfLayoutPage }>(
  'numbered-display-noun-tail-native.jsonl'
)
const opener = 'The sampling protocol for signal q uses the following'

it('keeps the final introductory noun with prose above a numbered display', () => {
  const { units } = groupPdfTranslationPages({ pages: [page] })
  const source = units.find((unit) => unit.source.startsWith(opener))
  expect(source).toMatchObject({
    source: opener + ' equation:',
    items: ['1:1', '1:3', '1:5', '1:6'],
    originalStrings: ['The sampling protocol for signal', 'q', 'uses the following', 'equation:']
  })
  expect(source?.fragments).toHaveLength(2)
  expect(units.find((unit) => unit.source === 'q = s + t')).toMatchObject({
    preserve: 'formula',
    sourceOnly: true,
    items: ['1:8', '1:10', '1:12']
  })
  expect(units.find((unit) => unit.source === '(4)')).toMatchObject({
    preserve: 'formula',
    sourceOnly: true,
    items: ['1:13']
  })
  expect(units.flatMap((unit) => unit.items)).toEqual(
    page.items.flatMap((item, n) => (item.str.trim() ? ['1:' + n] : []))
  )
})

it.each(['different-column', 'unnumbered-display', 'different-face'])(
  'does not absorb an unproven short ending (%s)',
  (fault) => {
    const changed = structuredClone(page)
    if (fault === 'different-column') changed.items[6].transform[4] -= 40
    if (fault === 'unnumbered-display') changed.items[13].str = ''
    if (fault === 'different-face') changed.items[6].fontName = 'caption'
    const { units } = groupPdfTranslationPages({ pages: [changed] })
    expect(units.find((unit) => unit.source.startsWith(opener))?.source).toBe(opener)
  }
)

it.each([85, 77])(
  'uses the left equation number to corroborate a wrapped noun (x=%s)',
  (numberX) => {
    const head = 'This calibration run across both devices identifies the dominant high-order'
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'body',
      hasEOL = false,
      size = 11
    ): PdfLayoutPage['items'][number] => ({
      str,
      width,
      height: size,
      dir: 'ltr',
      fontName,
      fontFamily: 'serif',
      fontVertical: false,
      fontAscent: 0.8,
      fontDescent: -0.2,
      transform: [size, 0, 0, size, x, y],
      hasEOL
    })
    const { units } = groupPdfTranslationPages({
      pages: [
        {
          page: 1,
          width: 612,
          height: 792,
          rotation: 0,
          items: [
            row(head, 98, 581, 428, 'body', true),
            row('expansion', 86, 568, 47, 'body', true),
            row('(4)', numberX, 547, 16),
            row(' ', numberX + 16, 547, 188 - numberX, 'body', false, 0),
            row('Q', 204, 547, 8, 'math'),
            row('=', 215, 547, 8, 'math'),
            row('∑', 229, 557, 14, 'symbol'),
            row('x', 246, 547, 6, 'math')
          ]
        }
      ]
    })
    const joined = numberX === 85
    expect(units.find((unit) => unit.source.startsWith(head))).toMatchObject({
      source: joined ? head + ' expansion' : head,
      items: joined ? ['1:0', '1:1'] : ['1:0']
    })
    expect(units.find((unit) => unit.source === '(4)')).toMatchObject({
      items: ['1:2'],
      sourceOnly: true,
      preserve: 'formula'
    })
    expect(units.find((unit) => unit.source === 'Q =')).toMatchObject({
      items: ['1:4', '1:5'],
      sourceOnly: true,
      preserve: 'formula'
    })
  }
)

it.each(['aligned', 'shifted-number', 'missing-formula', 'unknown-word'])(
  'joins a lexically witnessed wrap before a protected display (%s)',
  (mode) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'body',
      hasEOL = false,
      sx = 9,
      size = 9
    ): PdfLayoutPage['items'][number] => ({
      str,
      width,
      height: width ? size : 0,
      dir: 'ltr',
      fontName,
      fontFamily: 'serif',
      fontVertical: false,
      fontAscent: 0.8,
      fontDescent: -0.2,
      transform: [sx, 0, 0, size, x, y],
      hasEOL
    })
    const witness = mode === 'unknown-word' ? 'samples' : 'measurements'
    const formula = mode === 'missing-formula' ? 'A matrix' : 'W(x) ∝ q'
    const items = [
      row(
        'The calibration records ' + witness + ' taken before every repeat.',
        53.8,
        224.8,
        238.7,
        'body',
        true,
        9.1
      ),
      row(
        'We adjust temporal resolution when estimating the background signal',
        41.8,
        203,
        249.2,
        'body',
        true,
        9.1
      ),
      row('at rate', 41.6, 192.1, 31.2, 'body', false, 8.9),
      row('v', 75.2, 192.1, 4.5, 'variable'),
      row(
        ', and assuming small fluctuations in local measure-',
        115.4,
        192.1,
        177.1,
        'body',
        true,
        8.9
      ),
      row('ments,', 41.8, 181.2, 21.7),
      row('', 75.3, 156.2, 0, 'variable', true),
      row(formula, 76, 156.2, 44, 'operator', false, 9.3, 9.3),
      row('(4)', mode === 'shifted-number' ? 269.5 : 281.5, 156.2, 10.5, 'number'),
      row(
        'Later observations can be compared across separate intervals.',
        41.6,
        139.6,
        249.5,
        'body',
        true,
        9.1
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const body = units.find((unit) => unit.source.includes('in local'))
    const aligned = mode === 'aligned'
    expect(body?.source).toMatch(aligned ? /local measurements,$/ : /local measure-$/)
    expect(body?.items).toEqual(
      aligned ? ['1:0', '1:1', '1:2', '1:3', '1:4', '1:5'] : ['1:0', '1:1', '1:2', '1:3', '1:4']
    )
    expect(units.some((unit) => unit.source === 'ments,')).toBe(!aligned)
    expect(units.find((unit) => unit.source === '(4)')).toMatchObject({
      items: ['1:8'],
      sourceOnly: true,
      preserve: 'formula'
    })
    if (mode !== 'missing-formula') {
      expect(units.find((unit) => unit.source === formula)).toMatchObject({
        items: ['1:7'],
        sourceOnly: true,
        preserve: 'formula'
      })
    }
  }
)

it.each(['aligned', 'shifted-number', 'unprotected-opener'])(
  'joins a detached definition noun before a native numbered assignment (%s)',
  (mode) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'body',
      hasEOL = false,
      size = 12
    ): PdfLayoutPage['items'][number] => ({
      str,
      width,
      height: size,
      dir: 'ltr',
      fontName,
      fontFamily: 'serif',
      fontVertical: false,
      fontAscent: 0.8,
      fontDescent: -0.2,
      transform: [size, 0, 0, size, x, y],
      hasEOL
    })
    const items = [
      row('For the calibrated sensor with reading', 85, 310, 193),
      row('r', 285, 310, 6, 'math'),
      row('1', 291, 308.2, 4, 'script', false, 8),
      row(', we define the', 295, 310, 226, 'body', true),
      row('function', 72, 296, 52),
      row('', 222, 274, 0, 'body', true, 0),
      row(mode === 'unprotected-opener' ? 'B(t)' : 'B(t) =', 222, 274, 37, 'math'),
      row('∑', 266, 280, 14, 'symbol'),
      row('z', 286, 274, 6, 'math'),
      row('(4)', mode === 'shifted-number' ? 488 : 507, 274, 15, 'body', true),
      row('Here the sampled values remain finite under both calibration steps.', 72, 248, 427)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const body = units.find((unit) => unit.source.startsWith('For the calibrated sensor'))
    const aligned = mode === 'aligned'
    expect(body?.source).toMatch(aligned ? /we define the function$/ : /we define the$/)
    expect(body?.items).toEqual(
      aligned ? ['1:0', '1:1', '1:2', '1:3', '1:4'] : ['1:0', '1:1', '1:2', '1:3']
    )
    expect(units.some((unit) => unit.source === 'function')).toBe(!aligned)
    if (aligned) {
      expect(units.find((unit) => unit.source === '(4)')).toMatchObject({
        items: ['1:9'],
        sourceOnly: true,
        preserve: 'formula'
      })
      expect(units.find((unit) => unit.source.startsWith('B(t) ='))).toMatchObject({
        sourceOnly: true,
        preserve: 'formula'
      })
    }
  }
)
