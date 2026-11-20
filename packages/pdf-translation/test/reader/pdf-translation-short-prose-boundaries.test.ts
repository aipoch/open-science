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

it.each(['aligned', 'wrong folio', 'new subject', 'intervening label'] as const)(
  'joins a full-width dash clause through consecutive alternating native folios: %s',
  (variant) => {
    const start = 'The independent forecasts agree with the earlier reference estimate.'
    const lead =
      variant === 'new subject'
        ? '— The resulting scatter exceeds a threshold. In the following trial, '
        : '— indicate substantially different causes of variation. In the following trial, '
    const { units } = groupPdfTranslationPages({
      pages: [
        page(1, [
          item('1', 51, 740, 5),
          item(start, 60, 144, 502),
          item(
            'Each series separates the stable region from the variable region under the same reference conditions.',
            51,
            131.5,
            511
          ),
          item(
            'The first region contains a small subset of observations where the control and sample measures',
            51,
            119,
            511
          ),
          item(
            'converge, and the second region spans the whole range of tested settings.',
            51,
            106.5,
            511
          ),
          item('Deviations of 4–6', 51, 94, 97, false),
          item(
            'within the latter region — well above the expected uncertainty (R. Reader et al. 1990)',
            150,
            94,
            412,
            false
          )
        ]),
        page(2, [
          item(variant === 'wrong folio' ? '9' : '2', 557, 740, 5),
          ...(variant === 'intervening label' ? [item('Run A', 51, 725, 23)] : []),
          item(lead, 51, 717.5, 340, false),
          item(
            'the sample was adjusted to use the same reference standard as before',
            391,
            717.5,
            171
          ),
          item('and the results were compared with independent estimates.', 51, 705, 292),
          item(
            'The next paragraph explains how the measurements were gathered after each adjustment.',
            60,
            692.5,
            502
          ),
          item('Three other settings were also tested to verify these observations.', 51, 680, 350)
        ])
      ]
    })
    const outgoing = units.find((unit) => unit.source.includes('expected uncertainty'))!
    const incoming = units.find((unit) => unit.source.includes(lead.trim()))!
    expect(outgoing).toBeDefined()
    expect(incoming).toBeDefined()
    expect(outgoing === incoming).toBe(variant === 'aligned')
    expect(outgoing.fragments.map(({ page }) => page)).toEqual(variant === 'aligned' ? [1, 2] : [1])
    expect(outgoing.source).not.toContain('The next paragraph')
  }
)

it.each([true, false])('joins the wrapped object of an equation comparison: %s', (aligned) => {
  const layout = groupPdfTranslationPages({
    pageCount: 1,
    pages: [
      page(1, [
        item('□', aligned ? 477.5 : 472, 158, 7.75, false, 10, 'Symbol'),
        item('Equation', 138.6, 133, 40, false),
        item('(2)', 182.1, 133, 12.7, false),
        item('refutes [', 198.1, 133, 46.2, false),
        item('AB', 244.4, 133, 23.7, false),
        item('18', 274.6, 133, 10, false),
        item(', Proposition 3.1], while', 284.6, 133, 109.7, false),
        item('(3)', 397.6, 133, 12.7, false),
        item('and', 413.6, 133, 16.2, false),
        item('(4)', 433.2, 133, 12.7, false),
        item('refute', 449.2, 133, 36.1),
        item('the auxiliary stability claim in the final section.', 126.7, 121, 245, false)
      ])
    ]
  })
  const subject = layout.units.find((unit) => unit.source === 'Equation (2)')
  expect(subject).toMatchObject({ sourceOnly: true, preserve: 'formula' })
  const predicate = layout.units.find((unit) => unit.items.includes('1:3'))
  expect(predicate?.fragments).toHaveLength(aligned ? 2 : 1)
  expect(predicate?.items.includes('1:11')).toBe(aligned)
  expect(predicate?.source.endsWith('the auxiliary stability claim in the final section.')).toBe(
    aligned
  )
})

it.each([false, true])(
  'rejoins a wrapped speed range with native raised units (%s)',
  (flatExponent) => {
    const upper = 93.181 + (flatExponent ? 0 : 3.615)
    const { units } = groupPdfTranslationPages({
      pageCount: 3,
      pages: [
        page(1, [item('59', 23.53, 75.03, 5.293, false, 4.9813, 'Gutter')]),
        page(2, [
          item('10', 50.74, 105.634, 9.963, false, 9.9626),
          item('7', 80.116, 109.25, 3.972, false, 6.9738, 'Script'),
          item(
            'and test lengths across all trials, the measured velocities are of order 25–',
            105.534,
            105.634,
            456.409,
            false,
            9.9626
          ),
          item('62', 23.53, 105.634, 5.293, false, 4.9813, 'Gutter'),
          item('', 0, 0, 0),
          item('120 km s', 50.74, 93.181, 35.751, false, 9.9626),
          item('−', 86.495, upper, 6.227, false, 6.9738, 'Symbol'),
          item('1', 92.722, upper, 3.972, false, 6.9738, 'Script'),
          item('. The corresponding response times,', 97.191, 93.181, 185.69, false, 9.9626),
          item('t', 286.089, 93.181, 3.597, false, 9.9626, 'Math'),
          item('ref', 289.684, 91.686, 12.987, false, 6.9738, 'Script'),
          item('∼', 305.936, 93.181, 7.749, false, 9.9626, 'Symbol'),
          item('z', 320.329, 93.181, 4.495, false, 9.9626, 'Math'),
          item('/PQ', 329.567, 93.181, 22.48, false, 9.9626, 'Math'),
          item('1', 357.007, 96.796, 3.972, false, 6.9738, 'Script'),
          item('2', 365.06, 96.796, 3.972, false, 6.9738, 'Script'),
          item(', range from approximately 0', 369.53, 93.181, 126.812, false, 9.9626),
          item('06 to 1', 499.11, 93.181, 30.146, false, 9.9626),
          item('64 Myr', 532.023, 93.181, 29.92, false, 9.9626)
        ]),
        page(3, [
          item(
            'acquiring data under repeatable conditions supports a direct comparison between the trials.',
            50.74,
            655.174,
            427.757,
            false,
            9.9626
          )
        ])
      ]
    })
    const head = units.find((unit) => unit.source.includes('measured velocities'))!
    expect(head.source.endsWith('25–120 km s−1')).toBe(!flatExponent)
    if (!flatExponent) {
      expect(head.fragments.map(({ page }) => page)).toEqual([2, 2])
      expect(head.items.slice(-3)).toEqual(['2:5', '2:6', '2:7'])
      expect(head.items).not.toContain('2:3')
      expect(head.items).not.toContain('2:8')
    }
  }
)

it.each([false, true])(
  'repairs a wrapped word and final line within a lettered list (%s)',
  (misaligned) => {
    const { units } = groupPdfTranslationPages({
      pageCount: 1,
      pages: [
        page(1, [
          item('4.4.', 72, 409, 17, false, 11),
          item(' ', 89, 409, 5, false, 0),
          item('Measured improvements.', 94, 409, 119, false, 11, 'Emphasis'),
          item(' ', 213, 409, 5, false, 0),
          item(
            'The same calibration procedure was used for both readings',
            218,
            409,
            322,
            true,
            11
          ),
          item('and checked against a set of independent observations.', 72, 396, 269, true, 11),
          item(
            '(a) The original filter removes many irrelevant records without a second scan.',
            89,
            378,
            423,
            true,
            11
          ),
          item(
            '(b) Only cases near the boundary need comparison; the standard procedure cali-',
            89,
            365,
            451,
            true,
            11
          ),
          item('brates: up to 18', 108, 352, 72, false, 11),
          item('×', 180, 352, 8.5, false, 11, 'Symbol'),
          item('.', 188.5, 352, 3, true, 11),
          item('(c) An additional pass was faster: about 2', 90, 339, 241, false, 11),
          item('×', 331, 339, 8.5, false, 11, 'Symbol'),
          item('.', 339.5, 339, 3, true, 11),
          item('(d) Filtering the original set of records', 89, 326, 160, false, 11),
          item(' ', 249, 326, 4, false, 0),
          item('σ', 253, 326, 6.5, false, 11, 'Symbol'),
          item('-flagged units: 2', 260, 326, 77, false, 11),
          item(',', 337, 326, 3, false, 11, 'Symbol'),
          item('351 observations became 76 at the new', 340, 326, 200, true, 11),
          item('position.', misaligned ? 113 : 108, 313, 41, true, 11),
          item(
            '(e) The independent measurements agreed with the reference values.',
            90,
            300,
            320,
            true,
            11
          )
        ])
      ]
    })
    const list = units.find((unit) => unit.items.includes('1:7'))!
    expect(list.items.includes('1:8')).toBe(!misaligned)
    expect(list.items.includes('1:20')).toBe(!misaligned)
    expect(list.items).not.toContain('1:21')
    expect(list.source.includes('calibrates: up to 18')).toBe(!misaligned)
  }
)

