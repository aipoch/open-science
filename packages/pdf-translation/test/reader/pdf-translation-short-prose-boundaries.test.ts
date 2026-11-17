import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

function item(
  str: string,
  x: number,
  y: number,
  width: number,
  eol = true,
  size = 10,
  fontName = 'Body'
): PdfLayoutPage['items'][number] {
  return {
    str,
    width,
    height: size,
    dir: 'ltr',
    hasEOL: eol,
    transform: [size, 0, 0, size, x, y],
    fontName,
    fontAscent: 0.7,
    fontDescent: -0.2,
    fontVertical: false
  }
}
function page(page: number, items: PdfLayoutPage['items']): PdfLayoutPage {
  return { page, width: 612, height: 792, rotation: 0, items }
}
function passive(fault: boolean): PdfLayoutPage[] {
  return [
    page(1, [
      item('1', 557, 755, 5),
      item('The experiments were repeated to check the same trends', 317, 116, 245),
      item('under conditions where the measured signal was more stable.', 317, 104, 245),
      item(
        'Current evidence from the new method clearly demonstrates that the original estimate can',
        317,
        69,
        245,
        false
      )
    ]),
    page(2, [
      item(fault ? '9' : '2', 557, 755, 5),
      item('be substantially reduced by changing the test conditions', 54, 729, 245, false),
      item('α', 54, 718, 6, false, 10, 'Greek'),
      item('M/', 60, 718, 14, false, 10, 'Greek'),
      item('2. The rest of this section explains the tradeoffs', 74, 718, 225),
      item('considered when arranging the measurements in the new setting.', 54, 707, 245),
      item('The verification follows the same procedure as before.', 54, 696, 245)
    ])
  ]
}
function beforeAssignment(fault: boolean): PdfLayoutPage[] {
  return [
    page(1, [
      item('Begin by comparing the response curves for both models.', 72, 699, 454),
      item('The two independently measured amplitudes have the', 72, 686, 454),
      item('form', 72, 673, 21, false),
      item('', 240, 660, 0),
      item('u', 240, 660, 6, false, 10, 'MathItalic'),
      item('=', 249, 660, 8, false, 10, 'Math'),
      item('ρe', 260, 660, 10, false, 10, 'MathItalic'),
      item('ax', 270, fault ? 660 : 664, 7, false, 7.3, 'Script'),
      item(',', 278, 660, 2, false, 10, 'MathItalic'),
      item('v', 306, 660, 6, false, 10, 'MathItalic'),
      item('=', 315, 660, 8, false, 10, 'Math'),
      item('σe', 326, 660, 11, false, 10, 'MathItalic'),
      item('by', 337, 664, 7, false, 7.3, 'Script'),
      item(',', 345, 660, 3, false, 10, 'MathItalic'),
      item('', 72, 646, 0),
      item('where each parameter was determined in a separate test.', 72, 646, 440)
    ])
  ]
}

it.each([false, true])(
  'uses native folios to join a passive clause across pages (%s)',
  (wrongFolio) => {
    const { units } = groupPdfTranslationPages({ pages: passive(wrongFolio) })
    const head = units.find((unit) => unit.items.includes('1:3'))!
    const tail = units.find((unit) => unit.items.includes('2:1'))!
    expect(head === tail).toBe(!wrongFolio)
    expect(head.fragments.map((fragment) => fragment.page)).toEqual(wrongFolio ? [1] : [1, 2])
    expect(units.find((unit) => unit.items.includes('2:2'))?.sourceOnly).toBe(true)
  }
)
it.each([false, true])(
  'joins a prose tail before two assignments with raised scripts (%s)',
  (flatScript) => {
    const { units } = groupPdfTranslationPages({ pages: beforeAssignment(flatScript) })
    const head = units.find((unit) => unit.items.includes('1:1'))!
    const tail = units.find((unit) => unit.items.includes('1:2'))!
    expect(head === tail).toBe(!flatScript)
    expect(head.source.endsWith('have the form')).toBe(!flatScript)
    expect(head.items).not.toContain('1:4')
    expect(units.find((unit) => unit.items.includes('1:4'))?.source).toContain('ρe')
  }
)

it.each(['front-matter', 'numbered', 'misaligned'] as const)(
  'requires matching native heading lanes in parallel columns (%s)',
  (kind) => {
    const capped = (str: string, x: number, y: number, number?: number): PdfLayoutPage['items'] => [
      ...(number ? [item(String(number), x + 0.2, y, 5, false, 10, 'SmallCaps')] : []),
      item(str[0], x + (number ? 15 : 0.2), y, 7, false, 10, 'SmallCaps'),
      item(str.slice(1), x + (number ? 22 : 7.2), y, 37, false, 8, 'SmallCaps'),
      item('', x, y, 0)
    ]
    const paired = kind !== 'numbered',
      left = paired ? 'ABSTRACT' : 'SAMPLING',
      right = paired ? 'INTRODUCTION' : 'MEASUREMENT',
      rightY = kind === 'misaligned' ? 595 : 600,
      documentPage = page(paired ? 1 : 2, [
        ...capped(left, 54, 600, paired ? undefined : 2),
        item('The lower chamber was tested over a range of conditions', 54, 585, 241),
        item('and the observations were recorded separately.', 54, 574, 220),
        item('These recordings provide a baseline for later tests.', 54, 563, 234),
        ...capped(right, 318, rightY, paired ? 1 : 3),
        item(
          'Every instrument was calibrated before the sample was collected',
          318,
          rightY - 15,
          240
        ),
        item('and the results were checked against the reference.', 318, rightY - 26, 228),
        item('Additional measurements were used to verify the result.', 318, rightY - 37, 238),
        ...(kind === 'numbered'
          ? [
              ...capped('ACKNOWLEDGMENTS', 318, 540),
              item('The authors thank the reviewers for their detailed feedback.', 318, 525, 246),
              item('We appreciate the assistance with sample preparation.', 318, 514, 244)
            ]
          : [])
      ])
    const { units } = groupPdfTranslationPages({ pages: [documentPage] })
    const sources = units.map((unit) => unit.source)
    expect(sources.includes(paired ? left : '2 ' + left)).toBe(kind !== 'misaligned')
    expect(sources.includes((paired ? '1 ' : '3 ') + right)).toBe(kind !== 'misaligned')
    if (kind === 'numbered') expect(sources).toContain('ACKNOWLEDGMENTS')
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      documentPage.items
        .flatMap((part, index) => (part.str.trim() ? [`${documentPage.page}:${index}`] : []))
        .sort()
    )
  }
)