it.each([false, true])(
  'keeps a wrapped subtraction with the definition it completes (%s)',
  (unrelatedTuple) => {
    const font = 10.9091
    const rows = [
      item('For', 87.8, 318.98, 16.27, false, font),
      item('ℓ', 108.21, 318.98, 4.55, false, font, 'Italic'),
      item('∈ {', 116.61, 318.98, 16.58, false, font, 'Math'),
      item('1', 133.19, 318.98, 5.56, false, font),
      item(',', 138.75, 318.98, 3.03, false, font, 'Italic'),
      item('2', 143.6, 318.98, 5.56, false, font),
      item('},', 149.16, 318.98, 7.98, false, font, 'Math'),
      item('a layer of this discrete cube', 182.38, 318.98, 139.87, false, font),
      item('is a subarray obtained by fixing', 351.34, 318.98, 189.79, true, font),
      item('3', 70.59, 305.43, 5.38, false, font),
      item('−', 78.39, 305.43, 8.49, false, font, 'Math'),
      item('ℓ', 89.28, 305.43, 4.55, false, font, 'Italic'),
      item('coordinates. An (', 97.46, 305.43, 83.34, false, font),
      item('n,', 180.8, 305.43, 8.71, false, font, 'Italic'),
      item('3', 191.33, 305.43, 5.38, false, font),
      item(unrelatedTuple ? ', k' : ', ℓ', 196.71, 305.43, 9.4, false, font, 'Italic'),
      item(')-indexed cube is a discrete array', 206.11, 305.43, 216.02, false, font),
      item('of size n', 450.53, 305.43, 68.69, false, font),
      item('in', 532.16, 305.43, 8.97, true, font),
      item('which each row defines a measurement.', 70.47, 291.88, 115.79, false, font)
    ]
    const { units } = groupPdfTranslationPages({ pages: [page(1, rows)] })
    const head = units.find((unit) => unit.items.includes('1:0'))!
    const operand = units.find((unit) => unit.items.includes('1:10'))!
    const tail = units.find((unit) => unit.items.includes('1:12'))!
    expect(head === operand && head === tail).toBe(!unrelatedTuple)
    expect(operand.sourceOnly).toBe(unrelatedTuple ? true : undefined)
    expect(head.source.includes('fixing 3 − ℓ coordinates.')).toBe(!unrelatedTuple)
  }
)

it.each([false, true])('keeps the wrapped object of a section preview together (%s)', (shifted) => {
  const h = 11.96
  const y = 655.16
  const rows = [
    item('The estimate fails since 7', 89.56, y, 211.16, false, h),
    item('<', 304.04, y, 9.11, false, h, 'Math'),
    item('22', 317.66, y + 4.71, 8.47, true, 7.97, 'Script'),
    item('3', 319.78, y - 4.12, 4.23, false, 7.97, 'Script'),
    item('= 11', 330.65, y, 24.14, false, h),
    item('\u0000', 356.77, y + 9.68, 5.48, false, h, 'Fence'),
    item('2', 363.44, y + 4.71, 4.23, true, 7.97, 'Script'),
    item('3', 363.44, y - 4.12, 4.23, false, 7.97, 'Script'),
    item('\u0001', 368.87, y + 9.68, 5.48, false, h, 'Fence'),
    item('. In the following section, we discuss', 374.35, y, 165.65, true, h),
    item(
      'the procedure, verify its limits and explain the assumptions.',
      shifted ? 78 : 72,
      y - 14.45,
      396.31,
      false,
      h
    ),
    item('', 0, 0, 0),
    item('2', 72, 600.86, 9.68, false, 17.22, 'Heading'),
    item('The Verification', 101.05, 600.86, 178.05, false, 17.22, 'Heading'),
    item('', 0, 0, 0),
    item('The measured outcome follows from the computation.', 72, 573, 200, true, h)
  ]
  const { units } = groupPdfTranslationPages({ pages: [page(1, rows)] })
  const preview = units.find((unit) => unit.items.includes('1:9'))!
  expect(preview === units.find((unit) => unit.items.includes('1:10'))).toBe(!shifted)
  expect(preview.fragments).toHaveLength(shifted ? 1 : 2)
  const comparison = units.find((unit) => unit.items.includes('1:1'))
  expect(comparison).toMatchObject({ sourceOnly: true, preserve: 'formula' })
  expect(preview.items).not.toContain('1:1')
  expect(preview.items).not.toContain('1:12')
})

it.each(['aligned', 'different predicate', 'displaced prefix'] as const)(
  'keeps a conjunction and Greek variable with its adjacent/non-adjacent definition (%s)',
  (variant) => {
    const blank = (x: number, fontName = 'Body'): PdfLayoutPage['items'][number] => ({
      ...item(' ', x, 623, 4, false, 11, fontName),
      height: 0
    })
    const lead = 'is the count of errors among adjacent readings,'
    const predicate = variant === 'different predicate' ? 'warnings' : 'errors'
    const tail = 'is the count of ' + predicate + ' among non-adjacent readings.'
    const { units, pages } = groupPdfTranslationPages({
      pages: [
        page(1, [
          item('The filter uses a fixed window, and its baseline measure', 84, 640, 128, false, 11),
          item(lead, 225, 640, 301, true, 11),
          item('and', variant === 'displaced prefix' ? 80 : 84, 623, 18, false, 11),
          blank(102),
          item('σ', 106, 623, 7, false, 11, 'Greek'),
          blank(113, 'Greek'),
          item(tail + ' The resulting ratio reflects', 117, 623, 367, false, 11),
          item(
            'the differences between conditions and helps classify each series as stable.',
            84,
            606,
            442,
            true,
            11
          )
        ])
      ]
    })
    const before = units.find((unit) => unit.items.includes('1:1'))!
    const definition = units.find((unit) => unit.items.includes('1:6'))!
    expect(before.source.endsWith(lead)).toBe(true)
    expect(before.items).toEqual(['1:0', '1:1'])
    expect(definition.source.startsWith((variant === 'aligned' ? 'and σ ' : '') + tail)).toBe(true)
    expect(definition.sourceOnly).toBeUndefined()
    if (variant === 'aligned') {
      expect(definition.items).toEqual(['1:2', '1:4', '1:6', '1:7'])
      const owner = pages[0].blocks.find((block) => block.id === definition.fragments[0].id)!
      expect(owner.lines.map((line) => line.items)).toEqual([['1:2', '1:4', '1:6'], ['1:7']])
      expect(owner.lines[0].x).toBe(84)
      expect(pages[0].blocks.some((block) => block.source === 'and σ')).toBe(false)
    } else {
      expect(units.find((unit) => unit.source === 'and σ')?.preserve).toBe('formula')
      expect(definition.items).toEqual(['1:6', '1:7'])
    }
  }
)

it.each([false, true])('keeps both subscript levels in a native definition (%s)', (displaced) => {
  const gap = (x: number, y: number): PdfLayoutPage['items'][number] => ({
    ...item(' ', x, y, 4, false),
    height: 0
  })
  const blank = item('', 0, 0, 0, true, 0)
  const { pages, units } = groupPdfTranslationPages({
    pages: [
      page(1, [
        item('The relation provides an independent estimate of the response.', 51, 680, 511),
        item('k = p / q', 245, 656, 52, false, 12, 'Math'),
        blank,
        item('(3)', 547, 656, 15, true, 12),
        item('where', 60, 629, 30, false, 12),
        gap(90, 629),
        item('f', 94, 629, 6, false, 12, 'Math'),
        item('ν', 100, 627.2, 4, false, 8, 'Sub'),
        item('max', 104, 626.2, 13, false, 6, 'Inner'),
        gap(117, 626.2),
        item('and', 121, 629, 19, false, 12),
        gap(140, 629),
        item('f', 144, 629, 6, false, 12, 'Math'),
        item('∆', 150, 627.2, 7, false, 8, 'Delta'),
        item('ν', 157, 627.2, 4, false, 8, 'Sub'),
        gap(161, 627.2),
        item(
          'are the correction factors for the estimate. The correction factor',
          165,
          629,
          345,
          false,
          12
        ),
        gap(510, 629),
        item('f', 514, 629, 6, false, 12, 'Math'),
        item('ν', 520, 627.2, 4, false, 8, 'Sub'),
        item('max', 524, displaced ? 625 : 626.2, 13, false, 6, 'Inner'),
        gap(537, 626.2),
        item('was', 541, 629, 21, true, 12),
        item(
          'set to a constant after accounting for the varying conditions.',
          51,
          614,
          511,
          true,
          12
        ),
        blank,
        item('3. FINDINGS', 260, 569, 92, true, 12, 'Heading')
      ])
    ]
  })
  const head = units.find((unit) => unit.items.includes('1:4'))!
  const body = units.find((unit) => unit.items.includes('1:8'))!
  expect(head === body).toBe(!displaced)
  expect(body.source.startsWith((displaced ? '' : 'where fν') + 'max and f∆ν')).toBe(true)
  expect(body.fragments).toHaveLength(1)
  const owner = pages[0].blocks.find((block) => block.id === body.fragments[0].id)!
  expect(owner.lines[0].items[0]).toBe(displaced ? '1:8' : '1:4')
  expect(units.find((unit) => unit.source === '(3)')).toMatchObject({ sourceOnly: true })
  expect(units.find((unit) => unit.source === '3. FINDINGS')?.sourceOnly).toBeUndefined()
})

it.each([false, true])('protects a split decimal beside stacked error bounds (%s)', (raised) => {
  const h = 11.9552
  const script = 7.9701
  const y = 600
  const upper = y + (raised ? 6.2 : 4.948)
  const lower = y - 2.932
  const { units } = groupPdfTranslationPages({
    pages: [
      page(1, [
        item(
          'the conditions reported for the initial experiment. They observed a mass of 2',
          50.74,
          y,
          344.6278,
          false,
          h
        ),
        item('.', 395.366, y, 3.2518, false, h, 'Math'),
        item('6', 398.617, y, 5.8533, false, h),
        item('+2', 404.47, upper, 10.821, false, script, 'Bound'),
        item('.', 415.291, upper, 2.352, false, script, 'Sub'),
        item('0', 417.643, upper, 4.2345, false, script, 'Bound'),
        item('', 0, 0, 0, true, 0),
        { ...item('−', 404.47, lower, 6.5865, false, script, 'Symbol'), fontAscent: 0.75 },
        item('0', 411.057, lower, 4.2345, false, script, 'Bound'),
        item('.', 415.291, lower, 2.352, false, script, 'Sub'),
        item('7', 417.643, lower, 4.2345, false, script, 'Bound'),
        { ...item(' ', 421.8775, lower, 2.4495, false, script, 'Bound'), height: 0 },
        item('M', 424.327, y, 10.7262, false, h),
        { ...item('⊙', 435.053, y - 1.794, 6.5865, false, script, 'Symbol'), fontAscent: 0.75 },
        item(', which is consistent with', 442.138, y, 119.8078, true, h),
        item('the other samples.', 50.74, y - 14.944, 31.9323, true, h)
      ])
    ]
  })
  const head = units.find((unit) => unit.items.includes('1:0'))!
  expect(head.source.endsWith(' mass of 2.')).toBe(true)
  expect(head.sourceOnly).toBe(raised ? undefined : true)
  expect(units.find((unit) => unit.items.includes('1:2'))).toMatchObject({
    sourceOnly: true,
    preserve: 'formula'
  })
  expect(units.find((unit) => unit.items.includes('1:14'))?.sourceOnly).toBeUndefined()
})

it.each([false, true])('keeps a wrapped bound with its proof when aligned (%s)', (displaced) => {
  const rail = displaced ? 77 : 72
  const gap = (x: number, y: number, width: number): PdfLayoutPage['items'][number] => ({
    ...item(' ', x, y, width, false, 11),
    height: 0
  })
  const following = '. Previous studies [2] established the neighboring case'
  const { units, pages } = groupPdfTranslationPages({
    pages: [
      page(1, [
        item('The remaining groups require a direct comparison.', 72, 489, 235, false, 11),
        gap(307, 489, 7),
        item('Earlier work proved finiteness for', 314, 489, 209, false, 11),
        item('', 0, 0, 0),
        item('m', rail, 476, 5, false, 11, 'MathItalic'),
        gap(rail + 5, 476, 3.5),
        item('≤', rail + 8.5, 476, 8.5, false, 11, 'Symbols'),
        gap(rail + 17, 476, 3.5),
        item('7', rail + 20.5, 476, 5.5, false, 11, 'Math'),
        item(following, rail + 26, 476, 310 - rail, false, 11),
        gap(336, 476, 4),
        item('for each test class in the family,', 340, 476, 183, true, 11),
        item('and the resulting estimate supports the final comparison.', 72, 463, 451, true, 11)
      ])
    ]
  })
  const proof = units.find((unit) => unit.items.includes('1:2'))!
  const bound = units.find((unit) => unit.items.includes('1:4'))!
  if (displaced) {
    expect(bound).toMatchObject({ source: 'm ≤ 7', sourceOnly: true, preserve: 'formula' })
    expect(proof.source.endsWith('finiteness for')).toBe(true)
  } else {
    expect(bound).toBe(proof)
    expect(proof.source).toContain('proved finiteness for m ≤ 7' + following)
    expect(proof.fragments).toHaveLength(1)
    const owner = pages[0].blocks.find((block) => block.id === proof.fragments[0].id)!
    expect(owner.items).toEqual(proof.items)
    expect(owner.lines[1].items).toEqual(['1:4', '1:6', '1:8', '1:9', '1:11'])
  }
})

it.each([false, true])('keeps a native wrapped parity condition with its lead (%s)', (shifted) => {
  const y = 650
  const condition = y - (shifted ? 23 : 22)
  const space = (x: number, y: number, width: number): PdfLayoutPage['items'][number] =>
    item(' ', x, y, width, false, 0)
  const { units, pages } = groupPdfTranslationPages({
    pages: [
      page(1, [
        item('The coefficients follow from the known expansion of the', 61, y, 234, true, 9),
        item('standard identity involving', 52, y - 11, 74, false, 9),
        space(126, y - 11, 2),
        item('cos', 128, y - 11, 12, false, 9, 'Operator'),
        item('𝑚', 140.15, y - 7.75, 4, false, 6.6, 'Power'),
        space(144.15, y - 7.75, 2.15),
        item('𝜑', 146.3, y - 11, 4, false, 9, 'Variable'),
        space(150.3, y - 11, 2.7),
        item('of the argument in the expansion – for', 153, y - 11, 142, true, 9),
        item('odd', 52, condition, 13.5, false, 9),
        space(65.5, condition, 2.3),
        item('𝑚', 67.8, condition, 4.5, false, 9, 'Variable'),
        item(',', 72.45, condition, 2.25, false, 9),
        item('', 0, 0, 0, true, 0),
        item('cos', 52, y - 45.4, 12, false, 9, 'Operator'),
        item('𝑚', 64.15, y - 41.7, 4, false, 6.6, 'Power'),
        space(68.15, y - 41.7, 2.15),
        item('𝜑', 70.3, y - 45.4, 4, false, 9, 'Variable'),
        space(74.3, y - 45.4, 3),
        item('=', 77.3, y - 45.4, 5.7, false, 9, 'Symbol'),
        item('+1', 84, y - 45.4, 8, false, 9, 'Symbol')
      ])
    ]
  })
  const prose = units.find((unit) => unit.items.includes('1:0'))!
  const tail = units.find((unit) => unit.items.includes('1:9'))!
  expect(prose === tail).toBe(!shifted)
  expect(prose.source.endsWith(shifted ? '– for' : '– for odd 𝑚,')).toBe(true)
  expect(prose.fragments).toHaveLength(1)
  const block = pages[0].blocks.find((block) => block.id === prose.fragments[0].id)!
  expect(block.lines).toHaveLength(shifted ? 2 : 3)
  expect(units.find((unit) => unit.items.includes('1:14'))).toMatchObject({
    sourceOnly: true,
    preserve: 'formula'
  })
})

it.each([false, true])('keeps an affine line with its closing brace (%s)', (differentPoint) => {
  const gap = (x: number, y: number, width: number): PdfLayoutPage['items'][number] => ({
    ...item(' ', x, y, width, false),
    height: 0
  })
  const math = (str: string, x: number, y: number, width: number): PdfLayoutPage['items'][number] =>
    item(str, x, y, width, false, 10, 'Math')
  const letter = (
    str: string,
    x: number,
    y: number,
    width: number
  ): PdfLayoutPage['items'][number] => item(str, x, y, width, false, 10, 'Italic')
  const { units, pages } = groupPdfTranslationPages({
    pages: [
      page(1, [
        item('The prior estimate agrees with the independent observations.', 312, 173, 251),
        item('The distinct markers', 322, 160, 77, false),
        gap(399, 160, 4),
        letter('m', 403, 160, 5),
        gap(408, 160, 4),
        item('and', 412, 160, 14, false),
        gap(426, 160, 3),
        letter('k', 429, 160, 4),
        gap(433, 160, 4),
        item('lie on exactly one line', 437, 160, 91, false),
        gap(528, 160, 3),
        item('{', 531, 160, 5, false, 10, 'Brace'),
        letter('m, m', 536, 160, 17),
        gap(553, 160, 2),
        math('+', 555, 160, 8),
        item('', 0, 0, 0, true, 0),
        letter('w, m', 312, 148, 17),
        gap(329, 148, 2),
        math('+ 2', 331, 148, 15),
        letter('w', 346, 148, 5),
        item('}', 352, 148, 5, false, 10, 'Brace'),
        item(', where', 357, 148, 31, false),
        gap(388, 148, 4),
        letter('w', 392, 148, 5),
        gap(397, 148, 4),
        math('=', 401, 148, 8),
        gap(409, 148, 3),
        letter('k', 412, 148, 4),
        gap(416, 148, 3),
        math('−', 419, 148, 8),
        gap(427, 148, 3),
        letter('m', 430, 148, 5),
        item(', which establishes its direction', 435, 148, 128),
        item(
          `in this setting. Its third point is m + ${differentPoint ? '3w' : '2w'} = the final point.`,
          312,
          136,
          251
        ),
        item('The two computations give the same result with either convention.', 312, 124, 251),
        item(
          'The complete line therefore remains within the space under consideration.',
          312,
          112,
          251
        )
      ])
    ]
  })
  const entry = units.find((unit) => unit.items.includes('1:1'))!
  const brace = units.find((unit) => unit.items.includes('1:20'))!
  expect(entry === brace).toBe(!differentPoint)
  if (differentPoint) {
    expect(brace).toMatchObject({ sourceOnly: true, preserve: 'formula' })
  } else {
    expect(entry.source).toContain('{m, m + w, m + 2w}, where w = k − m')
    expect(entry.fragments).toHaveLength(1)
    const block = pages[0].blocks.find((candidate) => candidate.id === entry.fragments[0].id)!
    expect(block.lines[1].items).toEqual([
      '1:16',
      '1:18',
      '1:19',
      '1:20',
      '1:21',
      '1:23',
      '1:25',
      '1:27',
      '1:29',
      '1:31',
      '1:32'
    ])
  }
})

it.each([0, 2])('keeps a wrapped coordinate denominator with its list (gap %s)', (shift) => {
  const glyph = (
    str: string,
    x: number,
    width: number,
    font = 'Body'
  ): PdfLayoutPage['items'][number] => item(str, x, 117.5, width, false, 10.9, font)
  const gap = (x: number): PdfLayoutPage['items'][number] => ({ ...glyph(' ', x, 2), height: 0 })
  const { units, pages } = groupPdfTranslationPages({
    pages: [
      page(1, [
        item('A direct calculation shows that the first three selected marks', 140, 144, 330),
        item('on the curve are given by (7', 140, 131, 118, false, 10.9),
        item(',', 258, 131, 3, false, 10.9, 'Italic'),
        item('−', 263, 131, 8, false, 10.9, 'Math'),
        item('5), (42', 271, 131, 50, false, 10.9),
        item(',', 321, 131, 3, false, 10.9, 'Italic'),
        item('91),', 326, 131, 144, true, 10.9),
        glyph('and (', 140, 26),
        glyph('−', 166, 8, 'Math'),
        glyph('11', 174, 11),
        glyph('/', 185, 5, 'Italic'),
        glyph('19', 190, 11),
        glyph(',', 201, 3, 'Italic'),
        gap(204),
        glyph('137', 206, 16),
        glyph('/', 222, 5, 'Italic'),
        glyph('128), respectively. Since the third mark', 227 + shift, 185 - shift),
        gap(412),
        glyph('is distinct', 415, 55),
        item('', 0, 0, 0, true, 0),
        item('1', 298, 79, 6)
      ])
    ]
  })
  const prose = units.find((unit) => unit.source.startsWith('A direct calculation'))!
  const fraction = units.find((unit) => unit.items.includes('1:15'))!
  expect(prose === fraction).toBe(shift === 0)
  if (shift > 0) {
    expect(fraction).toMatchObject({ sourceOnly: true, preserve: 'formula' })
  } else {
    expect(prose.source).toContain('(−11/19, 137/128), respectively.')
    expect(prose.fragments).toHaveLength(1)
    const block = pages[0].blocks.find(({ id }) => id === prose.fragments[0].id)!
    expect(block.lines.at(-1)?.items).toEqual([
      '1:7',
      '1:8',
      '1:9',
      '1:10',
      '1:11',
      '1:12',
      '1:14',
      '1:15',
      '1:16',
      '1:18'
    ])
  }
})

it.each([false, true])('keeps a wrapped inline field definition together (%s)', (broken) => {
  const glyph = (
    str: string,
    x: number,
    width: number,
    font = 'Body'
  ): PdfLayoutPage['items'][number] => item(str, x, 265, width, false, 10, font)
  const { units } = groupPdfTranslationPages({
    pages: [
      page(1, [
        {
          ...item('arXiv: rotated publication stamp', 32, 243, 357, false, 20, 'Stamp'),
          transform: [0, 20, -20, 0, 32, 243]
        },
        item('The proposed model has a single field coupled to gravity', 327, 288, 235),
        item('and its dynamics are governed by a general lagrangian', 317, 276.5, 245, false),
        item('', 0, 0, 0),
        glyph('L', 317, 7, 'Script'),
        glyph('(', 324, 4),
        glyph('ψ, Y', 328, 18, 'Italic'),
        glyph('), where', 347, 37),
        glyph('ψ', 389, 6, 'Italic'),
        glyph('is the scalar field and', broken ? 405 : 399, 98),
        glyph('Y', 502, 8, 'Italic'),
        glyph('= (', 516, 16),
        glyph('∂ψ', 532, 12, 'Italic'),
        glyph(')', 544, 4),
        item('2', 548, 268.6, 4, false, 7, 'Script'),
        glyph('/', 553, 5, 'Italic'),
        item('2', 558, 265, 4),
        item('is the standard kinetic term.', 317, 253.5, 130, false),
        item('The resulting model is', 455, 253.5, 107),
        item('described by the action', 317, 242, 100, false),
        item('', 0, 0, 0),
        item('S = J', 370, 217, 80)
      ])
    ]
  })
  const lead = units.find((unit) => unit.items.includes('1:1'))!
  const term = units.find((unit) => unit.items.includes('1:4'))!
  const rest = units.find((unit) => unit.items.includes('1:9'))!
  expect(lead === term && lead === rest).toBe(!broken)
  if (!broken) {
    expect(lead.source).toContain('L(ψ, Y), where ψ is the scalar field')
    expect(lead.fragments).toHaveLength(1)
  }
})

it.each([0, 1.3])(
  'keeps a native radical exponent and its following citation together (%s)',
  (gap) => {
    const base = 496
    const exponent = base + 4.6
    const { units, pages } = groupPdfTranslationPages({
      pages: [
        {
          ...page(1, [
            item(
              'In this setting the first construction gives a weaker comparison.',
              70,
              519,
              330,
              true,
              11
            ),
            item('An earlier account [AA10] proved that', 70, base, 175, false, 11),
            item('L', 249, base, 6, false, 11, 'Italic'),
            item('(', 255.2, base, 4.4, false, 11.4, 'Math'),
            item('q', 259.9, base, 4.8, false, 11, 'Italic'),
            item(')', 265, base, 4.4, false, 11.4, 'Math'),
            item('≥', 275, base, 8.8, false, 11.4, 'Math'),
            item('3', 289, base, 5.5, false, 11),
            item('Ω', 295, exponent, 6.6, false, 8, 'Script'),
            item('(', 301.8, exponent, 3.3, false, 8.3, 'SmallMath'),
            item('√', 305.4, exponent + 7.4, 9.5, false, 11.4, 'Math'),
            item('log', 315 + gap, exponent, 11, false, 8, 'Script'),
            item('q', 328 + gap, exponent, 3.5, false, 8, 'SmallItalic'),
            item(')', 331.8 + gap, exponent, 3.2, false, 8.3, 'SmallMath'),
            item('. Recently, a revised study [RS20]', 335.5, base, 189.5, true, 11),
            item(
              'obtained the first upper bound, and it also established a useful comparison.',
              70,
              base - 13.6,
              455,
              true,
              11
            ),
            item(
              'A separate argument improves this estimate in a concrete class of cases.',
              70,
              base - 27.2,
              380,
              true,
              11
            )
          ]),
          width: 595.28,
          height: 841.89
        }
      ]
    })
    const head = units.find((unit) => unit.items.includes('1:1'))!
    const root = units.find((unit) => unit.items.includes('1:10'))!
    const citation = units.find((unit) => unit.items.includes('1:14'))!
    if (gap > 0) {
      expect(root).toMatchObject({ sourceOnly: true, preserve: 'formula' })
      expect(head).not.toBe(citation)
    } else {
      expect(root).toBe(head)
      expect(citation).toBe(head)
      expect(head.source).toContain('3Ω(√log q). Recently, a revised study [RS20] obtained')
      expect(
        pages[0].blocks.find(({ id }) => id === head.fragments[0].id)?.lines[0].items
      ).toContain('1:10')
    }
  }
)

it.each([false, true])('keeps the native subject in a wrapped graph definition (%s)', (shifted) => {
  const x = shifted ? 77 : 75
  const y = 632
  const gap = (x: number, y: number, width: number): PdfLayoutPage['items'][number] =>
    item(' ', x, y, width, false, 0)
  const { units, pages } = groupPdfTranslationPages({
    pages: [
      page(1, [
        item(
          'A graph is factor-critical if G − v has a 1-factor for every v ∈ V (G).',
          75,
          680,
          453,
          true,
          12
        ),
        item(
          'This property provides an elementary criterion for the decomposition.',
          75,
          664,
          453,
          true,
          12
        ),
        item('We also use a related definition. We call a graph', 75, 648, 244, false, 12),
        gap(319, 648, 3),
        item('G', 322, 648, 9, false, 12, 'Italic'),
        gap(331, 648, 4),
        item('near-factor-critical', 335, 648, 180, false, 12),
        gap(515, 648, 6),
        item('if', 521, 648, 7, false, 12),
        item('', 0, 0, 0, true, 0),
        item('G', x, y, 9, false, 12, 'Italic'),
        gap(x + 9, y, 2.65),
        item('−', x + 11.65, y, 9.3, false, 12, 'Symbol'),
        gap(x + 20.95, y, 2.7),
        item('v', x + 23.65, y, 5.7, false, 12, 'Italic'),
        gap(x + 29.35, y, 4.3),
        item('has a near-factor for every', x + 33.65, y, 135, false, 12),
        gap(x + 168.65, y, 3.8),
        item(
          'v ∈ V (G). A near-factor-critical graph G is necessarily',
          x + 172.45,
          y,
          528 - x - 172.45,
          true,
          12
        ),
        item('of even order.', 75, 616, 70, true, 12),
        item(
          'The decomposition follows directly from the conditions just stated.',
          84,
          592,
          444,
          true,
          12
        )
      ])
    ]
  })
  const lead = units.find((unit) => unit.items.includes('1:8'))!
  const subject = units.find((unit) => unit.items.includes('1:10'))!
  expect(lead === subject).toBe(!shifted)
  if (shifted) {
    expect(subject.preserve).toBe('formula')
  } else {
    expect(lead.source).toContain('near-factor-critical if G − v has a near-factor')
    expect(lead.fragments).toHaveLength(1)
    const body = pages[0].blocks.find((block) => block.id === lead.fragments[0].id)!
    expect(body.lines[3].items).toEqual(['1:10', '1:12', '1:14', '1:16', '1:18'])
  }
})

it.each([false, true])(
  'keeps adjacent band widths and native angular decimals together (%s)',
  (shifted) => {
    const gap = (x: number, y: number, width: number): PdfLayoutPage['items'][number] =>
      item(' ', x, y, width, false, 0)
    const empty = (): PdfLayoutPage['items'][number] => item('', 0, 0, 0)
    const { units } = groupPdfTranslationPages({
      pages: [
        page(1, [
          item('DATA AND METHODS', 232, 178.96, 158),
          item(
            'We recorded the reference images for targets across several survey epochs and calibrated the exposures',
            59.74,
            162.52,
            502.2
          ),
          item(
            'using archival reference data. The positions were recorded and the detector calibration was checked against',
            50.74,
            150.07,
            511.2
          ),
          item(
            'the same field on repeated nights. The fluxes from the reference frames were averaged for each observing epoch,',
            50.74,
            137.62,
            511.2,
            false
          ),
          empty(),
          item('Corresponding author: A. Example', 50.61, 93.28, 156, true, 8, 'Foot'),
          item('author@example.org', 50.51, 81.77, 100, false, 8, 'Foot'),
          empty(),
          {
            ...item('arXiv: rotated publication stamp', 32, 202, 396, false, 20, 'Stamp'),
            transform: [0, 20, -20, 0, 32, 202]
          }
        ]),
        page(2, [
          item('2', 50.74, 740.382, 4.98),
          item('yielding mean values and corresponding errors.', 50.74, 717.44, 209.33, false),
          gap(260.07, 717.44, 7.14),
          item('The separation inferred from the reference positions', 267.21, 717.44, 294.74),
          item('amounts to 3', 50.74, 704.99, 170.96, false),
          item('.', 221.7, 704.99, 2.77, false, 10, 'Symbol'),
          item('′′', 221.15, 708.6, 4.59, false, 7, 'Prime'),
          item(
            '25. For comparison, the full widths at half-max of the A1 (2.8',
            226.24,
            704.99,
            277.5,
            false
          ),
          gap(503.74, 704.99, 1.66),
          item('μ', 505.4, 704.99, 6.01, false, 10, 'Symbol'),
          item('m) and A2', 511.41, 704.99, 50.53),
          item('(3.8', 50.74, 692.53, 16.61, false),
          gap(67.35, 692.53, 1.65),
          item('μ', 69.005, 692.53, 6.003, false, 10, 'Symbol'),
          item('m) images amount to 7', 75.008, 692.53, 101.623, false),
          item('.', 176.627, 692.53, 2.768, false, 10, 'Symbol'),
          item('′′', 176.074 + (shifted ? 3 : 0), 696.149, 4.594, false, 7, 'Prime'),
          item('5 for the archive and 6', 181.166, 692.53, 96.195, false),
          item('′′', 277.361, 696.149, 4.594, false, 7, 'Prime'),
          gap(281.955, 696.149, 3.819),
          item('for the reference survey.', 285.774, 692.53, 149.161),
          item(
            'The apparent distance is inversely proportional to the measured brightness.',
            59.74,
            680.08,
            435.3,
            false
          ),
          gap(495.04, 680.08, 7.19),
          item('To derive flux,', 502.23, 680.08, 59.71),
          item(
            'the measured signal was weighted using the independent reference observations.',
            50.74,
            667.63,
            511.2
          ),
          item(
            'The distance between the objects remains constant during the observation.',
            50.74,
            655.17,
            333.17
          ),
          item(
            'For comparison, we also checked the independent survey for these same reference targets.',
            59.74,
            642.72,
            502.2
          ),
          item(
            'The new images confirm the observed trend for several different epochs.',
            50.74,
            630.27,
            300
          )
        ])
      ]
    })
    const comparison = units.find((unit) => unit.items.includes('2:7'))!
    const body = units.find((unit) => unit.items.includes('2:21'))!
    if (shifted) {
      expect(comparison.source).toContain('3′′. 25')
      expect(body.source).toMatch(/^m\) images/)
      expect(units.find((unit) => unit.items.includes('2:11'))?.sourceOnly).toBe(true)
    } else {
      expect(comparison.source).toContain('3.25′′')
      expect(comparison.source).toContain('and A2 (3.8 μm) images amount to 7.5′′')
      expect(comparison.fragments.map((fragment) => fragment.page)).toEqual([1, 2])
      expect(body.source).toMatch(/^The apparent distance/)
      expect(comparison.items).not.toContain('2:21')
    }
  }
)

it.each([true, false])('keeps a wrapped award number with its acknowledgment (%s)', (aligned) => {
  const { units } = groupPdfTranslationPages({
    pages: [
      page(1, [
        item(
          'We thank the institute for support while carrying out the experiments.',
          60,
          250,
          492
        ),
        item(
          'The calibration was performed through a shared programme (grant ZX-08-QRP-02-',
          60,
          239,
          492
        ),
        item('07).', aligned ? 60 : 75, 228, 20, false)
      ])
    ]
  })
  const award = units.find((unit) => unit.source.includes('shared programme'))!
  expect(award.items.includes('1:2')).toBe(aligned)
  expect(award.source.endsWith(aligned ? 'ZX-08-QRP-02-07).' : 'ZX-08-QRP-02-')).toBe(true)
  expect(award.fragments).toHaveLength(1)
})

it.each([true, false])('keeps a numerical aperture on its native body wrap (%s)', (aligned) => {
  const { units } = groupPdfTranslationPages({
    pages: [
      page(1, [
        item(
          'The field is followed along the intended path to recover the complete generating',
          70,
          265,
          460
        ),
        item('(Fourier) phase profile', 70, 253, 100, false),
        item(')', 200, 253, 4, false, 10.08, 'Operator'),
        item('y', 190, 253, 5, false, 10.08, 'Math'),
        item('\uf046', 174, 253, 8, false, 10.08, 'Symbol'),
        item('associated with a target trajectory', 206, 253, 154, false),
        { ...item('ب(ز)', 367, 253, 13, false, 10, 'Equation'), dir: 'rtl' },
        item('in the focus of a large numerical', 383, 253, 147),
        item(
          'aperture microscope objective (MO) acting as a Fourier transform lens. We use the adjusted focus',
          aligned ? 70 : 75,
          238,
          460
        ),
        item('to record the measured field across the specimen. The procedure is', 70, 226, 460),
        item('specified as follows:', 70, 214, 245, false)
      ])
    ]
  })
  const lead = units.find((unit) => unit.items.includes('1:7'))!
  expect(lead.items.includes('1:8')).toBe(aligned)
  expect(lead.fragments).toHaveLength(aligned ? 2 : 1)
  expect(lead.source.includes('large numerical aperture')).toBe(aligned)
})

it.each([false, true])('keeps a denominator on its native condition row (%s)', (shifted) => {
  const x = shifted ? 177 : 173
  const gap = (x: number, width: number): PdfLayoutPage['items'][number] =>
    item(' ', x, 622, width, false, 0)
  const { units, pages } = groupPdfTranslationPages({
    pages: [
      page(1, [
        item('The next case yields the following definition.', 79, 644, 240, true, 11),
        item('For 0', 91, 622, 25, false, 11),
        gap(116, 3),
        item('< a, b <', 119, 622, 40, false, 11, 'Italic'),
        gap(159, 3),
        item('1', 162, 622, 5.5, false, 11),
        item('/', 167.5, 622, 5.5, false, 11, 'Italic'),
        item('2 with', x, 622, 30, false, 11),
        gap(x + 30, 4),
        item('Q', x + 34, 622, 9, false, 11, 'Symbol'),
        item('(', x + 43, 622, 4.25, false, 11),
        item('a, b', x + 47.25, 622, 16.5, false, 11, 'Italic'),
        item(')', x + 64.1, 622, 4.25, false, 11),
        gap(x + 68.35, 3),
        item('<', x + 71.35, 622, 8.5, false, 11, 'Italic'),
        gap(x + 79.85, 3),
        item('0, define', x + 82.85, 622, 40, true, 11),
        item('R = s + t.', 255, 597, 48, true, 11, 'Italic')
      ])
    ]
  })
  const condition = units.find((unit) => unit.items.includes('1:6'))!
  const denominator = units.find((unit) => unit.items.includes('1:7'))!
  expect(condition === denominator).toBe(!shifted)
  if (!shifted) {
    expect(condition.source).toBe('For 0 < a, b < 1/2 with Q(a, b) < 0, define')
    expect(condition.fragments).toHaveLength(1)
    expect(
      pages[0].blocks.find((block) => block.id === condition.fragments[0].id)?.lines
    ).toHaveLength(1)
  }
})

it.each([true, false])(
  'keeps a centered title with its repeated named numbers (%s)',
  (matching) => {
    const first = 'CONNECTED FAMILIES OF TRIANGLES WITH COMMON VERTICES'
    const second = 'AND FOREST RAMSEY NUMBERS'
    const blank = item('', 0, 0, 0, true, 0)
    const space = (x: number, y: number, width: number): PdfLayoutPage['items'][number] =>
      item(' ', x, y, width, false, 0)
    const { units } = groupPdfTranslationPages({
      pages: [
        page(1, [
          item(first, 107, 678, 398, true, 10.91, 'Title'),
          item(second, 197, 664, 218, false, 10.91, 'Title'),
          blank,
          item('RILEY STONE', 273, 634.1, 66, false, 8.97),
          blank,
          item('Abstract.', 108, 605.5, 46, false, 8.97, 'Label'),
          space(154, 605.5, 5),
          item(
            'This note compares simple bounds for decomposing labeled graphs.',
            159,
            605.5,
            345,
            true,
            8.97
          ),
          item('We study the', 108, 594.4, 47, false, 8.97),
          space(155, 594.4, 2),
          item('r', 157, 594.4, 4.2, false, 8.97, 'Italic'),
          item(
            matching ? '-Forest Ramsey number' : '-Tree Ramsey number',
            161.2,
            594.4,
            97,
            false,
            8.97,
            'Label'
          ),
          space(258.2, 594.4, 4),
          item('under a uniform degree restriction on all edges.', 262.2, 594.4, 241.8, true, 8.97),
          blank
        ])
      ]
    })
    const title = units.find((unit) => unit.items.includes('1:0'))!
    const suffix = units.find((unit) => unit.items.includes('1:1'))!
    expect(title === suffix).toBe(matching)
    expect(title.source).toBe(matching ? first + ' ' + second : first)
    expect(title.fragments).toHaveLength(matching ? 2 : 1)
    expect(units.find((unit) => unit.items.includes('1:3'))?.source).toBe('RILEY STONE')
  }
)

it.each([true, false])(
  'keeps a compound together when the next page opens with a table (%s)',
  (repeated) => {
    const { units } = groupPdfTranslationPages({
      pages: [
        page(1, [
          item('Most values were consistent across successive test runs.', 54, 230, 242),
          item('We applied the same sampling procedure at each location.', 54, 218, 242),
          item('The sensor remained stable throughout the comparison.', 54, 206, 222),
          item('EXPERIMENTAL METHOD', 316, 116, 90, true, 12, 'Heading'),
          item('Initial measurements suggested a consistent temperature effect', 334, 90, 224),
          item('despite variation between the different sampling instruments.', 316, 78, 242),
          item('The measured current levels for low-', 316, 66, 242, false)
        ]),
        page(2, [
          item(
            'Each group of values was obtained with a separate sensor at a fixed position in the chamber.',
            54,
            725,
            500
          ),
          item(
            'The labels identify the acquisition settings, and all axes use the same absolute units.',
            54,
            713,
            500
          ),
          item('Measured frequency', 134, 635, 78, true, 8, 'Axis'),
          item(
            'Figure 1: Comparison of the two measurement bands.',
            54,
            570,
            242,
            true,
            10,
            'Caption'
          ),
          item('Table 2: Measurements at the comparison points.', 60, 292, 228, true, 9, 'Caption'),
          item('CALIBRATION GROUPS', 72, 275, 75, true, 10, 'TableLabel'),
          item('12', 72, 265, 10, false, 8),
          item('31', 144, 265, 10, false, 8),
          item('45', 228, 265, 10, true, 8),
          item('16', 72, 242, 10, false, 8),
          item('35', 144, 242, 10, false, 8),
          item('49', 228, 242, 10, true, 8),
          item('noise testing range from 38 to 76 and are summarized in', 54, 184, 242),
          item('Table 2. Equal intervals were selected for both measurements.', 54, 172, 242),
          item(
            repeated
              ? 'The low-noise condition was also used for the final assessment.'
              : 'The wide-band condition was also used for the final assessment.',
            72,
            148,
            224
          ),
          item('Figure 3: Reference measurements for the second set of tests.', 316, 605, 242),
          item('The same batch was evaluated using a separate procedure.', 316, 337, 242),
          item('Additional notes describe the boundary conditions in detail.', 316, 325, 242)
        ])
      ]
    })
    const head = units.find((unit) => unit.items.includes('1:6'))!
    const tail = units.find((unit) => unit.items.includes('2:12'))!
    expect(head === tail).toBe(repeated)
    expect(head.source.includes('low-noise testing range')).toBe(repeated)
    expect(head.fragments.map((fragment) => fragment.page)).toEqual(repeated ? [1, 2] : [1])
    expect(units.some((unit) => unit.items.includes('2:4'))).toBe(true)
  }
)

it.each([true, false])(
  'keeps a short centered title continuation when the complete wording recurs in the running header (%s)',
  (matching) => {
    const first = 'PACKING RECTANGULAR REGIONS WITH REGULAR'
    const last = 'HEXAGONS'
    const complete = first + ' ' + last
    const { units } = groupPdfTranslationPages({
      pages: [
        page(1, [
          item(first, 82, 690, 448, true, 12, 'Title'),
          item(last, 271, 676, 70, false, 12, 'Title'),
          item('', 0, 0, 0),
          item('SAGE NORTH AND ROWAN WELLS', 209, 646, 194, false, 10, 'Author'),
          item('', 0, 0, 0),
          item('Abstract.', 108, 617, 48, false, 10, 'Label'),
          item(' ', 156, 617, 3, false),
          item('We describe a new bound for finite planar packings.', 159, 617, 288)
        ]),
        page(2, [
          item(matching ? complete : first + ' OCTAGONS', 135, 741, 342, false, 9, 'Running'),
          item(' ', 477, 741, 4, false, 9, 'Running'),
          item('2', 538, 741, 5, false, 9, 'Running'),
          item('', 0, 0, 0),
          item('We now consider the effect of changing the boundary conditions.', 72, 708, 460)
        ])
      ]
    })
    const title = units.find((unit) => unit.items.includes('1:0'))!
    const ending = units.find((unit) => unit.items.includes('1:1'))!
    expect(title === ending).toBe(matching)
    expect(title.source).toBe(matching ? complete : first)
    expect(title.fragments).toHaveLength(matching ? 2 : 1)
    expect(units.find((unit) => unit.items.includes('1:3'))?.source).toBe(
      'SAGE NORTH AND ROWAN WELLS'
    )
  }
)

it.each([true, false])('keeps a raised inline sum out of the prior sentence (%s)', (extension) => {
  const earlier = 'The right sides of these bounds all have value at most 2.'
  const sign = {
    ...item('P', 146.7, 611, 12.6, false, 12, 'Sign'),
    ...(extension ? { fontAscent: 0.04, fontDescent: -0.6 } : {})
  }
  const { units } = groupPdfTranslationPages({
    pages: [
      page(1, [
        item(
          'The following estimate gives a sufficient bound for the maximum.',
          72,
          647,
          426,
          true,
          12
        ),
        item(earlier, 72, 616, 362, true, 12),
        item('Consider first', 76, 602, 68, false, 12),
        item(' ', 144, 602, 2.7, false, 12),
        sign,
        item('', 0, 0, 0),
        item('k', 159.3, 598.5, 3.4, false, 8, 'Script'),
        item(' ', 162.7, 598.5, 2.9, false, 8, 'Script'),
        item('b', 165.6, 602, 5, false, 12, 'Math'),
        item('k', 170.6, 600.2, 3.4, false, 8, 'Script'),
        item('(2', 174.9, 602, 10.4, false, 12),
        item('−', 185.6, 602, 9.3, false, 12, 'Math'),
        item('C', 195.2, 602, 9.4, false, 12, 'Math'),
        item('k', 204.6, 600.2, 3.4, false, 8, 'Script'),
        item('). This term gives the desired upper bound.', 209, 602, 288, true, 12),
        item('The second term is estimated in the same way.', 72, 588, 273, true, 12)
      ])
    ]
  })
  const sentence = units.find((unit) => unit.items.includes('1:1'))!
  const owner = units.find((unit) => unit.items.includes('1:4'))!
  if (extension) {
    expect(sentence.source.endsWith(earlier)).toBe(true)
    expect(owner !== sentence).toBe(true)
    expect(owner.source).toBe('P')
    expect(owner.sourceOnly).toBe(true)
  } else {
    expect(owner).toBe(sentence)
    expect(owner.sourceOnly).not.toBe(true)
  }
})

it.each([true, false])(
  'joins the first right-column prose above a figure across a raised footnote (%s)',
  (lifted) => {
    const { units } = groupPdfTranslationPages({
      pages: [
        page(1, [
          item('contact@example.org', 254, 490, 101, false),
          item(
            'We compared written records from several independent workshops',
            64,
            138,
            230,
            true,
            9
          ),
          item(
            'and asked participants to explain how the teams decide which tasks',
            54,
            127,
            240,
            true,
            9
          ),
          item(
            'are ready for review. The responses described the same informal',
            54,
            116,
            240,
            true,
            9
          ),
          item('agreement among groups', 54, 105, 90, false, 9),
          item(' on review criteria', 144, 105, 116, false, 9, 'Italic'),
          item('– shared', 262, 105, 32, false, 9),
          item('1', 54, lifted ? 88 : 85, 2.5, false, 5.5),
          item('Independent survey', 57, 85, 91, false, 7),
          item(
            'assumptions the teams used to evaluate whether each delivered',
            318,
            467,
            240,
            true,
            9
          ),
          item('component met the previously agreed criteria [4].', 318, 456, 181, false, 9),
          item(
            'Figure 1: Timeline of the experiment and review rounds.',
            318,
            281,
            241,
            true,
            9,
            'Caption'
          )
        ])
      ]
    })
    const head = units.find((unit) => unit.items.includes('1:6'))!
    const tail = units.find((unit) => unit.items.includes('1:9'))!
    expect(head === tail).toBe(lifted)
    expect(head.fragments).toHaveLength(lifted ? 2 : 1)
    expect(units.find((unit) => unit.items.includes('1:7'))?.source).toBe('1Independent survey')
    expect(units.find((unit) => unit.items.includes('1:11'))?.source).toBe(
      'Figure 1: Timeline of the experiment and review rounds.'
    )
  }
)

it.each([true, false])(
  'completes a centered title when its abbreviated running head matches (%s)',
  (matching) => {
    const title = 'A 12-TILING OF THE DOMAIN WITHOUT OVERLAPPING',
      ending = 'HALF-SIZE TRIANGLES'
    const { units } = groupPdfTranslationPages({
      pages: [
        page(1, [
          item(title, 91, 664, 430, true, 12, 'Title'),
          item(ending, 217, 650, 178, false, 12, 'Title'),
          item('', 0, 0, 0),
          item('SAGE NORTH AND ROWAN WELLS', 236, 620, 140, false, 10, 'Byline'),
          item('', 0, 0, 0),
          item('Abstract.', 122, 591, 51, false, 10, 'Label'),
          item(' ', 173, 591, 5, false),
          item('The construction avoids an overlapping triangle of area 2.', 178, 591, 312)
        ]),
        page(2, [
          item(
            matching ? 'A 12-TILING OF THE DOMAIN' : 'A 12-TILING OF THE SURFACE',
            230,
            719,
            152,
            false,
            9,
            'Header'
          )
        ])
      ]
    })
    const head = units.find((unit) => unit.items.includes('1:0'))!
    const tail = units.find((unit) => unit.items.includes('1:1'))!
    expect(head === tail).toBe(matching)
    expect(head.source).toBe(matching ? title + ' ' + ending : title)
    expect(head.fragments).toHaveLength(matching ? 2 : 1)
  }
)

it.each([true, false])(
  'joins a witnessed split word on the terminal row of a numbered item (%s)',
  (aligned) => {
    const { units } = groupPdfTranslationPages({
      pages: [
        page(1, [
          item('The calibration cycle uses different settings for each trial.', 54, 499, 240),
          item('Compensating for variation would affect the comparisons.', 54, 489, 240),
          item('We report these observations:', 54, 479, 105),
          item('1. We assessed the setup with the standard collection protocol', 62, 461, 232),
          item('and repeated each of the measurements during the initial', 74, 451, 220),
          item('practice period.', 74, 441, 65),
          item('2. We collected readings for a wide range of sample lengths', 62, 427, 232),
          item('and verified that the baseline interval for every trial was', 74, 417, 220),
          item('sufficient to complete the task.', 74, 407, 113),
          item('3. We checked the time required for testing varied settings', 62, 393, 232),
          item('and confirmed that the preparation cost did not increase at', 74, 383, 220),
          item('any of the selected stages of the standard testing cali-', 74, 373, 220),
          item('bration cycle.', aligned ? 74 : 80, 363, 56, false),
          item('', 0, 0, 0),
          item('2 FURTHER WORK', 54, 345, 88, false, 10, 'Heading'),
          item('The next phase examines different measurement choices.', 54, 335, 240)
        ])
      ]
    })
    const ending = units.find((unit) => unit.items.includes('1:11'))!
    const completion = units.find((unit) => unit.items.includes('1:12'))!
    expect(ending === completion).toBe(aligned)
    if (aligned) expect(ending.source).toContain('testing calibration cycle.')
    expect(units.find((unit) => unit.items.includes('1:14'))).not.toBe(ending)
  }
)

it.each([true, false])(
  'keeps indexed endpoints with a wrapped graph definition on the same text rail (%s)',
  (aligned) => {
    const left = aligned ? 72 : 77
    const { units } = groupPdfTranslationPages({
      pages: [
        page(1, [
          item(
            'The first collection uses a separate graph for each experiment.',
            72,
            650,
            468,
            true,
            11
          ),
          item('Call a pair sparse under the following condition:', 72, 636.36, 468, true, 11),
          item('min', 72, 622.72, 18, false, 11),
          item('{|', 90.1, 622.72, 8, false, 11, 'Symbol'),
          item('Y', 98.1, 622.72, 9, false, 11, 'Math'),
          item('i', 107.1, 621.07, 3, false, 8, 'Index'),
          item('|, |', 110.2, 622.72, 14, false, 11, 'Symbol'),
          item('Y', 124.2, 622.72, 9, false, 11, 'Math'),
          item('j', 133.2, 621.07, 3, false, 8, 'Index'),
          item('|} ≤ 2', 136.5, 622.72, 27, false, 11, 'Symbol'),
          item(' ', 163.5, 622.72, 0.5, false, 0),
          item(
            '. Let Q be the auxiliary graph consisting of all arcs connecting',
            164,
            622.72,
            376,
            false,
            11
          ),
          item('', 0, 0, 0),
          item('Y', left, 609.08, 9, false, 11, 'Math'),
          item('i', left + 9, 607.43, 3, false, 8, 'Index'),
          item('to', left + 16, 609.08, 10, false, 11),
          item('Y', left + 30, 609.08, 9, false, 11, 'Math'),
          item('j', left + 39, 607.43, 3, false, 8, 'Index'),
          item('for pairs', left + 46, 609.08, 41, false, 11),
          item('(i, j)', left + 91, 609.08, 24, false, 11, 'Math'),
          item('sparse for', left + 119, 609.08, 42, false, 11),
          item('Y', left + 165, 609.08, 9, false, 11, 'Math'),
          item('.', left + 174, 609.08, 3, true, 11),
          item('We use the remaining collection to estimate the rate.', 91, 595.44, 380, true, 11)
        ])
      ]
    })
    const definition = units.find((unit) => unit.items.includes('1:11'))!
    expect(units.find((unit) => unit.items.includes('1:13')) === definition).toBe(aligned)
    expect(definition.fragments).toHaveLength(aligned ? 2 : 1)
    expect(units.find((unit) => unit.items.includes('1:2'))?.preserve).toBe('formula')
    if (aligned) expect(definition.source).toContain('arcs connecting Yi to Yj')
  }
)

it.each([true, false])(
  'preserves an unfinished bound only when the folio and next-page exponent agree (%s)',
  (centeredFolio) => {
    const { units } = groupPdfTranslationPages({
      pages: [
        page(1, [
          item(
            'The independent trials provide an estimate for the remaining parameters.',
            72,
            81,
            468,
            true,
            11
          ),
          item(
            'We conclude that each collection has probability no greater than that limit',
            72,
            67.36,
            396,
            false,
            11
          ),
          item('. There are at', 468, 67.36, 72, true, 11),
          item('1', centeredFolio ? 303 : 320, 37, 6, false, 11)
        ]),
        page(2, [
          item('most', 72, 714, 23.5, false, 11),
          item(' ', 95.5, 714, 3.7, false, 0),
          item('(', 99.2, 714, 4.3, false, 11, 'Math'),
          item('ab', 103.5, 714, 11.8, false, 11, 'Math'),
          item(')', 115.3, 714, 4.3, false, 11, 'Math'),
          item('ℓ', 119.6, 718, 3.5, false, 8, 'Index'),
          item(' ', 123.1, 714, 4.1, false, 0),
          item(
            'such trials. The remaining groups can be handled by the same estimate',
            127.2,
            714,
            412.8,
            true,
            11
          ),
          item('and all estimates agree with the reference value.', 72, 700.36, 230, true, 11),
          item('2', 303, 37, 6, false, 11)
        ])
      ]
    })
    const opening = units.find((unit) => unit.items.includes('1:2'))!
    expect(opening.source).toMatch(/There are at$/u)
    expect(opening.sourceOnly === true).toBe(centeredFolio)
    expect(units.find((unit) => unit.items.includes('2:0'))).toMatchObject({
      source: 'most (ab)ℓ',
      sourceOnly: true,
      preserve: 'formula'
    })
  }
)

it.each([true, false])(
  'completes a centered title when a figure caption witnesses the styled name (%s)',
  (repeated) => {
    const { units } = groupPdfTranslationPages({
      pages: [
        page(1, [
          item(
            'Harbor’s R.T. Atlas: Comparing City Blocks through an',
            86,
            717.5,
            440,
            false,
            14.4,
            'Bold'
          ),
          item('', 0, 0, 0),
          item('Aster', 206, 699.5, 76, false, 14.4, 'BoldItalic'),
          item('-Inspired Interface', 282, 699.5, 124, false, 14.4, 'Bold'),
          item('', 0, 0, 0),
          item('Jo Rowan', 125, 677.5, 100, false, 10, 'Author'),
          item('', 0, 0, 0),
          item('Institute for Mapping', 118, 665.5, 115, false, 8, 'Author'),
          item('', 0, 0, 0),
          item('Kim Santos', 275, 677.5, 100, false, 10, 'Author'),
          item('', 0, 0, 0),
          item('Regional Research Center', 267, 665.5, 115, false, 8, 'Author'),
          item('', 0, 0, 0),
          item('Di Nasser', 412, 677.5, 80, false, 10, 'Author'),
          item('', 0, 0, 0),
          item('School of Planning', 405, 665.5, 95, false, 8, 'Author'),
          item('', 0, 0, 0),
          item(
            `Figure 1: A diagram based on ${repeated ? 'Aster' : 'Birch'} and a second rendering.`,
            78,
            474.5,
            450,
            false,
            8,
            'Author'
          ),
          item('', 0, 0, 0),
          item('The map lays out three streets relative to the square.', 54, 434, 240, true, 9),
          item('Each block is plotted with the same vertical scale.', 54, 424, 240, true, 9),
          item('The plan includes new paths and several main routes.', 54, 414, 240, false, 9)
        ])
      ]
    })
    const title = units.find((unit) => unit.items.includes('1:0'))!
    const continuation = units.find((unit) => unit.items.includes('1:2'))!
    expect(title === continuation).toBe(repeated)
    expect(title.fragments).toHaveLength(repeated ? 2 : 1)
    expect(units.find((unit) => unit.items.includes('1:5'))?.source).toBe('Jo Rowan')
  }
)
