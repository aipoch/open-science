import assert from 'node:assert/strict'
import { it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem,
  type PdfTranslationLayout
} from '../../src/reader/layout.js'

function item(
  str: string,
  x: number,
  y: number,
  width: number,
  options: { fontName?: string; size?: number; hasEOL?: boolean } = {}
): PdfLayoutTextItem {
  const { fontName = 'body', size = 10, hasEOL = true } = options
  return {
    str,
    dir: 'ltr',
    width,
    height: size,
    transform: [size, 0, 0, size, x, y],
    fontName,
    fontAscent: 0.8,
    fontDescent: -0.2,
    fontVertical: false,
    hasEOL
  }
}

function translationUnits(items: PdfLayoutTextItem[]): PdfTranslationLayout['units'] {
  return groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
  }).units
}

it.each(['optical', 'automatic'])(
  'reattaches a terminal caption initialism with a corroborating name (%s)',
  (name) => {
    const caption = { fontName: 'caption', size: 9, hasEOL: false }
    const line = { size: 0 }
    const units = translationUnits([
      item('Fig. 1.', 310, 330, 32, caption),
      item('Overview of the procedure for testing three components.', 346, 330, 197, caption),
      item('', 310, 319.56, 0, line),
      item('Separate details appear in the written procedure below.', 310, 319.56, 232, caption),
      item('', 310, 309.12, 0, line),
      item('We monitor the output with Tilt Sensor Optical Module', 310, 309.12, 233, caption),
      item('', 310, 298.68, 0, line),
      item('(OTSM).', 310, 298.68, 34, caption),
      item('', 310, 274, 0, line),
      item(
        `The ${name} tilt sensor module records a signal each time the load changes.`,
        310,
        274,
        235
      )
    ])
    const head = units.find((unit) => unit.items.includes('1:0'))
    const close = name === 'optical'
    assert.ok(head)
    assert.equal(head.source.endsWith('Tilt Sensor Optical Module (OTSM).'), close)
    assert.equal(head.items.includes('1:7'), close)
    assert.equal(head.fragments.length, 1)
    assert.equal(head.items.includes('1:9'), false)
    assert.equal(
      units.some((unit) => unit.source === '(OTSM).'),
      !close
    )
  }
)

it.each(['mm', 'cm'])('keeps the wrapped third panel with its caption (%s)', (unit) => {
  const caption = { fontName: 'caption', size: 9, hasEOL: false }
  const line = { size: 0 }
  const units = translationUnits([
    item('Fig. 2.', 50, 330, 32, caption),
    item('Measured responses under all three probe conditions.', 86, 330, 197, caption),
    item('', 50, 319.56, 0, line),
    item('The three plots compare the calibrated measurements.', 50, 319.56, 233, caption),
    item('', 50, 309.12, 0, line),
    item('The probe displacements are', 50, 309.12, 109, caption),
    item('(a)', 162, 309.12, 10, caption),
    item('1.75mm,', 175, 309.12, 33, caption),
    item('(b)', 211, 309.12, 10, caption),
    item('2.5mm and', 224, 309.12, 59, caption),
    item('', 50, 298.68, 0, line),
    item('(c)', 50, 298.68, 10, caption),
    item(`3.25${unit}.`, 64, 298.68, 32, caption),
    item('The original probe signal, recorded before coating,', 102, 298.68, 181, caption),
    item('', 50, 288.24, 0, line),
    item('is normalized against the data from the reference run.', 50, 288.24, 232, caption),
    item('', 50, 264, 0, line),
    item('The procedure appears in the next section of the report.', 50, 264, 251)
  ])
  const head = units.find((owner) => owner.items.includes('1:0'))
  const close = unit === 'mm'
  assert.ok(head)
  assert.equal(head.source.includes('(b) 2.5mm and (c) 3.25mm. The original probe signal,'), close)
  assert.equal(head.items.includes('1:12'), close)
  assert.equal(head.fragments.length, 1)
  assert.equal(head.items.includes('1:17'), false)
  const panel = units.find((owner) => owner.source === `(c) 3.25${unit}.`)
  assert.equal(panel?.preserve, close ? undefined : 'formula')
})

it.each([0, 3])('joins a numbered heading with a hanging software-version phrase (%s)', (shift) => {
  const title = { fontName: 'heading', size: 14, hasEOL: false }
  const units = translationUnits([
    item('2', 310, 720, 7, title),
    item('Symbolic', 331, 720, 76, title),
    item('Verification', 414, 720, 130, { ...title, hasEOL: true }),
    item('with Atlas 3', 331 + shift, 702.5, 77, title),
    item('', 310, 681, 0, { size: 0 }),
    item('We repeated the independent procedure to check each example.', 310, 681, 234),
    item('The reported values appear in the following summary of results.', 310, 668, 234),
    item('This method works for every entry in the verification report.', 310, 655, 234)
  ])
  const heading = units.find((unit) => unit.source.startsWith('2 Symbolic Verification'))
  assert.equal(
    heading?.source,
    shift ? '2 Symbolic Verification' : '2 Symbolic Verification with Atlas 3'
  )
  assert.equal(heading?.items.includes('1:3'), !shift)
})

it.each([0, 4])('joins a wrapped indexed operand in a proof (%s)', (shift) => {
  const roman = { hasEOL: false }
  const variable = { ...roman, fontName: 'variable' }
  const index = { ...roman, fontName: 'index', size: 7 }
  const symbol = { ...roman, fontName: 'symbol' }
  const units = translationUnits([
    item(
      'Proof. Both first terms lie in the same component. Thus qn ≁ qn−1 and qn',
      70,
      658,
      458,
      roman
    ),
    item('∼', 532, 658, 8, symbol),
    item('', 70, 646, 0, { size: 0 }),
    item('q', 70, 646, 5, variable),
    item('1', 75, 644.5, 4, index),
    item(', q', 79.5, 646, 9.5, variable),
    item('2', 89, 644.5, 4, index),
    item(', . . . , q', 93.5, 646, 27.5, variable),
    item('n', 121, 644.5, 7, index),
    item('−', 128, 644.5, 6, { ...index, fontName: 'operator' }),
    item('2', 134, 644.5, 4, index),
    item(', and we have n ≥ 5 because', 138 + shift, 646, 156, roman),
    item('the remaining terms are independent.', 297 + shift, 646, 186),
    item('The next part of the argument examines the independent comparison.', 70, 628, 380)
  ])
  const proof = units.find((unit) => unit.items.includes('1:0'))
  assert.equal(proof?.source.includes('∼ q1, q2, . . . , qn−2, and we have'), shift === 0)
  assert.equal(proof?.items.includes('1:11'), shift === 0)
  assert.equal(proof?.items.includes('1:13'), false)
})

it.each([0, 3])('attaches a centered title identifier before the byline (shift=%s)', (shift) => {
  const draft = { size: 8, hasEOL: false }
  const title = { fontName: 'title' }
  const author = { size: 9, hasEOL: false }
  const line = item('', 0, 0, 0, { size: 0 })
  const units = translationUnits([
    item('Draft version April 5, 2025', 60, 733, 130, draft),
    line,
    item('Typeset using LATEX default style in ArticleTools', 60, 724, 141, {
      ...draft,
      fontName: 'small'
    }),
    line,
    item('Where Does the Signal Peak? Examining Weak Contributions with', 80, 676, 452, title),
    item('GridTOOLS-5b', 270 + shift, 663.5, 72, { ...title, hasEOL: false }),
    line,
    item('Ann Reader', 160, 643.5, 77, author),
    item(',', 244, 643.5, 3, author),
    item('1', 247, 647.3, 4, { ...author, size: 6 }),
    item('and Rob Writer', 255, 643.5, 136, { ...author, hasEOL: true }),
    line,
    item('1 Institute of Field Measurements', 220, 614, 172, {
      fontName: 'affiliation',
      size: 8
    }),
    item('ABSTRACT', 277, 556, 58),
    item('Our observations reveal a smooth response in the selected signal.', 85, 541, 441),
    item('The reported measurements match the independent control experiment.', 85, 529, 441)
  ])
  const headline = units.find((unit) => unit.items.includes('1:4'))
  assert.equal(headline?.source.endsWith('with GridTOOLS-5b'), shift === 0)
  assert.equal(headline?.items.includes('1:5'), shift === 0)
  assert.equal(headline?.items.includes('1:7'), false)
})

it.each([0, 4])(
  'preserves a mixed native run that closes a mathematical interval (%s)',
  (shift) => {
    const roman = { hasEOL: false }
    const math = { ...roman, fontName: 'symbol' }
    const units = translationUnits([
      item('We find that the map', 72, 475, 97, roman),
      item('ψ', 173, 475, 6, math),
      item(': [0', 183, 475, 14, roman),
      item(',', 197, 475, 3, math),
      item('1]', 202, 475, 8, roman),
      item('→', 213, 475, 10, math),
      item('', 72, 460.5, 0, { size: 0 }),
      item('[0', 72, 460.5, 8, roman),
      item(',', 80, 460.5, 3, math),
      item('∞', 85, 460.5, 10, math),
      item(') given by', 95 + shift, 460.5, 44, roman),
      item('ψ(p) = p + 1.', 245, 448.5, 65, math)
    ])
    const tail = units.find((u) => u.items.includes('1:10'))
    assert.equal(tail?.source, ') given by')
    assert.equal(tail?.sourceOnly === true, shift === 0)
    assert.equal(tail?.items.length, 1)
  }
)

it.each([true, false])(
  'keeps a repeated citation imprint and folio native (repeated=%s)',
  (same) => {
    const credit = { fontName: 'credit', size: 8, hasEOL: false }
    const code = { ...credit, fontName: 'code' }
    const pages = [1, 2, 3].map((page) => ({
      page,
      width: 595,
      height: 842,
      rotation: 0,
      items: [
        item('Several independent observations provide context for the experiment.', 150, 98, 390),
        item(
          same || page < 3 ? 'Example & Sample, (2025).' : 'Writer & Reader, (2025).',
          22,
          52,
          96,
          credit
        ),
        item('Study_Tools', 122, 52, 63, code),
        item(': A quick,', 185, 52, 30, credit),
        item('JIT', 217, 52, 13, code),
        item('-based Python tool for the supported measurements of the', 230, 52, 312, {
          ...credit,
          hasEOL: true
        }),
        item('collection of measurements.', 22, 42.5, 179, credit),
        item(String(page), 548, 52, 5, { fontName: 'folio' })
      ]
    }))
    const { units } = groupPdfTranslationPages({ pages })
    const furniture = units.filter((unit) =>
      unit.items.some((key) => Number(key.split(':')[1]) > 0)
    )
    assert.equal(furniture.length, 6)
    assert.ok(furniture.every((unit) => Boolean(unit.sourceOnly) === same))
    assert.ok(units.filter((unit) => !furniture.includes(unit)).every((unit) => !unit.sourceOnly))
  }
)

it.each([0, 3])('keeps two centered small-caps table description rows together (%s)', (shift) => {
  const normal = { size: 8, fontName: 'caption' }
  const small = { ...normal, size: 6.4 }
  const units = translationUnits([
    item('The independent results were collected in another run.', 61, 483, 243),
    item('TABLE II', 164, 460, 34, normal),
    item('C', 75, 448, 5, { ...normal, hasEOL: false }),
    item('OMPARISON OF QUALIFIED INSTRUMENTS AND', 80, 448, 207, small),
    item('SENSORS UNDER LOAD', 131 + shift, 436, 100, { ...small, hasEOL: false }),
    item('', 61, 399, 0, { size: 0 }),
    item('Each instrument was calibrated before the measurements began.', 61, 399, 246)
  ])
  const description = units.find((unit) => unit.items.includes('1:2'))
  assert.ok(description)
  assert.equal(description.source.includes('AND SENSORS UNDER LOAD'), shift === 0)
  assert.equal(description.items.includes('1:4'), shift === 0)
  assert.equal(description.items.includes('1:1'), false)
  assert.equal(description.items.includes('1:6'), false)
  assert.equal(description.fragments.length, shift ? 1 : 2)
})

it.each([0, 4])('keeps book names and editions on their native rails (%s)', (shift) => {
  const header = { size: 8, fontName: 'header', hasEOL: false }
  const author = { size: 8, fontName: 'table', hasEOL: false }
  const title = { size: 8, fontName: 'book', hasEOL: false }
  const edition = { ...author, hasEOL: true }
  const blank = { size: 0 }
  const units = translationUnits([
    item('The list gives background readings for the next exercise.', 54, 630, 245),
    item('Each example is part of the standard classroom material.', 54, 618, 245),
    item('', 69, 590, 0, blank),
    item('Authors', 69, 590, 28, header),
    item('Title', 152, 590, 16, header),
    item('Edition', 260, 590, 25, header),
    item('', 69, 576, 0, blank),
    item('M. Stone', 69, 576, 40, author),
    item('Measurements in Practice', 152, 576, 85, title),
    item('4th', 260 + shift, 576, 11, edition),
    item('A. Bell', 69, 562, 32, author),
    item('An Introduction to Signals', 152, 562, 84, title),
    item('3rd', 260 + shift, 562, 10, edition),
    item('E. Gray', 69, 548, 34, author),
    item('Methods for Calculating Rates', 152, 548, 90, title),
    item('5th', 260 + shift, 548, 10, edition),
    item('TABLE II', 162, 522, 32, edition),
    item('Selected readings from a basic course.', 100, 510, 180, edition),
    item('We use these readings when introducing the test designs.', 54, 463, 245)
  ])
  const book = units.find((unit) => unit.items.includes('1:8'))
  const number = units.find((unit) => unit.items.includes('1:9'))
  assert.ok(book && number)
  if (shift) assert.equal(book, number)
  else {
    assert.equal(book.source, 'Measurements in Practice')
    assert.equal(number.source, '4th')
  }
})

it.each([false, true])(
  'holds a mixed fraction sentence with attached scripts (shifted=%s)',
  (shifted) => {
    const y = 730
    const math = { fontName: 'math', hasEOL: false }
    const script = { fontName: 'script', size: 7, hasEOL: false }
    const number = { ...script, fontName: 'numeral' }
    const items = [
      item('2', 557, 756, 5),
      item('with', 54, y, 19, { hasEOL: false }),
      item('V', 76, y, 7.5, math),
      item('q', 84, y + (shifted ? 1.4 : 3.6), 4.3, { ...script, hasEOL: true }),
      item('r', 83.5, y - 2.6, 2.8, script),
      item('=', 92, y, 7.6, { ...math, fontName: 'relation' }),
      item('2', 103.5, y + 3.9, 4, { ...number, hasEOL: true }),
      item('3', 103.5, y - 3.4, 4, number),
      item('ε', 109, y, 4, math),
      item('rmn', 113, y - 1.5, 10.5, script),
      item('G', 124.2, y, 6.4, math),
      item('q', 132, y + 3.6, 4.3, { ...script, hasEOL: true }),
      item('mn', 130.6, y - 2.8, 7.9, script),
      item('. The selected time', 139.1, y, 81, { hasEOL: false }),
      item('t', 223, y, 5, math),
      item('remains fixed throughout', 232, y, 67),
      item('the experiment.', 54, 718, 78),
      item('The choice of this parameter reduces the error at each step.', 64, 706, 235),
      item('An independent check supplies the estimates in the other case.', 317, 710, 233)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 2, width: 612, height: 792, rotation: 0, items }],
      pageCount: 2
    })
    const owner = units.find((unit) => unit.items.includes('2:1'))
    assert.match(owner?.source ?? '', /2\/3 εrmnG qmn\. The selected time/u)
    assert.equal(owner?.sourceOnly, shifted ? undefined : true)
    assert.equal(units.find((unit) => unit.items.includes('2:17'))?.sourceOnly, undefined)
  }
)

it.each([false, true])(
  'keeps a hanging condition before its displayed clause (shifted=%s)',
  (shifted) => {
    const row = (
      str: string,
      x: number,
      y: number,
      w: number,
      fontName = 'body',
      hasEOL = true
    ): ReturnType<typeof item> => item(str, x, y, w, { fontName, hasEOL, size: 12 })
    const units = translationUnits([
      row('The prior observations independently inform our theoretical model.', 65, 586, 466),
      row('Problem 2.', 65, 538, 64, 'heading', false),
      row('Find a function', 135, 538, 85, 'italic', false),
      row('g', 225, 538, 8, 'math', false),
      row('such that every system', 238, 538, 126, 'italic', false),
      row('S', 368, 538, 8, 'math', false),
      row(' = (', 380, 538, 17, 'body', false),
      row('X, Y', 397, 538, 30, 'math', false),
      row(')', 427, 538, 4.5, 'body', false),
      row('satisfying the', 436, 538, 95, 'italic'),
      row('condition', 65, 524, 48, 'italic'),
      row('(C2) every point of', shifted ? 70 : 65, 502, 91, 'italic', false),
      row('S', 161, 502, 8, 'math', false),
      row('is selected,', 174, 502, 98, 'italic'),
      row('satisfies the required bound.', 65, 467, 147, 'italic')
    ])
    const owner = units.find((unit) => unit.items.includes('1:1'))
    assert.equal(owner?.source.endsWith('satisfying the condition'), !shifted)
    assert.equal(owner?.items.includes('1:10'), !shifted)
    assert.equal(owner?.items.includes('1:11'), false)
  }
)

function variablePredicate(offset = 0): PdfTranslationLayout['units'] {
  return translationUnits([
    item('The first observations independently predict a smooth response', 64, 445, 235),
    item('in the fitted data throughout the selected measurement range', 54, 433, 245),
    item('under the same conditions, as shown in Fig. 3. We solve', 54, 421, 245),
    item('for', 54, 409, 12, { hasEOL: false }),
    item('λ', 69, 409 + offset, 6, { fontName: 'math', hasEOL: false }),
    item('as a function of time to obtain', 79, 409, 158, { hasEOL: false }),
    item('λ(t) = 2/A', 140, 397, 58, { fontName: 'math' })
  ])
}

it('keeps a wrapped variable predicate together before its displayed equation', () => {
  const [prose, display] = variablePredicate()
  assert.match(prose.source, /We solve for λ as a function of time to obtain$/u)
  assert.deepEqual(prose.items, ['1:0', '1:1', '1:2', '1:3', '1:4', '1:5'])
  assert.equal(prose.fragments.length, 3)
  assert.equal(display.source, 'λ(t) = 2/A')
  assert.equal(display.preserve, 'formula')
  assert.equal(display.sourceOnly, true)
})

it('keeps a variable on a different baseline outside the wrapped predicate', () => {
  const units = variablePredicate(5)
  assert.ok(units.every((unit) => !(unit.items.includes('1:2') && unit.items.includes('1:4'))))
})

function wrappedWordAfterMeasurement(witness: string): PdfTranslationLayout['units'] {
  return translationUnits([
    item('1.5 K', 54, 450, 23, { hasEOL: false }),
    item('; Rose 2003). Unexpectedly, no trans-', 84, 450, 214),
    item('mission through the material within the validated range', 54, 439.5, 244),
    item('and repeated every measurement with the same settings.', 54, 429, 244),
    item('Every monitored channel was included in the comparison.', 54, 418.5, 244),
    item(`The only observed ${witness} matched the untreated control.`, 54, 386, 244)
  ])
}

it('joins a native word wrap after a short measurement', () => {
  const [joined, witness] = wrappedWordAfterMeasurement('transmission')
  assert.match(joined.source, /Unexpectedly, no transmission through/u)
  assert.deepEqual(joined.items, ['1:0', '1:1', '1:2', '1:3', '1:4'])
  assert.equal(joined.fragments.length, 2)
  assert.deepEqual(witness.items, ['1:5'])
})

it('keeps both rows separate without a witness for the joined word', () => {
  const [lead, tail] = wrappedWordAfterMeasurement('signal')
  assert.match(lead.source, /no trans-$/u)
  assert.match(tail.source, /^mission through/u)
})

function quantifiedClause(displayX = 72): PdfTranslationLayout['units'] {
  const math = { fontName: 'math', hasEOL: false },
    script = { ...math, size: 8 },
    body = { size: 12 },
    open = { ...body, hasEOL: false }
  return translationUnits([
    item('there are', 72, 322, 45.6, open),
    item('(', 122, 332, 5.5, { ...math, size: 12 }),
    item('j+1', 127.5, 328, 14.6, { ...script, hasEOL: true }),
    item('j', 132, 318, 5.2, script),
    item(')', 142.1, 332, 5.5, { ...math, size: 12 }),
    item('2', 149.3, 322, 5.9, open),
    item('j−2', 155.2, 326, 25.5, script),
    item('members in the family. This shows that the number of all subsets', 185, 322, 338, body),
    item('of [3', 72, 308, 22.4, open),
    item('m', 94.4, 308, 7, { ...math, size: 12 }),
    item('] is', 101.4, 308, 15, body),
    item('(7)', displayX, 274, 15, open),
    item('F(m) = 1', 135, 274, 61, { ...math, size: 12 })
  ])
}

it('keeps a quantified clause attached to its sentence before the display', () => {
  const units = quantifiedClause()
  const joined = units.find((unit) => unit.items.includes('1:7'))
  assert.match(joined?.source ?? '', /the number of all subsets of \[3m\] is$/u)
  assert.deepEqual(joined?.items, ['1:7', '1:8', '1:9', '1:10'])
  assert.equal(joined?.fragments.length, 2)
  assert.equal(units.find((unit) => unit.items.includes('1:11'))?.preserve, 'formula')
})

it('requires the display number on the same rail to attach the short clause', () => {
  const units = quantifiedClause(100)
  assert.ok(units.every((unit) => !(unit.items.includes('1:7') && unit.items.includes('1:8'))))
})

it.each([
  ['(3.2)', true],
  ['(3.3)', false]
])('checks the equation witness %s before joining a proof conclusion', (equation, joins) => {
  const body = { size: 11 },
    open = { ...body, hasEOL: false },
    math = { ...body, fontName: 'math' }
  const units = translationUnits([
    item('m = 2n + 1', 240, 578, 65, math),
    item(equation, 464, 578, 22, body),
    item('Every branch has an odd order and satisfies the assumed relation.', 126, 559, 360, body),
    item('Any partition into even parts must therefore be impossible.', 126, 546, 360, body),
    item('The sum of all sizes is', 126, 533, 106, open),
    item('7', 236, 533, 6, { ...math, hasEOL: false }),
    item('and hence odd. This proves Proposition 4.1', 246, 533, 240, body),
    item('for', 126, 520, 13, open),
    item('H', 143, 520, 8, { ...math, hasEOL: false }),
    item('by (3.2).', 155, 520, 40, body),
    item('6.', 197, 487, 9, open),
    item('Further estimates', 211, 487, 195, { ...body, fontName: 'heading' }),
    item('The next section considers an independent question.', 126, 468, 360, body)
  ])
  const proof = units.find((unit) => unit.source.includes('This proves Proposition'))
  assert.ok(proof)
  assert.equal(proof.source.endsWith('for H by (3.2).'), joins)
  assert.equal(proof.fragments.length, joins ? 2 : 1)
  assert.equal(units.find((unit) => unit.source === equation)?.preserve, 'formula')
  assert.equal(
    units.find((unit) => unit.source === '6. Further estimates')?.kind,
    'heading-candidate'
  )
})

const caption = 'Figure 2. Intensity profile after pulse shaping under the selected conditions.'
const lastCaptionLine = 'A measured width of 110 fs corresponds to an effective pulse duration'
const timeTail = 'of 74 fs.'

function captionWrap(
  tail: string,
  previous = lastCaptionLine,
  tailX = 320
): PdfTranslationLayout['units'] {
  return translationUnits([
    item(caption, 320, 392, 250),
    item(previous, 320, 381, 250),
    item(tail, tailX, 370, 31)
  ])
}

it('keeps a wrapped native time quantity with its caption', () => {
  const [unit] = captionWrap(timeTail)
  assert.equal(unit.source, `${caption} ${lastCaptionLine} ${timeTail}`)
  assert.equal(unit.sourceOnly, undefined)
  assert.deepEqual(unit.items, ['1:0', '1:1', '1:2'])
})

it.each([
  ['a different unit', 'of 74 ms.', lastCaptionLine, 320],
  ['a closed sentence', timeTail, `${lastCaptionLine}.`, 320],
  ['a different column', timeTail, lastCaptionLine, 42]
])('keeps a time quantity separate with %s', (_shape, tail, previous, tailX) => {
  assert.ok(
    captionWrap(tail, previous, tailX).every(
      (unit) => !(unit.items.includes('1:1') && unit.items.includes('1:2'))
    )
  )
})

function captionRatio(detached: boolean): PdfTranslationLayout['units'] {
  const body = { fontName: 'caption' }
  const tight = { ...body, hasEOL: false }
  return translationUnits([
    item('Figure 3:', 71, 557, 45, { fontName: 'label', hasEOL: false }),
    item(
      'Comparison of the selected intervals in the two independent trials.',
      121,
      557,
      403,
      body
    ),
    item('For the second trial the magnitude of the pressure decreases as', 71, 545, 453, tight),
    item('', 71, 533, 0, { size: 0 }),
    item('2', 71, 533, 5, { fontName: 'symbol', hasEOL: false }),
    item('/Q', 76, 533, 12.5, { fontName: 'math', hasEOL: false }),
    item(
      '. The independent measurement confirmed the same estimate.',
      detached ? 104 : 88.6,
      533,
      435,
      body
    ),
    item('Repeated measurements are shown with the lower line.', 71, 521, 453, body),
    item('The upper line uses the control value.', 71, 509, 105, tight),
    item('4 Further observations', 71, 474, 140, { fontName: 'heading', size: 14 })
  ])
}

it.each([false, true])('keeps a wrapped native caption ratio (detached=%s)', (detached) => {
  const units = captionRatio(detached)
  const first = units.find((unit) => unit.items.includes('1:0'))
  assert.equal(first?.source.includes('decreases as 2/Q. The independent'), !detached)
  assert.equal(first?.items.includes('1:4'), !detached)
  assert.equal(first?.items.includes('1:8'), !detached)
  assert.ok(!first?.items.includes('1:9'))
})

function parentheticalWrap(
  opening: string,
  note: PdfLayoutTextItem
): PdfTranslationLayout['units'] {
  return translationUnits([
    item(opening, 320, 392, 241),
    item('the final expression follows the convention X', 320, 381, 170, { hasEOL: false }),
    item('+', 490, 381, 6, { fontName: 'symbol', hasEOL: false }),
    item('1 for related', 496, 381, 65),
    item('groups', 320, 370, 25, { hasEOL: false }),
    note,
    item(').', 349, 370, 5)
  ])
}

const opening = 'The assessment follows the stated conditions (including how'
const raised = item('4', 345, 373.2, 3, { size: 8, hasEOL: false })

it('keeps a wrapped word and its raised note inside the parenthetical explanation', () => {
  const [unit] = parentheticalWrap(opening, raised)
  assert.match(unit.source, /for related groups4\)\.$/u)
  assert.equal(unit.sourceOnly, undefined)
  assert.deepEqual(unit.items, ['1:0', '1:1', '1:2', '1:3', '1:4', '1:5', '1:6'])
})

it.each([
  ['a baseline digit', opening, item('4', 345, 370, 3, { hasEOL: false })],
  ['a missing opening parenthesis', opening.replace('(', ''), raised]
] as const)('keeps a terminal row separate with %s', (_shape, lead, note) => {
  assert.ok(
    parentheticalWrap(lead, note).every(
      (unit) => !(unit.items.includes('1:3') && unit.items.includes('1:4'))
    )
  )
})

const previousComparison = 'The measurements show a large increase in overall retention'
const comparisonSuffix = '28% for Iron). We use the results to verify collection'
const comparisonContext = 'rates in the other independent runs and confirm their agreement.'

function comparisonWrap(
  tail: string,
  previous = previousComparison,
  left = 320
): PdfTranslationLayout['units'] {
  return translationUnits([
    item(previous, 320, 392, 250),
    item('(', left, 381, 3, { hasEOL: false }),
    item('∼', left + 3, 381, 7, { fontName: 'symbol', hasEOL: false }),
    item('52% for Steel,', left + 10, 381, 49, { hasEOL: false }),
    item('∼', left + 62, 381, 7, { fontName: 'symbol', hasEOL: false }),
    item('41% for Tin and', left + 69, 381, 64, { hasEOL: false }),
    item('∼', left + 136, 381, 7, { fontName: 'symbol', hasEOL: false }),
    item(tail, left + 143, 381, 107),
    item(comparisonContext, left, 370, 250)
  ])
}

it('keeps styled approximation signs with the complete prose comparison', () => {
  const [unit] = comparisonWrap(comparisonSuffix)
  assert.equal(
    unit.source,
    `${previousComparison} (∼52% for Steel, ∼41% for Tin and ∼${comparisonSuffix} ${comparisonContext}`
  )
  assert.equal(unit.sourceOnly, undefined)
  assert.deepEqual(unit.items, ['1:0', '1:1', '1:2', '1:3', '1:4', '1:5', '1:6', '1:7', '1:8'])
})

it.each([
  [
    'a mathematical relation',
    '28% for x + y). We use the results to verify collection',
    previousComparison,
    320
  ],
  ['an open comparison', comparisonSuffix.replace(')', ''), previousComparison, 320],
  ['a finished previous sentence', comparisonSuffix, previousComparison + '.', 320],
  ['a different column', comparisonSuffix, previousComparison, 42]
])('keeps the native seam with %s', (_shape, tail, previous, left) => {
  assert.ok(
    comparisonWrap(tail, previous, left).every(
      (unit) => !(unit.items.includes('1:0') && unit.items.includes('1:6'))
    )
  )
})

function crossPageDisplayLead(
  fault: 'none' | 'complete sentence' | 'different numbering' | 'intervening text' | 'no display'
): PdfTranslationLayout['units'] {
  const tail = 'lists earlier measurements before introducing the test where the next'
  const opener = 'stable sample stays in place, for example'
  const side = { fontName: 'header', size: 7 }
  const pages = [
    [
      item('(5)', 550, 115, 20),
      item('The calibration follows a repeated procedure in each series. The report', 320, 83, 250),
      item(fault === 'complete sentence' ? `${tail}.` : tail, 320, 64, 250, { hasEOL: false })
    ],
    [
      item('Report', 45, 760, 30, side),
      item('2', 555, 760, 8, side),
      ...(fault === 'intervening text' ? [item('Independent method', 45, 744, 100)] : []),
      item(opener, 45, 737, 196, { hasEOL: false }),
      item(fault === 'no display' ? 'is' : '=', 112, 710, 10),
      item(fault === 'different numbering' ? '(8)' : '(6)', 275, 710, 20)
    ]
  ]
  return groupPdfTranslationPages({
    pages: pages.map((items, index) => ({
      page: index + 1,
      width: 612,
      height: 792,
      rotation: 0,
      items
    }))
  }).units
}

it.each([true, false])(
  'repairs an inline evaluation row without rejoining the preceding paragraph (%s)',
  (complete) => {
    const run = { hasEOL: false }
    const math = { ...run, fontName: 'italic' }
    const lead = 'The independent verifier reconstructs the records, then lists'
    const units = translationUnits([
      item(lead, 98, 520, 427),
      item('the four measurements in the same order:', 86, 507, 239, run),
      item('α', 329, 507, 7, math),
      item('(', 336, 507, 4, run),
      item('A', 340, 507, 8, math),
      item(') = 3,', 349, 507, 28),
      item('Q(', 86, 494, 11, run),
      item('A', 97, 494, 8, math),
      item(') = 5,', 106, 494, 32, run),
      item('α', 142, 494, 7, math),
      item('(', 149, 494, 4, run),
      item('B', 153, 494, 8, math),
      item(') = 7, Q(', 161, 494, 47, run),
      item(complete ? 'B' : 'C', 208, 494, 8, math),
      item(') = 9, showing one result per line.', 216, 494, 165),
      item('The following independent paragraph remains eligible.', 98, 481, 290)
    ])
    const owner = units.find((unit) => unit.items.includes('1:0'))
    assert.ok(owner?.source.endsWith('α(A) = 3,'))
    assert.equal(owner?.items.includes('1:14'), false)
    const continued = units.find((unit) => unit.items.includes('1:14'))
    assert.equal(
      continued?.source,
      complete
        ? 'Q(A) = 5, α(B) = 7, Q(B) = 9, showing one result per line.'
        : ') = 9, showing one result per line.'
    )
    assert.equal(continued?.sourceOnly, undefined)
    assert.equal(units.filter((unit) => unit.items.includes('1:14')).length, 1)
  }
)

it('keeps a short native display lead with the sentence from the previous page', () => {
  const unit = crossPageDisplayLead('none').find((part) => part.items.includes('2:2'))
  assert.ok(unit)
  assert.match(unit.source, /the next stable sample stays in place, for example$/u)
  assert.deepEqual(unit.items, ['1:1', '1:2', '2:2'])
  assert.deepEqual(
    unit.fragments.map((fragment) => fragment.page),
    [1, 2]
  )
  assert.equal(unit.sourceOnly, undefined)
})

it.each(['complete sentence', 'different numbering', 'intervening text', 'no display'] as const)(
  'keeps the display lead separate with %s',
  (fault) => {
    const unit = crossPageDisplayLead(fault).find((part) =>
      part.source.includes('stable sample stays in place')
    )
    assert.ok(unit)
    assert.deepEqual(
      unit.fragments.map((fragment) => fragment.page),
      [2]
    )
  }
)

it.each([true, false])(
  'keeps the inline condition of a labeled list entry in prose (%s)',
  (sequential) => {
    const inline = { hasEOL: false }
    const clause = { ...inline, fontName: 'clause' }
    const variable = { ...inline, fontName: 'variable' }
    const units = translationUnits([
      item(sequential ? 'R2' : 'R1', 90, 360, 12, inline),
      item('Previously the edges formed one connected component.', 107, 360, 305, clause),
      item('Its distance from the next vertex is finite.', 107, 348, 253),
      item('R3', 90, 336, 12, inline),
      item('For', 107, 336, 15, clause),
      item('x', 126, 336, 5, variable),
      item('=', 134, 336, 8, inline),
      item('y', 146, 336, 5, variable),
      item(', the chosen vertices share a common neighbor.', 151, 336, 254, {
        fontName: 'clause'
      }),
      item('The next argument concerns a separate interval.', 72, 324, 281)
    ])
    const owner = units.find((unit) => unit.items.includes('1:3'))
    assert.equal(owner?.sourceOnly === true, !sequential)
    assert.equal(owner?.items.includes('1:8'), sequential)
  }
)

function inlineQuantityWrap(
  fault: 'none' | 'open value' | 'different column' | 'finished sentence'
): PdfTranslationLayout['units'] {
  const start = 'The resulting signal can be guided and focused by the two objective'
  const local = fault === 'different column' ? 42 : 320
  return translationUnits([
    item(fault === 'finished sentence' ? `${start}.` : start, 320, 710, 250),
    item('lenses (', local, 699, 34, { hasEOL: false }),
    item('f', local + 35, 699, 3, { fontName: 'emphasis', hasEOL: false }),
    item(
      fault === 'open value'
        ? '= 9 mm. The next setup protects a reference sample remaining inside'
        : '= 9 mm). The next setup protects a reference sample remaining inside',
      local + 41,
      699,
      209
    ),
    item('the chamber after the initial measurement has been completed.', local, 688, 250)
  ])
}

it('keeps a bounded inline measurement between two neighboring prose sentences', () => {
  const unit = inlineQuantityWrap('none').find((part) => part.items.includes('1:1'))
  assert.ok(unit)
  assert.match(unit.source, /objective lenses \(f = 9 mm\)\. The next setup/u)
  assert.equal(unit.sourceOnly, undefined)
  assert.deepEqual(unit.items, ['1:0', '1:1', '1:2', '1:3', '1:4'])
})

it.each(['open value', 'different column', 'finished sentence'] as const)(
  'keeps the measurement row separate with %s',
  (fault) => {
    const unit = inlineQuantityWrap(fault).find((part) => part.items.includes('1:1'))
    assert.ok(unit)
    assert.ok(!unit.items.includes('1:0'))
  }
)

function inlinePanelAssignments(
  shape: 'groups' | 'signed',
  fault?: 'outside caption' | 'detached row' | 'wrong panel' | 'wrong index'
): PdfTranslationLayout['units'] {
  const title =
    fault === 'outside caption'
      ? 'The measured examples show the corresponding profile across three runs.'
      : 'Figure 7. Measured signal profiles following multiple trial settings'
  const secondY = fault === 'detached row' ? 638 : 678
  const wrap =
    shape === 'groups'
      ? ([
          ['in (h) for', 40, 39, 'body'],
          ['r', 81, 5, 'symbol'],
          ['=', 90, 8, 'operators'],
          ['0.2, (i) for', 103, 45, 'body'],
          ['r', 150, 5, 'symbol'],
          ['=', 159, 8, 'operators'],
          [fault === 'wrong panel' ? '0.4, and (k) for' : '0.4, and (j) for', 172, 61, 'body'],
          ['r', 235, 5, 'symbol'],
          ['=', 244, 8, 'operators'],
          ['0.7. The', 257, 39, 'body']
        ] as const)
      : ([
          ['k', 40, 3, 'symbol'],
          [fault === 'wrong index' ? '3' : '4', 43, 4, 'script'],
          ['=', 51, 8, 'operators'],
          ['−', 62, 8, 'operators'],
          ['8. The shaded part indicates the measured range.', 71, 225, 'body']
        ] as const)
  return translationUnits([
    item(title, 40, 700, 258),
    item(
      shape === 'groups'
        ? 'The signal detected after changing the background is shown'
        : 'The second outcome appears in (i) for k4 = −6, and (j) for',
      40,
      689,
      256
    ),
    ...wrap.map(([text, x, width, fontName], n) =>
      item(text, x, fontName === 'script' ? secondY - 1.8 : secondY, width, {
        fontName,
        size: fontName === 'script' ? 7.7 : 10,
        hasEOL: n === wrap.length - 1
      })
    )
  ])
}

it.each(['groups', 'signed'] as const)(
  'keeps the complete %s panel assignment and its native caption in one unit',
  (shape) => {
    const units = inlinePanelAssignments(shape)
    assert.equal(units.length, 1)
    assert.equal(units[0].sourceOnly, undefined)
    assert.match(
      units[0].source,
      shape === 'groups' ? /for r = 0.7. The$/u : /for k4 = −8. The shaded/u
    )
  }
)

it.each([
  ['groups', 'outside caption'],
  ['groups', 'detached row'],
  ['groups', 'wrong panel'],
  ['signed', 'wrong index']
] as const)('keeps %s split with %s', (shape, fault) => {
  const units = inlinePanelAssignments(shape, fault)
  assert.ok(units.length > 1)
})

function wrappedCaptionParameter(
  shape: 'parenthesis' | 'assignment',
  fault?: 'different column' | 'outside caption' | 'wrong parameter' | 'open assignment'
): PdfTranslationLayout['units'] {
  const heading =
    fault === 'outside caption'
      ? 'The response curves provide the measured profile for all selected settings'
      : 'Figure 2. Response curves obtained for all selected experimental settings'
  const left = fault === 'different column' ? 42 : 320
  const row = (
    str: string,
    dx: number,
    width: number,
    fontName = 'body',
    hasEOL = false
  ): PdfLayoutTextItem => item(str, left + dx, 370, width, { fontName, hasEOL })
  if (shape === 'parenthesis')
    return translationUnits([
      item(heading, 320, 392, 246),
      item('with different values of the sample length', 320, 381, 246),
      row('(', 0, 3),
      row('ks', 3, 8, 'parameter'),
      row('), as functions of order', 11, 86),
      row('m', 99, 6, 'parameter'),
      row('normalized to', 107, 53),
      row(fault === 'wrong parameter' ? 'kt' : 'ks', 162, 8, 'parameter'),
      row('.', 170, 3, 'body', true)
    ])

  return translationUnits([
    item(heading, 320, 392, 246),
    item('for the measured signal, with', 320, 381, 220, { hasEOL: false }),
    item('ks', 542, 381, 8, { fontName: 'parameter', hasEOL: false }),
    item(fault === 'open assignment' ? ':' : '=', 552, 381, 7, { fontName: 'operator' }),
    row('12 and', 0, 29),
    row('M', 31, 7, 'parameter'),
    row('=', 40, 7, 'operator'),
    row('4. The range of the sample variable is', 49, 147),
    row('x', 198, 5, 'parameter'),
    row('≤', 205, 8, 'operator'),
    row('3.', 215, 6, 'body', true)
  ])
}

it.each([
  ['parenthesis', '(ks), as functions of order m normalized to ks.'],
  ['assignment', 'with ks = 12 and M = 4. The range of the sample variable is x ≤ 3.']
] as const)('keeps a wrapped native caption %s with its trailing prose', (shape, ending) => {
  const units = wrappedCaptionParameter(shape)
  const caption = units.find((unit) => unit.items.includes('1:0'))
  assert.equal(caption?.sourceOnly, undefined)
  assert.ok(caption?.source.endsWith(ending))
  assert.equal(
    caption.items.length,
    units.reduce((sum, unit) => sum + unit.items.length, 0)
  )
})

it.each([
  ['parenthesis', 'different column'],
  ['parenthesis', 'outside caption'],
  ['parenthesis', 'wrong parameter'],
  ['assignment', 'open assignment']
] as const)('leaves a caption %s tail split with %s', (shape, fault) => {
  const caption = wrappedCaptionParameter(shape, fault).find((unit) => unit.items.includes('1:0'))
  assert.ok(!caption?.items.includes(shape === 'parenthesis' ? '1:8' : '1:10'))
})

function wrappedBodyAssignment(
  fault?: 'separate equation' | 'closed sentence' | 'other column' | 'different font' | 'gap'
): PdfTranslationLayout['units'] {
  const lastLineX = fault === 'other column' ? 320 : 42
  return translationUnits([
    item(
      fault === 'closed sentence'
        ? 'The response shows the measured intensities for different settings.'
        : 'The response shows the measured intensities for',
      55,
      430,
      225,
      { hasEOL: false }
    ),
    item('', 42, 418, 0, { fontName: 'variable' }),
    item('kx', 42, 418, 9, { fontName: 'variable', hasEOL: false }),
    item('=', 55, 418, 8, { fontName: 'operator', size: 10.4, hasEOL: false }),
    item(
      fault === 'separate equation' ? '12' : '12 and different values, as functions of the pulse',
      67,
      418,
      fault === 'separate equation' ? 11 : 213
    ),
    item(
      'duration within the selected band of the spectrum.',
      lastLineX,
      fault === 'gap' ? 382 : 406,
      180,
      { fontName: fault === 'different font' ? 'other' : 'body' }
    )
  ])
}

it('keeps a line-initial inline assignment inside an indented body paragraph', () => {
  const units = wrappedBodyAssignment()
  assert.equal(units.length, 1)
  assert.equal(units[0].sourceOnly, undefined)
  assert.equal(
    units[0].source,
    'The response shows the measured intensities for kx = 12 and different values, as functions of the pulse duration within the selected band of the spectrum.'
  )
  assert.deepEqual(units[0].items, ['1:0', '1:2', '1:3', '1:4', '1:5'])
})

it.each(['separate equation', 'closed sentence', 'other column', 'different font', 'gap'] as const)(
  'preserves a line-initial assignment with a %s',
  (fault) => {
    const owners = wrappedBodyAssignment(fault)
    const assignment = owners.find((unit) => unit.items.includes('1:3'))
    assert.ok(assignment?.sourceOnly)
    assert.ok(!assignment.items.includes('1:0'))
    assert.ok(!assignment.items.includes('1:5'))
  }
)

function terminalCaptionAcronym(
  fault?: 'different column' | 'different font' | 'closed caption' | 'separate row'
): PdfTranslationLayout['units'] {
  return translationUnits([
    item('Figure 3.', 42, 410, 34, { fontName: 'label', size: 9.6, hasEOL: false }),
    item(
      fault === 'closed caption'
        ? '(a) Sample geometry. (b) Surface profile measurements.'
        : '(a) Sample geometry. (b) Surface profile recorded via',
      79,
      410,
      207
    ),
    item(
      'SEM.',
      fault === 'different column' ? 320 : 42,
      fault === 'separate row' ? 384 : 398,
      22,
      {
        fontName: fault === 'different font' ? 'heading' : 'body'
      }
    )
  ])
}

it('keeps a same-font terminal acronym with the caption after a styled label', () => {
  const [unit] = terminalCaptionAcronym()
  assert.equal(unit.source, 'Figure 3. (a) Sample geometry. (b) Surface profile recorded via SEM.')
  assert.deepEqual(unit.items, ['1:0', '1:1', '1:2'])
})

it.each(['different column', 'different font', 'closed caption', 'separate row'] as const)(
  'leaves a caption acronym separate with a %s',
  (fault) => {
    const caption = terminalCaptionAcronym(fault).find((unit) => unit.items.includes('1:0'))
    assert.ok(!caption?.items.includes('1:2'))
  }
)

it.each([0, 24])('attaches a repeated styled name to its caption (offset=%s)', (offset) => {
  const styled = { fontName: 'emphasis', hasEOL: false }
  const runs = [
    item('Figure 4.', 45, 420, 41, { fontName: 'label', hasEOL: false }),
    item('A calibration trial with', 92, 420, 95, { hasEOL: false }),
    item('Acorn', 192, 420, 24, styled),
    item('illustrates the response to an independent control setting.', 221, 420, 334),
    item('This software supplies the plotted result for each completed test.', 45, 407.5, 510),
    item('This panel shows the default result when samples are fitted with', 45, 395, 510, {
      hasEOL: false
    }),
    item('', 45 + offset, 382.5, 0, { size: 0 }),
    item('Acorn.', 45 + offset, 382.5, 28, styled)
  ]
  const units = translationUnits(runs)
  const caption = units.find((unit) => unit.items.includes('1:0'))
  assert.equal(caption?.source.endsWith('with Acorn.'), offset === 0)
  assert.equal(caption?.items.includes('1:7'), offset === 0)
  assert.equal(units.filter((unit) => unit.items.includes('1:7')).length, 1)
})

function chainedBoundInProse(
  fault?: 'different column' | 'open formula' | 'closed prior'
): PdfTranslationLayout['units'] {
  return translationUnits([
    item(
      fault === 'closed prior'
        ? 'The measured response was confirmed under the test conditions.'
        : 'The measured response lies at a significance of between',
      42,
      430,
      235
    ),
    item('12', 42, 418, 10, { hasEOL: false }),
    item('< ξ <', 52, 418, 30, {
      fontName: 'symbol',
      hasEOL: false
    }),
    item(
      fault === 'open formula'
        ? 'values below. Other measurements show the expected pattern'
        : '37 in both channels. Other measurements show the expected pattern',
      fault === 'different column' ? 312 : 82,
      418,
      195
    )
  ])
}

it('keeps both numeric bounds native when the second shares its run with prose', () => {
  const owners = chainedBoundInProse()
  const formula = owners.find((u) => u.items.includes('1:2'))
  assert.equal(formula?.sourceOnly, true)
  assert.deepEqual(formula?.items, ['1:1', '1:2', '1:3'])
  assert.equal(
    formula.source,
    '12< ξ <37 in both channels. Other measurements show the expected pattern'
  )
})

it.each(['different column', 'open formula', 'closed prior'] as const)(
  'keeps the existing split for a chained bound with a %s',
  (fault) => {
    const formula = chainedBoundInProse(fault).find((u) => u.items.includes('1:2'))
    assert.ok(!formula?.items.includes('1:3'))
  }
)

it.each(['witnessed', 'unknown', 'other column'] as const)(
  'checks a wrapped numeric identifier against native evidence (%s)',
  (kind) => {
    const units = translationUnits([
      item('The original Sensor-17 remained in service during all trials.', 42, 456, 235),
      item('We measured the response across all relevant channels on Sensor-', 42, 430, 235),
      item(
        kind === 'unknown'
          ? '18. During the next test the results stayed stable.'
          : '17. During the next test the results stayed stable.',
        kind === 'other column' ? 312 : 42,
        418,
        235
      )
    ])
    const rebuilt = units.find((unit) => unit.items.includes('1:1'))
    assert.ok(rebuilt)
    assert.equal(rebuilt.items.includes('1:2'), kind === 'witnessed')
    if (kind === 'witnessed') assert.match(rebuilt.source, /Sensor-17\. During/)
  }
)

it.each(['adjacent suffix', 'different unit', 'separate text'] as const)(
  'keeps a micrometre suffix with its measurement (%s)',
  (kind) => {
    const units = translationUnits([
      item('The measured intensity remained stable during the test. At', 42, 430, 230),
      item('z', 42, 418, 5, { fontName: 'symbol', hasEOL: false }),
      item('=', 49, 418, 6, { fontName: 'symbol', hasEOL: false }),
      item('260', 57, 418, 15, { hasEOL: false }),
      item('μ', 75, 418, 5, { fontName: 'unit', hasEOL: false }),
      item(
        kind === 'different unit'
          ? 's it reveals a similar trend across the results'
          : 'm it reveals a similar trend across the results',
        kind === 'separate text' ? 86 : 80.2,
        418,
        190
      ),
      item('when the system runs under the nominal load.', 42, 407, 208)
    ])
    const expression = units.find((unit) => unit.items.includes('1:4'))
    assert.ok(expression)
    assert.equal(expression.items.includes('1:5'), kind === 'adjacent suffix')
    if (kind === 'adjacent suffix') assert.equal(expression.sourceOnly, true)
  }
)

function wrappedDistanceRange(
  fault?: 'detached row' | 'unwitnessed range' | 'different column' | 'competing glyph'
): PdfTranslationLayout['units'] {
  const x = fault === 'different column' ? 305 : 42
  const y = fault === 'detached row' ? 390 : 418
  const row = (text: string, dx: number, width: number, fontName = 'body'): PdfLayoutTextItem =>
    item(text, x + dx, y, width, { fontName, hasEOL: false })
  return translationUnits([
    item('The published measurements place the total path length at', 42, 430, 225, {
      hasEOL: false
    }),
    item(fault === 'unwitnessed range' ? ';' : '∼', 268, 430, 9, {
      fontName: 'mark',
      hasEOL: false
    }),
    item('', x, y, 0),
    row('0', 0, 5),
    row('.', 5, 3, 'decimal'),
    row('5', 8, 5),
    row(fault === 'competing glyph' ? '+' : '−', 13.3, 8, 'mark'),
    item('2 km. The same procedure gave similar results', x + 21.6, y, 214),
    item('across all other stations measured in the experiment.', x, y - 12, 235)
  ])
}

it('keeps a wrapped decimal distance range with its approximation and prose', () => {
  const owners = wrappedDistanceRange()
  const range = owners.find((u) => u.items.includes('1:6'))
  assert.ok(range)
  assert.ok(!range.sourceOnly)
  assert.ok(range.items.includes('1:1'))
  assert.ok(range.items.includes('1:7'))
  assert.match(range.source, /∼ 0\.5−2 km\./u)
})

it.each(['detached row', 'unwitnessed range', 'different column', 'competing glyph'] as const)(
  'keeps the original distance range separation with a %s',
  (fault) => {
    const range = wrappedDistanceRange(fault).find((u) => u.items.includes('1:5'))
    assert.ok(!range?.items.includes('1:1'))
    assert.ok(!range?.items.includes('1:7'))
  }
)

it.each([
  'attached unit',
  'closed sentence',
  'detached suffix',
  'distant row',
  'variable'
] as const)('keeps an attached micrometre unit with its wrapped quantity (%s)', (shape) => {
  const lead = 'The narrow aperture with a diameter of 640'
  const tail = 'm was illuminated throughout the procedure for each sample.'
  const suffixX = shape === 'detached suffix' ? 63 : 60
  const baseline = shape === 'distant row' ? 480 : 489
  const units = translationUnits([
    item(shape === 'closed sentence' ? `${lead}.` : lead, 54, 500, 245),
    item(shape === 'variable' ? 'σ' : 'μ', 54, baseline, 6, {
      fontName: 'greek',
      hasEOL: false
    }),
    item(tail, suffixX, baseline, 299 - suffixX),
    item(
      'These observations were collected while the apparatus remained stable.',
      54,
      baseline - 11,
      245
    )
  ])
  const owner = units.find((unit) => unit.items.includes('1:1'))!
  if (shape === 'attached unit') {
    assert.ok(owner.source.startsWith(`${lead} μ${tail}`))
    assert.equal(owner.sourceOnly, undefined)
    assert.deepEqual(owner.items, ['1:0', '1:1', '1:2', '1:3'])
  } else {
    assert.equal(owner.sourceOnly, true)
    assert.deepEqual(owner.items, ['1:1'])
  }
  assert.deepEqual(units.flatMap((unit) => unit.items).sort(), ['1:0', '1:1', '1:2', '1:3'])
})

it.each(['painted last', 'painted first', 'same font'] as const)(
  'gives a separately painted label its own translation rectangle (%s)',
  (shape) => {
    const label = item('The selection rule:', 340, 365, 86, {
      fontName: shape === 'same font' ? 'body' : 'label',
      size: shape === 'same font' ? 9 : 8
    })
    const body = [
      item('Given a set of candidate records, each record is separately', 340, 352, 214, {
        size: 9
      }),
      item('reviewed by a second observer under the same conditions.', 340, 341, 214, {
        size: 9
      }),
      item('Only accepted observations are included in the final count.', 340, 330, 214, {
        size: 9
      })
    ]
    const units = translationUnits(shape === 'painted first' ? [label, ...body] : [...body, label])
    if (shape === 'painted last') {
      assert.deepEqual(
        units.map((unit) => unit.items),
        [['1:3'], ['1:0', '1:1', '1:2']]
      )
      assert.equal(units[0].source, label.str)
      assert.equal(units[1].source, body.map((row) => row.str).join(' '))
      assert.ok(units.every((unit) => !unit.sourceOnly))
    } else {
      assert.equal(units.length, 1)
      assert.ok(units[0].source.startsWith(label.str))
    }
  }
)

it.each(['ordered pair', 'different marker', 'different font', 'different column'] as const)(
  'keeps a paired inline enumeration in its native paragraph (%s)',
  (shape) => {
    const x = shape === 'different column' ? 310 : 50
    const units = translationUnits([
      item('Reports can be compared under the same practical conditions', 50, 500, 245),
      item('provided that', 50, 489, 58, { hasEOL: false }),
      item(shape === 'different marker' ? '(v)' : '(i)', 111, 489, 9, {
        fontName: 'marker',
        hasEOL: false
      }),
      item('observers use the same reporting process,', 123, 489, 172),
      item('and', x, 478, 14, { hasEOL: false }),
      item('(ii)', x + 17, 478, 11, {
        fontName: shape === 'different font' ? 'other' : 'marker',
        hasEOL: false
      }),
      item('all recorded sample values receive an independent check', x + 31, 478, 214),
      item('before the summary is prepared.', x, 467, 125)
    ])
    if (shape === 'ordered pair') {
      assert.equal(units.length, 1)
      assert.match(units[0].source, /\(i\) observers[^,]+, and \(ii\) all recorded/u)
      assert.equal(units[0].sourceOnly, undefined)
    } else {
      const marker = units.find((unit) => unit.items.includes('1:5'))
      assert.equal(marker?.source, 'and (ii)')
      assert.equal(marker.sourceOnly, true)
    }
    assert.deepEqual(
      units.flatMap((unit) => unit.items).sort(),
      Array.from({ length: 8 }, (_, i) => `1:${i}`)
    )
  }
)

it.each(['native', 'unlabeled', 'closed caption', 'baseline marker', 'other column'] as const)(
  'checks the raised marker and neighboring caption before joining a definition (%s)',
  (shape) => {
    const x = shape === 'other column' ? 330 : 50
    const opening =
      shape === 'unlabeled'
        ? 'The experiment estimates a stable coefficient from independent samples. EST'
        : 'Figure 2: The measurement describes the assembled system. EST' +
          (shape === 'closed caption' ? '.' : '')
    const units = translationUnits([
      item(opening, 50, 492, 250),
      item('estimate', x, 481, 33, { hasEOL: false }),
      item('(', x + 36, 481, 4, { fontName: 'notation', hasEOL: false }),
      item('A', x + 40, 481, 7, { fontName: 'variable', hasEOL: false }),
      item('∗', x + 47.4, shape === 'baseline marker' ? 481 : 484.5, 4, {
        fontName: 'symbol',
        size: 7,
        hasEOL: false
      }),
      item(')', x + 52, 481, 4, { fontName: 'notation', hasEOL: false }),
      item('is the value obtained from the independent measurements.', x + 60, 481, 186)
    ])
    const owner = units.find((u) => u.items.includes('1:0'))!
    if (shape === 'native') {
      assert.equal(
        owner.source,
        `${opening} estimate (A∗) is the value obtained from the independent measurements.`
      )
      assert.equal(owner.sourceOnly, undefined)
      assert.deepEqual(
        owner.items,
        Array.from({ length: 7 }, (_, i) => `1:${i}`)
      )
    } else {
      assert.equal(owner.source, opening)
      assert.deepEqual(owner.items, ['1:0'])
      assert.equal(units.find((u) => u.items.includes('1:4'))?.sourceOnly, true)
    }
  }
)

function captionAssignmentWrap(
  lead = 'The cross section is shown with',
  x = 40,
  y = 519
): PdfTranslationLayout['units'] {
  const part = (
    str: string,
    left: number,
    baseline: number,
    width: number,
    fontName = 'caption',
    hasEOL = false
  ): PdfLayoutTextItem => item(str, left, baseline, width, { fontName, size: 9, hasEOL })
  return translationUnits([
    part('Figure 2.', 40, 530, 27, 'label'),
    part(lead, 70, 530, 202, 'caption', true),
    part('ab', x, y, 9, 'math'),
    part('=', x + 12, y, 8, 'symbol'),
    part('12 and different settings for', x + 23, y, 125),
    part('m', x + 151, y, 6, 'math'),
    part('. The left panel shows the inlet', x + 157, y, 85, 'caption', true),
    part('and the right panel shows the outlet.', x, y - 11, 225, 'caption', true)
  ])
}

it('keeps a wrapped inline assignment in its caption', () => {
  const units = captionAssignmentWrap()
  assert.equal(units.length, 1)
  assert.equal(
    units[0].source,
    'Figure 2. The cross section is shown with ab = 12 and different settings for m. The left panel shows the inlet and the right panel shows the outlet.'
  )
  assert.equal(units[0].sourceOnly, undefined)
  assert.deepEqual(units[0].items, ['1:0', '1:1', '1:2', '1:3', '1:4', '1:5', '1:6', '1:7'])
})

it.each([
  ['a closed caption', 'The cross section is shown.', 40, 519],
  ['a different column', 'The cross section is shown with', 310, 519],
  ['a display gap', 'The cross section is shown with', 40, 508]
] as const)('keeps the assignment separate with %s', (_shape, lead, x, y) => {
  assert.ok(
    captionAssignmentWrap(lead, x, y).some((unit) => unit.source === 'ab =' && unit.sourceOnly)
  )
})

const introductoryExample = 'The laboratory maintains shared notes and other educational'
const exampleTail = ', field guides, class notes, and workbooks).'

function wrappedStyledExample(
  previous = introductoryExample,
  x = 53,
  tail = exampleTail,
  fontName = 'body'
): PdfTranslationLayout['units'] {
  return translationUnits([
    item('Training staff may create templates for common procedures.', 53, 690, 244, { size: 9 }),
    item(previous, 53, 679, 240, { size: 9 }),
    item('Handbooks (', x, 668, 43, { size: 9, hasEOL: false }),
    item('e.g.', x + 43, 668, 12, { size: 9, fontName: 'italic', hasEOL: false }),
    item(tail, x + 55, 668, 170, { size: 9, fontName, hasEOL: false })
  ])
}

it('keeps a wrapped example with a complete styled abbreviation in the paragraph', () => {
  const units = wrappedStyledExample()
  assert.equal(units.length, 1)
  const [unit] = units
  assert.match(
    unit.source,
    /educational Handbooks \(e\.g\., field guides, class notes, and workbooks\)\.$/u
  )
  assert.equal(unit.sourceOnly, undefined)
  assert.deepEqual(unit.items, ['1:0', '1:1', '1:2', '1:3', '1:4'])
})

it.each([
  ['another column', introductoryExample, 278, exampleTail, 'body'],
  ['an incomplete list', introductoryExample, 53, exampleTail.replace(')', ''), 'body'],
  ['a completed previous sentence', introductoryExample + '.', 53, exampleTail, 'body'],
  ['no return to body font', introductoryExample, 53, exampleTail, 'italic']
] as const)('keeps the styled abbreviation separate with %s', (_case, previous, x, tail, font) => {
  assert.ok(
    wrappedStyledExample(previous, x, tail, font).some(
      (unit) => unit.items.includes('1:3') && unit.sourceOnly && !unit.items.includes('1:1')
    )
  )
})

function wrappedPanelReference(
  fault?: 'a missing opening bracket' | 'another column' | 'another font' | 'a display gap'
): PdfTranslationLayout['units'] {
  const reference =
      fault === 'a missing opening bracket'
        ? 'The repeated central measurements are summarized in Fig. 3'
        : 'The repeated central measurements are summarized in [Fig. 3',
    x = fault === 'another column' ? 330 : 52,
    y = fault === 'a display gap' ? 454 : 468
  return translationUnits([
    item('A separate calibration confirms the initial measurements.', 52, 501, 221),
    item(reference, 52, 480, 220),
    item('(c)].', x, y, 19, {
      fontName: fault === 'another font' ? 'other' : 'body',
      hasEOL: false
    }),
    item('An independent reading confirms the new operating conditions.', x + 24, y, 196)
  ])
}

it('keeps the wrapped panel with its bracketed reference and the next sentence separate', () => {
  const [reference, following] = wrappedPanelReference()
  assert.match(reference.source, /\[Fig\. 3 \(c\)\]\.$/u)
  assert.equal(reference.sourceOnly, undefined)
  assert.deepEqual(reference.items, ['1:0', '1:1', '1:2'])
  assert.deepEqual(following.items, ['1:3'])
})

it.each(['a missing opening bracket', 'another column', 'another font', 'a display gap'] as const)(
  'keeps a panel suffix separate with %s',
  (fault) => {
    const owner = wrappedPanelReference(fault).find((unit) => unit.items.includes('1:2'))
    assert.equal(owner?.sourceOnly, true)
    assert.ok(!owner?.items.includes('1:1'))
  }
)

it.each(['proved', 'closed sentence', 'intervening text', 'different font'] as const)(
  'checks a modal ending before a captioned column wrap: %s',
  (shape) => {
    const tail = 'An independent analysis confirms that the assistant should',
      rows = { size: 9 },
      prose = [
        item(
          'The tools help teams investigate unusual behavior in the system.',
          54,
          107,
          240,
          rows
        ),
        item('They can reduce many repeated tasks and avoid manual checks.', 54, 96, 240, rows),
        item(shape === 'closed sentence' ? tail + ' respond.' : tail, 54, 85, 240, {
          ...rows,
          hasEOL: false
        })
      ],
      figure = [
        item('Figure 2. A hypothetical equipment profile for', 318, 607, 240, {
          ...rows,
          fontName: 'caption'
        }),
        item('the reference case.', 318, 596, 86, {
          ...rows,
          fontName: 'caption',
          hasEOL: false
        })
      ]
    if (shape === 'intervening text')
      figure.push(item('Operating limits', 318, 590, 240, { ...rows, fontName: 'other' }))
    const head = 'be able to assemble these observations and provide enough detail',
      units = translationUnits([
        ...prose,
        ...figure,
        item(head, 318, 523, 240, {
          ...rows,
          fontName: shape === 'different font' ? 'other' : 'body'
        }),
        item(
          'to suggest improvements based on the current implementation and',
          318,
          512,
          240,
          rows
        ),
        item('review them carefully for every station.', 318, 501, 155, rows)
      ]),
      owner = units.find((unit) => unit.items.includes('1:2'))
    assert.ok(owner)
    if (shape === 'proved') {
      assert.match(owner.source, /should be able to assemble/u)
      assert.deepEqual(owner.items, ['1:0', '1:1', '1:2', '1:5', '1:6', '1:7'])
      assert.equal(owner.fragments.length, 2)
    } else {
      assert.ok(!owner.source.includes(head))
    }
    assert.ok(units.some((unit) => unit.items.join(',') === '1:3,1:4'))
  }
)

it.each(['complete', 'missing second marker', 'closed sentence', 'different column'] as const)(
  'checks a running three-part enumeration at a native row boundary (%s)',
  (shape) => {
    const x = 315,
      nextX = shape === 'different column' ? 48 : x,
      body = { size: 9 },
      units = translationUnits([
        item('(i) measured the output across the standard reference settings', x, 430, 231, body),
        item(
          shape === 'missing second marker'
            ? 'and checked it for unexpected behavior in each additional run'
            : 'under changing load, (ii) checked it in each additional run',
          x,
          419.5,
          231,
          body
        ),
        item('during the final series with the same protocol', x, 409, 200, {
          ...body,
          hasEOL: false
        }),
        item('6', x + 202, 412.8, 3, { size: 6, hasEOL: false }),
        item(shape === 'closed sentence' ? ', in sum.' : ', and', x + 207, 409, 24, body),
        item(
          '(iii) recorded the reference signals returned by each sensor.',
          nextX,
          398.5,
          231,
          body
        )
      ]),
      owner = units.find((unit) => unit.items.includes('1:0'))
    assert.ok(owner)
    if (shape === 'complete') {
      assert.equal(owner.sourceOnly, undefined)
      assert.deepEqual(owner.items, ['1:0', '1:1', '1:2', '1:3', '1:4', '1:5'])
    } else {
      assert.ok(!owner.items.includes('1:5'))
    }
  }
)

it.each(['proved', 'raised glyph', 'another column', 'missing closing bracket'] as const)(
  'checks the native wrap of a cited method after inline math: %s',
  (shape) => {
    const x = shape === 'another column' ? 358 : 54,
      body = { size: 9 },
      inline = { ...body, hasEOL: false },
      math = { ...inline, fontName: 'italic' },
      units = translationUnits([
        item(
          'Several measurements isolate a local response in each candidate region.',
          54,
          691,
          241,
          body
        ),
        item('The expected output is represented by', 54, 680, 123, inline),
        item('𝑤', 179, 680, 7, math),
        item('and checked against a known reference', 188, 680, 58, inline),
        item('𝑅', 248, shape === 'raised glyph' ? 683 : 680, 6, math),
        item('. Similar to', 255, 680, 40, body),
        item('RX4 [', x, 669, 23, inline),
        item('7', x + 23, 669, 4, inline),
        item(
          (shape === 'missing closing bracket' ? ', ' : '], ') +
            'Atlas then checks the response produced by the calibrated device',
          x + 27,
          669,
          214,
          body
        ),
        item('under the conditions described in an earlier section.', x, 658, 185, body)
      ]),
      method = units.find((u) => u.items.includes('1:6'))
    assert.ok(method)
    if (shape === 'proved') {
      assert.equal(units.length, 1)
      assert.match(method.source, /Similar to RX4 \[7\], Atlas/u)
      assert.equal(method.sourceOnly, undefined)
      assert.equal(method.items.length, 10)
    } else {
      assert.equal(method.sourceOnly, true)
      assert.ok(!method.items.includes('1:5'))
    }
  }
)

it.each([
  'matching',
  'different stem',
  'skipped number',
  'another column',
  'different style'
] as const)('checks a wrapped numbered dataset name: %s', (shape) => {
  const x = shape === 'another column' ? 355 : 54,
    body = { size: 9 },
    inline = { ...body, hasEOL: false },
    key = { ...inline, fontName: 'key' },
    name = { ...inline, fontName: 'label' },
    units = translationUnits([
      item(
        'The measurements were sorted by context and normalized before scoring.',
        54,
        718,
        240,
        body
      ),
      item('We draw two distinct samples from the evaluation sets:', 54, 707, 148, inline),
      item('Set 1 (', 205, 707, 24, key),
      item('Primary', 229, 707, 24, name),
      item(')', 253, 707, 3, key),
      item('and', 258, 707, 14, inline),
      item(shape === 'different stem' ? 'Group' : 'Set', 275, 707, 19, { ...key, hasEOL: true }),
      item(shape === 'skipped number' ? '4 (' : '2 (', x, 696, 10, key),
      item('Secondary', x + 10, 696, 36, {
        ...name,
        fontName: shape === 'different style' ? 'other' : name.fontName
      }),
      item(')', x + 46, 696, 3, key),
      item(
        '. For each measured subset, we compute several scores and confidence limits.',
        x + 49,
        696,
        191,
        body
      )
    ]),
    ordinal = units.find((u) => u.items.includes('1:7'))
  assert.ok(ordinal)
  if (shape === 'matching') {
    assert.equal(units.length, 1)
    assert.match(ordinal.source, /Set 1 \(Primary\) and Set 2 \(Secondary\)/u)
    assert.equal(ordinal.sourceOnly, undefined)
    assert.equal(ordinal.items.length, 11)
  } else {
    assert.equal(ordinal.sourceOnly, true)
    assert.ok(!ordinal.items.includes('1:6'))
  }
})

function captionOnlyColumnWrap(
  fault: 'none' | 'intervening text' | 'missing lexical evidence'
): PdfTranslationLayout['units'] {
  return groupPdfTranslationPages({
    pages: [1, 2, 3, 4].map((page) => {
      const x = page % 2 ? 48 : 42
      const header = { fontName: 'header', size: 7, hasEOL: false }
      const items = [
        item('Article', x + 6, 758, 20, header),
        item('Example Review', 494 + x - 42, 758, 45, header),
        item(String(page), 550 + x - 42, 758, 4, header)
      ]
      if (page === 2) {
        items.push(
          item('The measurements across the two series show stable behavior', x, 82, 250),
          item('over all conditions with the paired calibration yielding a com-', x, 70, 250, {
            hasEOL: false
          }),
          item('Figure 2. Reference measurements for the first group.', 318, 460, 245),
          item('The indicators mark the average of the readings.', 318, 448, 214),
          item('Figure 3. Observations from the second group.', 318, 340, 245),
          item('The line is the median across all measured cases.', 318, 328, 214)
        )
        if (fault === 'intervening text')
          items.push(item('The next method uses an independent measurement.', 318, 73, 210))
      } else if (page === 3) {
        items.push(
          item('bined response for the two instruments during the trial.', x, 736, 250),
          item(
            'These results confirm the previous estimates under normal conditions.',
            x,
            724,
            244
          ),
          item('The remaining readings matched the expected range.', x, 712, 188)
        )
      } else {
        const term = fault === 'missing lexical evidence' ? 'individual' : 'combined'
        items.push(
          item(`The ${term} result is within the expected calibration range.`, x, 736, 245),
          item('The final assessment also reflects the reference data.', x, 724, 219)
        )
      }
      return { page, width: 612, height: 792, rotation: 0, items }
    })
  }).units
}

it.each(['none', 'intervening text', 'missing lexical evidence'] as const)(
  'joins a native word at the page boundary with a caption-only last column (%s)',
  (fault) => {
    const units = captionOnlyColumnWrap(fault)
    const ending = units.find((unit) => unit.items.includes('2:4'))
    const next = units.find((unit) => unit.items.includes('3:3'))
    assert.ok(ending && next)
    assert.equal(units.filter((unit) => /^Figure [23]\./u.test(unit.source)).length, 2)
    if (fault === 'none') {
      assert.equal(ending, next)
      assert.match(ending.source, /the paired calibration yielding a combined response/u)
      assert.deepEqual(
        ending.fragments.map((fragment) => fragment.page),
        [2, 3]
      )
    } else {
      assert.notEqual(ending, next)
    }
  }
)

function openingPageWrap(
  fault: 'none' | 'independent paragraph' | 'missing witness'
): PdfTranslationLayout['units'] {
  const margin = { fontName: 'header', size: 7, hasEOL: false }
  return groupPdfTranslationPages({
    pages: [
      [
        item('Report', 49, 760, 20, margin),
        item('1', 552, 760, 4, margin),
        item(
          fault === 'missing witness'
            ? 'The observed range is suitable in all the calibration runs.'
            : 'The observed range is acceptable in all the calibration runs.',
          42,
          733,
          250
        ),
        item('The standard procedure was followed during each series of tests.', 315, 107, 250),
        item('Measurements for every condition yielded similar values subject', 315, 95, 250),
        item('to independent review.', 315, 83, 100),
        item('To validate the estimated values we start with an ac-', 315, 71, 250, {
          hasEOL: false
        })
      ],
      [
        item('Report', 55, 760, 20, margin),
        item('2', 558, 760, 4, margin),
        item(
          fault === 'independent paragraph'
            ? 'A second series was measured separately under controlled conditions.'
            : 'ceptable range for the inputs gathered during the experiment.',
          48,
          737,
          250
        ),
        item('The results support the previous conclusions for each case.', 48, 725, 250),
        item('All the instruments were calibrated before use.', 48, 713, 189)
      ]
    ].map((items, index) => ({ page: index + 1, width: 612, height: 792, rotation: 0, items }))
  }).units
}

it.each(['none', 'independent paragraph', 'missing witness'] as const)(
  'joins an unfinished opening line across consecutive folios with native evidence (%s)',
  (fault) => {
    const units = openingPageWrap(fault)
    const left = units.find((unit) => unit.items.includes('1:6'))
    const right = units.find((unit) => unit.items.includes('2:2'))
    assert.ok(left && right)
    if (fault === 'none') {
      assert.equal(left, right)
      assert.match(left.source, /an acceptable range/u)
      assert.deepEqual(
        left.fragments.map((fragment) => fragment.page),
        [1, 2]
      )
    } else {
      assert.notEqual(left, right)
    }
    const prior = units.find((unit) => unit.source.endsWith('to independent review.'))
    assert.ok(prior)
    assert.deepEqual(
      prior.fragments.map((fragment) => fragment.page),
      [1]
    )
  }
)

it.each([0, 10])('joins full-width prose below an aligned page number (%s)', (shift) => {
  const row = (
    str: string,
    x: number,
    y: number,
    width: number,
    hasEOL = true
  ): PdfLayoutTextItem => item(str, x, y, width, { size: 12, hasEOL })
  const units = groupPdfTranslationPages({
    pages: [
      [
        row('A controlled measurement of material response', 90, 700, 400),
        row('The setup collects enough measurements to validate the independent run.', 90, 676, 432)
      ],
      [
        row('2', 90, 730, 6),
        row('The original response is adequately described by the prior benchmark.', 90, 89.5, 427),
        row(
          'We start the analysis with consistent observations from independent measurement runs.',
          98.6,
          73.5,
          423.4
        ),
        row('This method fits smooth calibration', 90, 57.5, 432, false)
      ],
      [
        row('3', 516 - shift, 730, 6),
        row('models to the observed measurements, allowing estimates of', 90, 704, 432),
        row('the underlying response and its uncertainty.', 90, 688, 180),
        row('A separate experiment checks the procedure under other conditions.', 98.6, 672, 423.4)
      ]
    ].map((items, index) => ({ page: index + 1, width: 612, height: 792, rotation: 0, items }))
  }).units
  const head = units.find((unit) => unit.items.includes('2:3'))
  const tail = units.find((unit) => unit.items.includes('3:1'))
  assert.ok(head && tail)
  assert.equal(head === tail, shift === 0)
  assert.deepEqual(
    head.fragments.map(({ page }) => page),
    shift ? [2] : [2, 3]
  )
  assert.ok(units.some((unit) => unit.items.includes('3:0') && unit.preserve === 'literal'))
})

function figureDisplayLead(
  fault: 'none' | 'foreign text' | 'missing noun witness' | 'no equation'
): PdfTranslationLayout['units'] {
  return translationUnits([
    item(
      fault === 'missing noun witness'
        ? 'The liquid passed through the test device for each independent run.'
        : 'The filtered fluid passed through the test device for each run.',
      53,
      86,
      235
    ),
    item('We measured the results at two points and compared the amount of filtered', 53, 74, 235, {
      hasEOL: false
    }),
    item(
      fault === 'foreign text'
        ? 'An unrelated note was printed here.'
        : '∗e-mail: info@example.invalid',
      58,
      54,
      105,
      { size: 8 }
    ),
    item('Figure 1. The apparatus used for the calibration run.', 315, 291, 235, { size: 9 }),
    item('All readings are taken from the output sensor.', 315, 280.2, 199, { size: 9 }),
    item('fluid is measured at the outlet during calibration', 315, 249, 198, { hasEOL: false }),
    item(fault === 'no equation' ? 'Next section' : 'I = I0', 349, 224, 35)
  ])
}

it.each(['none', 'foreign text', 'missing noun witness', 'no equation'] as const)(
  'joins a cross-column display lead below an independent caption (%s)',
  (fault) => {
    const units = figureDisplayLead(fault)
    const left = units.find((unit) => unit.items.includes('1:1'))
    const right = units.find((unit) => unit.items.includes('1:5'))
    assert.ok(left && right)
    if (fault === 'none') {
      assert.equal(left, right)
      assert.match(left.source, /the amount of filtered fluid is measured/u)
      assert.equal(left.fragments.length, 2)
    } else {
      assert.notEqual(left, right)
    }
    assert.ok(units.some((unit) => unit.source.startsWith('Figure 1.')))
    assert.ok(
      units.some((unit) =>
        unit.source.startsWith(fault === 'foreign text' ? 'An unrelated' : '∗e-mail:')
      )
    )
  }
)

it.each([false, true])(
  'joins the final acknowledgment around an independent column figure (foreign row=%s)',
  (foreignRow) => {
    const [left, right, width] = [54, 315, 243]
    const lead = item(
      'I thank my colleagues for their detailed feedback and',
      left + 10,
      78,
      width - 10
    )
    const ending = item('research award of the Regional Envi-', left, 54, width, { hasEOL: false })
    const tail = item('ronmental Research Board.', right, 432, 110, { hasEOL: false })
    const units = translationUnits([
      item('Environmental observations provide an independent estimate.', left, 730, width),
      lead,
      item('acknowledge support of the project through a regional', left, 66, width),
      ending,
      item('(a)', 381, 690, 13, { fontName: 'plot', hasEOL: false }),
      item('z', 537, 650, 6, { fontName: 'plot', hasEOL: false }),
      item('Fig. 1. The observed response of each controlled group.', right, 477, width),
      item('The shaded range gives the measurement uncertainty.', right, 465, 205),
      ...(foreignRow ? [item('An unrelated field note.', right, 446, 132)] : []),
      tail,
      item('References', right, 409, 54, { fontName: 'heading', hasEOL: false }),
      item('1. A. Reader, A calibration guide, J. Meas. 4, 12 (2020).', right + 7, 392, 216),
      item('2. B. Writer, Reference measurements, J. Tools 6, 9 (2021).', right + 7, 381, 225)
    ])
    const acknowledgment = units.find((unit) => unit.items.includes('1:3'))
    const continuation = units.find((unit) => unit.items.includes(foreignRow ? '1:9' : '1:8'))
    assert.ok(acknowledgment && continuation)
    if (foreignRow) {
      assert.notEqual(acknowledgment, continuation)
    } else {
      assert.equal(acknowledgment, continuation)
      assert.ok(acknowledgment.source.endsWith('Regional Environmental Research Board.'))
      assert.deepEqual(acknowledgment.originalStrings, [
        lead.str,
        'acknowledge support of the project through a regional',
        ending.str,
        tail.str
      ])
      assert.equal(acknowledgment.fragments.length, 2)
    }
    assert.ok(units.some((unit) => unit.source.startsWith('Fig. 1.')))
    assert.ok(units.some((unit) => unit.source === 'References' && unit.sourceOnly))
  }
)

function captionInfinitiveWrap(
  fault: 'none' | 'closed sentence' | 'intervening text' | 'different width'
): PdfTranslationLayout['units'] {
  const [x, right, width] = [48, 315, 239]
  const leftTail = 'when the readings are used to compare the two samples, it is important'
  return translationUnits([
    item(
      'Measurements were recorded in the laboratory for every calibration point and each independent test,',
      x,
      40,
      width
    ),
    item(fault === 'closed sentence' ? leftTail + '.' : leftTail, x, 28, width, { hasEOL: false }),
    ...(fault === 'intervening text'
      ? [item('Additional details for a separate test are available.', right, 454, width)]
      : []),
    item('Figure 2. An example of the expected readings.', right, 412, width, { size: 9 }),
    item('The bars show the distribution across all groups.', right, 401, 194, { size: 9 }),
    item(
      'to consider the additional uncertainty in the estimates.',
      right,
      382,
      fault === 'different width' ? 190 : width
    ),
    item(
      'Repeated observations provide a bound on this error during calibration.',
      right,
      370,
      fault === 'different width' ? 190 : width
    ),
    item('The final values are stable across the experiments.', right, 358, 191)
  ])
}

it.each(['none', 'closed sentence', 'intervening text', 'different width'] as const)(
  'joins an unfinished infinitive below an independently owned figure caption (%s)',
  (fault) => {
    const units = captionInfinitiveWrap(fault)
    const left = units.find((unit) => unit.items.includes('1:1'))
    const right = units.find((unit) =>
      unit.items.includes(fault === 'intervening text' ? '1:5' : '1:4')
    )
    const caption = units.find((unit) => unit.source.startsWith('Figure 2.'))
    assert.ok(left && right && caption)
    if (fault === 'none') {
      assert.equal(left, right)
      assert.match(left.source, /it is important to consider the additional uncertainty/u)
      assert.equal(left.fragments.length, 2)
    } else {
      assert.notEqual(left, right)
    }
    assert.notEqual(caption, left)
    assert.notEqual(caption, right)
  }
)

it.each(['none', 'closed sentence', 'intervening text', 'different width', 'body caption font'])(
  'continues a noun phrase below an independently owned same-size figure caption (%s)',
  (fault) => {
    const [left, right, width] = [49, 318, 239]
    const leftTail = 'all records were evaluated in two stages: first, selecting the'
    const opening = item(
      fault === 'closed sentence'
        ? 'The first set of checked observations was selected.'
        : leftTail,
      left,
      83,
      width,
      { hasEOL: false }
    )
    const lead = item(
      'most reliable reference samples, and then testing their responses.',
      right,
      461,
      fault === 'different width' ? 195 : width
    )
    const fontName = fault === 'body caption font' ? 'body' : 'caption'
    const runs = [
      item(
        'Measurements were recorded in a laboratory for all calibration points, and',
        left,
        95,
        width
      ),
      opening,
      ...(fault === 'intervening text'
        ? [item('An unrelated report is available separately.', right, 539, 209)]
        : []),
      item('Figure 2. An example of the expected readings.', right, 498, width, { fontName }),
      item('The bars show the distribution across all groups.', right, 486, 194, { fontName }),
      lead,
      item(
        'Repeated observations provide a bound on this error during calibration.',
        right,
        449,
        fault === 'different width' ? 195 : width
      ),
      item('The final values are stable across the experiments.', right, 437, 191)
    ]
    const units = translationUnits(runs)
    const leftOwner = units.find((unit) => unit.items.includes('1:1'))
    const rightOwner = units.find((unit) => unit.items.includes(`1:${runs.indexOf(lead)}`))
    const caption = units.find((unit) => unit.source.startsWith('Figure 2.'))
    assert.ok(leftOwner && rightOwner && caption)
    if (fault === 'none') {
      assert.equal(leftOwner, rightOwner)
      assert.equal(leftOwner.fragments.length, 2)
      assert.match(leftOwner.source, /selecting the most reliable reference samples/u)
    } else {
      assert.notEqual(leftOwner, rightOwner)
    }
    assert.notEqual(caption, leftOwner)
    assert.notEqual(caption, rightOwner)
  }
)

function centeredCaptionWord(
  fault: 'none' | 'unaligned caption' | 'no intact word'
): PdfTranslationLayout['units'] {
  const [left, right, width] = [50, 310, 236]
  return translationUnits([
    item(
      fault === 'no intact word'
        ? 'The measurement combines all of the independent sample readings'
        : 'The calculation combines all of the independent sample readings',
      left,
      102,
      width
    ),
    item('and verifies the output by comparing it with the final calcu-', left, 90, width, {
      hasEOL: false
    }),
    item('Figure 2: An overview of the validation process.', 328, 286, 200),
    item(
      'The shaded region shows all calibrated samples.',
      fault === 'unaligned caption' ? 330 : 338,
      274,
      180
    ),
    item('Median values.', 398, 262, 60),
    item('lation of the corresponding reference estimate. The results', right, 218, width),
    item('remain stable for every independently measured input.', right, 206, width),
    item('Each repeat produced the same pattern.', right, 194, 172)
  ])
}

it.each(['none', 'unaligned caption', 'no intact word'] as const)(
  'joins a witnessed discretionary word around a centered caption (%s)',
  (fault) => {
    const units = centeredCaptionWord(fault)
    const left = units.find((unit) => unit.items.includes('1:1'))
    const right = units.find((unit) => unit.items.includes('1:5'))
    assert.ok(left && right)
    if (fault === 'none') {
      assert.equal(left, right)
      assert.match(left.source, /the final calculation of the corresponding reference/u)
      assert.equal(left.fragments.length, 2)
    } else {
      assert.notEqual(left, right)
    }
    assert.ok(units.some((unit) => /^Figure 2: An overview/u.test(unit.source)))
  }
)

function methodNamePageWrap(
  fault: 'none' | 'wrong casing' | 'misaligned folio'
): PdfTranslationLayout['units'] {
  const full = fault === 'wrong casing' ? 'Careflownet' : 'CareFlowNet'
  const pages = [
    [
      item(`The ${full} model was calibrated using the initial records.`, 72, 650, 229),
      item(`We compare the reference values with the ${full} model.`, 72, 638, 229),
      item('A promising route is to modify the Ca-', 311, 119, 229),
      item('1', 303, 89, 6, { hasEOL: false })
    ],
    [
      item('reFlowNet model before comparing it with the reference method.', 72, 655, 229),
      item('We evaluate the modified version across all of the tests.', 72, 643, 229),
      item('It performs consistently when the input settings are stable.', 72, 631, 224),
      item('2', fault === 'misaligned folio' ? 305 : 303, 89, 6, { hasEOL: false })
    ]
  ]
  return groupPdfTranslationPages({
    pages: pages.map((items, n) => ({ page: n + 1, width: 612, height: 792, rotation: 0, items }))
  }).units
}

it.each(['none', 'wrong casing', 'misaligned folio'] as const)(
  'restores an exactly witnessed method name across a numbered page seam (%s)',
  (fault) => {
    const units = methodNamePageWrap(fault)
    const left = units.find((unit) => unit.items.includes('1:2'))
    const right = units.find((unit) => unit.items.includes('2:0'))
    assert.ok(left && right)
    if (fault === 'none') {
      assert.equal(left, right)
      assert.match(left.source, /modify the CareFlowNet model/u)
      assert.deepEqual(
        left.fragments.map((fragment) => fragment.page),
        [1, 2]
      )
    } else {
      assert.notEqual(left, right)
    }
    assert.ok(units.some((unit) => unit.source === '1'))
  }
)

function panelConjunction(
  fault: 'none' | 'missing panel' | 'closed sentence'
): PdfTranslationLayout['units'] {
  const left = 'The procedure cannot show the natural differences and'
  return translationUnits([
    item(
      'The conventional procedure gives a reliable basis for calibrating the equipment.',
      50,
      132,
      236
    ),
    item(fault === 'closed sentence' ? left + '.' : left, 50, 120, 236, { hasEOL: false }),
    item('A smaller note accompanies the source.', 50, 90, 130, { size: 8 }),
    item('(a) Raw signal', 330, 542, 77, { fontName: 'panel', size: 9 }),
    item(fault === 'missing panel' ? '(c) Signal record' : '(b) Signal record', 456, 542, 84, {
      fontName: 'panel',
      size: 9
    }),
    item('Figure 2: Comparison of two views of the same experiment.', 315, 518, 236),
    item('Both views use the same range of values.', 315, 506, 180),
    item('disagreements that are common during the acquisition process.', 315, 484, 236),
    item('The measurements must therefore be collected under normal conditions.', 315, 472, 236),
    item('The reference instrument is calibrated between runs.', 315, 460, 196)
  ])
}

it.each(['none', 'missing panel', 'closed sentence'] as const)(
  'joins a conjoined noun phrase around a verified two-panel figure (%s)',
  (fault) => {
    const units = panelConjunction(fault)
    const left = units.find((unit) => unit.items.includes('1:1'))
    const right = units.find((unit) => unit.items.includes('1:7'))
    assert.ok(left && right)
    if (fault === 'none') {
      assert.equal(left, right)
      assert.match(left.source, /differences and disagreements that are common/u)
      assert.equal(left.fragments.length, 2)
    } else assert.notEqual(left, right)
    assert.ok(units.some((unit) => /^Figure 2:/u.test(unit.source)))
  }
)

function compactTableGerund(
  fault: 'none' | 'displaced score' | 'closed sentence'
): PdfTranslationLayout['units'] {
  return translationUnits([
    item(
      'Several repeated trials produced statistically reliable reference results.',
      52,
      114,
      239
    ),
    item(
      fault === 'closed sentence'
        ? 'The reference is useful for calibration of existing models.'
        : 'The reference is useful as a basis for calibrating and',
      52,
      102,
      239,
      { hasEOL: false }
    ),
    item('Method', 394, 700, 35, { size: 9, hasEOL: false }),
    item('Metric', 458, 700, 30, { size: 9 }),
    item('ModelA', 394, 685, 39, { size: 9, hasEOL: false }),
    item('0.451', 466, 685, 14, { size: 9 }),
    item('ModelB', 394, 673.75, 40, { size: 9, hasEOL: false }),
    item('0.529', fault === 'displaced score' ? 475 : 466, 673.75, 14, { size: 9 }),
    item('ModelC', 394, 662.5, 41, { size: 9, hasEOL: false }),
    item('0.603', 466, 662.5, 14, { size: 9 }),
    item('Table 3: Score from the reference runs.', 350, 643, 182),
    item('testing new, specialized models that capture the response.', 315, 621, 239),
    item('of the reference instrument.', 315, 609, 118)
  ])
}

it.each(['none', 'displaced score', 'closed sentence'] as const)(
  'joins a coordinated gerund below a complete compact table (%s)',
  (fault) => {
    const units = compactTableGerund(fault)
    const left = units.find((unit) => unit.items.includes('1:1'))
    const right = units.find((unit) => unit.items.includes('1:11'))
    assert.ok(left && right)
    if (fault === 'none') {
      assert.equal(left, right)
      assert.match(left.source, /for calibrating and testing new, specialized models/u)
      assert.equal(left.fragments.length, 2)
    } else assert.notEqual(left, right)
    assert.ok(units.some((unit) => /^Table 3:/u.test(unit.source)))
  }
)

it.each(['none', 'no table', 'mismatching reference', 'intervening line', 'unequal width'])(
  'keeps a directly witnessed table caption continuation across columns (%s)',
  (fault) => {
    const table = [
      ['Stage', 'Width', 'Spread'],
      ['Trial A', '250', '20'],
      ['Trial B', '300', '15'],
      ['Trial C', '350', '18'],
      ['Trial D', '400', '22']
    ]
    const caption = item('Table 2. Measured characteristics of the recorded groups.', 60, 80, 236)
    const continuation = item(
      'data for Method A [5] and Method B [8] are listed for',
      333,
      470,
      fault === 'unequal width' ? 200 : 236
    )
    const runs = [
      ...(fault === 'no table'
        ? []
        : table.flatMap((row, n) =>
            row.map((text, col) =>
              item(text, [78, 160, 245][col], 152 - n * 12, col ? 20 : 31, {
                size: 8,
                fontName: 'table',
                hasEOL: col === 2
              })
            )
          )),
      caption,
      item('Every run uses the same normalization procedure for measurements.', 60, 68, 236),
      item('The values are expressed as relative proportions. The', 60, 56, 236),
      ...(fault === 'intervening line' ? [item('A separate note.', 330, 500, 150)] : []),
      continuation,
      item('comparison.', 333, 458, 62),
      item(
        `As compared in Table ${fault === 'mismatching reference' ? 3 : 2}, the apparatus produced equal values.`,
        331,
        434,
        238
      )
    ]
    const units = translationUnits(runs)
    const head = units.find((unit) => unit.items.includes(`1:${runs.indexOf(caption)}`))
    const tail = units.find((unit) => unit.items.includes(`1:${runs.indexOf(continuation)}`))
    assert.ok(head && tail)
    if (fault === 'none') {
      assert.equal(head, tail)
      assert.match(head.source, /The data for Method A/)
      assert.equal(head.fragments.length, 2)
    } else {
      assert.notEqual(head, tail)
    }
    assert.ok(units.some((unit) => /^As compared in Table /u.test(unit.source)))
  }
)

it.each(['none', 'unwitnessed word', 'foreign run', 'unmatched imprint', 'missing panel'])(
  'continues a witnessed word and citation across a column plot on the next page (%s)',
  (fault) => {
    const imprint = (page: number, x: number): PdfLayoutTextItem[] => [
      item('Research', x, 761, 24, { size: 7, fontName: 'imprint', hasEOL: false }),
      item('Proceedings', x + 465, 761, 23, { size: 7, fontName: 'imprint', hasEOL: false }),
      item(String(page), x + 510, 761, 4, { size: 7, fontName: 'imprint', hasEOL: false })
    ]
    const old = [
      ...imprint(2, 54),
      item('The monitoring procedure was carefully repeated across all conditions', 320, 98, 250),
      item('to check the predictive accuracy under realistic input variation and', 320, 86, 250),
      item('to enable reliable signals during each round of response gen-', 320, 74, 250, {
        hasEOL: false
      })
    ]
    const next = [
      ...imprint(3, 48),
      item('(a)', 43, 711, 10, { fontName: 'axis' }),
      ...[5, 10, 15, 20, 25, 30].map((tick, n) =>
        item(String(tick), 80 + 32 * n, 629, 10, { size: 8, fontName: 'axis' })
      ),
      ...(fault === 'missing panel' ? [] : [item('(b)', 43, 602, 10, { fontName: 'axis' })]),
      ...(fault === 'foreign run' ? [item('Another body paragraph.', 44, 550, 170)] : []),
      item('Fig. 4. The signals measured at selected conditions are plotted', 43, 445, 248),
      item('with the corresponding calibration estimate.', 43, 433, 166),
      item('eration [4]. The normalized output level of the system is', 43, 407, 249)
    ]
    if (fault === 'unmatched imprint') next[1].str = 'Appendix'
    const { units } = groupPdfTranslationPages({
      pages: [
        [
          ...imprint(1, 48),
          item(
            fault === 'unwitnessed word'
              ? 'The response improves the reliability of each measurement.'
              : 'The generation of the response improves the reliability of each measurement.',
            45,
            625,
            250
          )
        ],
        old,
        next
      ].map((items, index) => ({ page: index + 1, width: 612, height: 792, rotation: 0, items }))
    })
    const head = units.find((unit) => unit.items.includes('2:5'))
    const tail = units.find((unit) => unit.items.includes(`3:${next.length - 1}`))
    const caption = units.find((unit) => unit.source.startsWith('Fig. 4.'))
    assert.ok(head && tail && caption)
    if (fault === 'none') {
      assert.equal(head, tail)
      assert.deepEqual(
        head.fragments.map((fragment) => fragment.page),
        [2, 3]
      )
      assert.match(head.source, /response generation \[4\]/u)
    } else {
      assert.notEqual(head, tail)
    }
    assert.notEqual(head, caption)
    assert.notEqual(tail, caption)
  }
)

it.each([true, false])(
  'joins across independently owned captions with running title %s',
  (repeat) => {
    const heading = 'Research notes: Estimates at low signal levels'
    const pages = [
      [
        item(
          'Unresolved signals often appear together under controlled measurements',
          320,
          98,
          250
        ),
        item('and can be separated using the procedure outlined in the supplement', 320, 86, 250),
        item('(cf. the earlier discussion and calibration). A no-', 320, 74, 250, { hasEOL: false })
      ],
      [
        item(heading, 153, 728, 306, { size: 9, fontName: 'running' }),
        item('Fig. 1. Comparison of calibrated values under several conditions.', 43, 555, 525),
        item('Fig. 2. The remaining measurements are shown separately.', 43, 380, 425),
        item('table property of noisy estimates is their wider distribution', 43, 352, 250),
        item('in independently collected measurements with lower signal levels,', 43, 340, 250),
        item('consistent with our theoretical prediction for that scenario.', 43, 328, 250)
      ],
      [
        item(repeat ? heading : 'Independent notes: A different set of estimates', 153, 728, 306, {
          size: 9,
          fontName: 'running'
        }),
        item('Independent review of the remaining observations begins here.', 43, 650, 250)
      ]
    ].map((items, index) => ({ page: index + 1, width: 612, height: 792, rotation: 0, items }))
    const { units } = groupPdfTranslationPages({ pages })
    const earlier = units.find((unit) => unit.items.includes('1:2'))
    const later = units.find((unit) => unit.items.includes('2:3'))
    assert.ok(earlier && later)
    assert.equal(earlier === later, repeat)
    if (repeat) assert.match(earlier.source, /A notable property of noisy estimates/u)
    for (const n of [1, 2]) {
      assert.match(
        units.find((unit) => unit.items.includes(`2:${n}`))?.source ?? '',
        new RegExp(`^Fig\\. ${n}\\.`)
      )
    }
  }
)

it.each(['none', 'closed sentence', 'intervening body'])(
  'continues a passive measurement clause after a spanning three-panel figure (%s)',
  (fault) => {
    const first = [
      item(
        'Measurements use a controlled input and calibrated output for all trials.',
        320,
        105,
        250
      ),
      item('The measurements were repeated using the same stable reference value.', 320, 93, 250),
      item(
        fault === 'closed sentence'
          ? 'The estimated sampling delay remains constant.'
          : 'The sampling delay is estimated by',
        320,
        81,
        250,
        { hasEOL: false }
      )
    ]
    const lead = item('recording a fixed response during each controlled trial.', 43, 403, 250)
    const next = [
      item('(a)', 45, 706, 10, { fontName: 'axis' }),
      item('(b)', 338, 704, 10, { fontName: 'axis' }),
      item('(c)', 45, 564, 10, { fontName: 'axis' }),
      ...[5, 10, 15, 20, 25, 30].map((value, n) =>
        item(String(value), 90 + n * 58, 519, 12, { fontName: 'axis', size: 8 })
      ),
      item('Detector', 168, 678, 25, { fontName: 'diagram', size: 8 }),
      ...(fault === 'intervening body'
        ? [item('A separate observation is described here.', 46, 505, 200)]
        : []),
      item('Fig. 3. The panel traces report calibrated response data.', 43, 443, 527),
      item('The curves illustrate both measurements and estimates.', 43, 431, 350),
      lead,
      item('The independent readings were stable at every test setting.', 43, 391, 250),
      item('The combined measurements were fitted to the expression', 43, 379, 247)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [first, next].map((items, i) => ({
        page: i + 1,
        width: 612,
        height: 792,
        rotation: 0,
        items
      }))
    })
    const left = units.find((unit) => unit.items.includes('1:2'))
    const right = units.find((unit) => unit.items.includes(`2:${next.indexOf(lead)}`))
    const figure = units.find((unit) => unit.source.startsWith('Fig. 3.'))
    assert.ok(left && right && figure)
    if (fault === 'none') {
      assert.equal(left, right)
      assert.match(left.source, /estimated by recording a fixed response/u)
      assert.deepEqual(
        left.fragments.map((part) => part.page),
        [1, 2]
      )
    } else {
      assert.notEqual(left, right)
    }
    assert.notEqual(left, figure)
    assert.notEqual(right, figure)
  }
)

it.each([0, 4])('groups a scanned diameter only when the micrometre suffix touches (%d)', (gap) => {
  const items = [
    item('The device records the signal across the surface while scanning', 54, 500, 245),
    item('a 32', 54, 488, 19, { hasEOL: false }),
    item('μ', 77, 488, 6, { fontName: 'greek', hasEOL: false }),
    item('m diameter opening beside the calibrated reference mark.', 83 + gap, 488, 216 - gap)
  ]
  const units = translationUnits(items)
  const owner = units.find((unit) => unit.items.includes('1:2'))!
  if (gap === 0) {
    assert.match(owner.source, /scanning a 32 μm diameter opening/u)
    assert.equal(owner.sourceOnly, undefined)
    assert.deepEqual(owner.items, ['1:0', '1:1', '1:2', '1:3'])
  } else {
    assert.ok(owner.sourceOnly)
    assert.ok(!owner.items.includes('1:3'))
  }
  assert.deepEqual(units.flatMap((unit) => unit.items).sort(), ['1:0', '1:1', '1:2', '1:3'])
})

it.each(['attached', 'detached'] as const)(
  'keeps a wrapped measurement with its native micro prefix and unit suffix (%s)',
  (shape) => {
    const x = shape === 'detached' ? 75 : 71
    const units = translationUnits([
      item('The first sensor was designed to measure wavelengths up to', 54, 500, 245),
      item('16', 54, 489, 10, { hasEOL: false }),
      item('μ', 65, 489, 6, { fontName: 'greek', hasEOL: false }),
      item('m, while the other sensor measures around 25', x, 489, 251 - x, { hasEOL: false }),
      item('μ', 252, 489, 6, { fontName: 'greek', hasEOL: false }),
      item('m reliably.', 258, 489, 41)
    ])
    const owner = units.find((unit) => unit.items.includes('1:2'))
    assert.ok(owner)
    if (shape === 'attached') {
      assert.match(owner.source, /up to 16μm, .*25μm reliably\./u)
      assert.deepEqual(owner.items, ['1:0', '1:1', '1:2', '1:3', '1:4', '1:5'])
    } else {
      assert.equal(owner.sourceOnly, true)
      assert.deepEqual(owner.items, ['1:1', '1:2'])
    }
  }
)

function notationNote(followingX = 59.76): PdfTranslationLayout['units'] {
  const math = { fontName: 'math', hasEOL: false },
    upright = { hasEOL: false },
    italic = { fontName: 'italic', hasEOL: false }
  return translationUnits([
    item(')', 148.95, 365.09, 3.89, math),
    item('/', 156.72, 368.72, 3.88, { ...italic, size: 7.31 }),
    item('4', 160.6, 368.72, 3.88, { fontName: 'script', size: 7.31, hasEOL: false }),
    item('\u0001', 164.94, 373.19, 4.58, { fontName: 'delimiter', hasEOL: false }),
    item('(for these estimates, the', 173.31, 365.09, 86.08, upright),
    item('Q(q)', 263.18, 365.09, 11.11, math),
    item(',', 280.95, 365.09, 2.76, upright),
    item('R', 287.63, 365.09, 7.63, italic),
    item('(r)', 302.2, 365.09, 3.89, math),
    item(', and', 306.09, 365.09, 22.69, upright),
    item('S(', 337.42, 365.09, 3.89, math),
    item('s)', 344.09, 365.09, 3.89, math),
    item('functions assume that', 351.77, 365.09, 97.25, upright),
    item('n', 452.8, 365.09, 4.69, italic),
    item('is a fixed', 461.28, 365.09, 39.96),
    item('integer).', 59.76, 352.67, 43.42),
    item(
      'The estimates are compared against the adjustable measurements at the end of the experiment.',
      75.29,
      340.25,
      425.95
    ),
    item(
      'The resulting intervals agree with the mean reported in the observations.',
      followingX,
      327.83,
      412.39,
      upright
    )
  ])
}

it('keeps a notation note with its short closing line without including the preceding formula', () => {
  const units = notationNote()
  const note = units.find((unit) => unit.source.startsWith('(for these estimates'))
  assert.match(note?.source ?? '', /is a fixed integer\)\.$/u)
  assert.equal(note?.fragments.length, 2)
  assert.equal(note?.items.at(0), '1:4')
  assert.equal(note?.items.at(-1), '1:15')
  assert.ok(units.some((unit) => unit.preserve === 'formula' && unit.items.includes('1:0')))
})

it('keeps the closing line separate when the following paragraph does not return to its rail', () => {
  assert.ok(notationNote(69.76).some((unit) => unit.source === 'integer).'))
})

it.each([
  [false, true],
  [true, false]
])('keeps a wrapped verb with its display introduction (staggered=%s)', (staggered, joins) => {
  const body = { size: 10 },
    math = { ...body, fontName: 'math', hasEOL: false }
  const units = translationUnits([
    item('K(s)', 444, 593, 22, math),
    item('=', 436, 586, 8, { ...body, hasEOL: false }),
    item('s', 449, 579, 9, math),
    item('(6)', 545, 586, 17, body),
    item('The constant K(s) depends solely on the chosen interval.', 317, 563, 245, body),
    item('Then using the boundary estimate in Eq. (4) we', 317, 551.5, 245, body),
    item('get,', 317 + (staggered ? 15 : 0), 540, 16, { ...body, hasEOL: false }),
    item('', 0, 0, 0, { size: 0 }),
    item('∂h', 368, 519, 11, math),
    item('', 0, 0, 0, { size: 0 }),
    item('∂s', 368, 506, 11, math),
    item('= 0', 385, 512, 16, math),
    item('(7)', 545, 512, 17, body)
  ])
  const prose = units.find((unit) => unit.source.includes('boundary estimate'))
  assert.ok(prose)
  assert.equal(prose.source.endsWith('we get,'), joins)
  assert.equal(prose.items.includes('1:6'), joins)
  assert.equal(units.find((unit) => unit.source === '∂h')?.preserve, 'formula')
})

it.each([false, true])(
  'keeps a wrapped angle with its caption when native space is clear (%s)',
  (overlap) => {
    const caption = { size: 9, fontName: 'caption' }
    const run = { ...caption, hasEOL: false }
    const math = { ...run, fontName: 'math' }
    const units = translationUnits([
      {
        ...item('φ', 402, overlap ? 173 : 333, 6, math),
        fontAscent: undefined,
        fontDescent: undefined
      },
      item(
        'FIG. 1: (a) The diagram gives the geometry used for the comparison.',
        317,
        267.5,
        245,
        caption
      ),
      item('(b) Individual marks along the segment can be seen above.', 317, 257, 245, caption),
      item('(c) This view gives the same marks at another scale.', 317, 246.5, 245, caption),
      item(
        '(d) One example showing the marks with the calculated profile.',
        317,
        236,
        245,
        caption
      ),
      item('The profile was obtained by fitting all the measurements.', 317, 225.5, 245, caption),
      item('The reported width is shown together with its fitted range.', 317, 215, 245, caption),
      item('All measurements use the same origin and reference scale.', 317, 204.5, 245, caption),
      item('The fitted profile is used to give the following estimates.', 317, 194, 245, caption),
      item('The procedure gives the length (2', 317, 183.5, 115.4, run),
      item('a', 432.4, 183.5, 2.8, math),
      item('), width (2', 435.2, 183.5, 43.3, run),
      item('b', 478.5, 183.5, 6.6, math),
      item('), orientation angle', 485.1, 183.5, 76.9, caption),
      item('(', 317, 173, 3.6, run),
      item('θ', 320.6, 173, 4.4, math),
      item(') and position (', 325, 173, 63.2, run),
      item('u, v', 388.2, 173, 14, math),
      item(') for every particle.', 402.2, 173, 73, caption)
    ])
    const prose = units.find((unit) => unit.source.startsWith('FIG. 1:'))
    assert.ok(prose)
    assert.equal(
      prose.source.endsWith('angle (θ) and position (u, v) for every particle.'),
      !overlap
    )
    assert.equal(prose.items.includes('1:15'), !overlap)
    assert.ok(units.some((unit) => unit.items.includes('1:0') && !unit.items.includes('1:15')))
  }
)

it.each([false, true])(
  'keeps a selected noun with its wrapped clause (short rail=%s)',
  (shortRail) => {
    const math = { fontName: 'math', hasEOL: false },
      body = { hasEOL: false },
      small = { ...math, size: 7 }
    const units = translationUnits([
      item('The contrast is bounded by the following quantity.', 72, 390, 483),
      item('There are at least', 72, 377, 99, body),
      item('1', 174, 381, 4, small),
      item('', 0, 0, 0, { size: 0 }),
      item('2', 174, 373, 4, small),
      item('|R|', 181, 377, 16, math),
      item('n', 197, 380.5, 5, small),
      item('2', 202, 380, 3, { ...math, size: 5 }),
      item('solutions', 322, 377, 61, body),
      item('g', 389, 377, 5, math),
      item('from A to B.', 400, 377, 83, body),
      item('Pick one such', 487, 377, 68),
      item('solution', 72, 364, 45, body),
      item('g', 121, 364, 5, math),
      item(', and let', 126, 364, 42, body),
      item('f', 172, 364, 5, math),
      item(
        '(x) denote its value for every element of the same fixed domain.',
        177,
        364,
        shortRail ? 360 : 378
      )
    ])
    const owner = units.find((unit) => unit.items.includes('1:11'))
    assert.ok(owner)
    assert.equal(owner.items.includes('1:12'), !shortRail)
    assert.equal(owner.source.includes('Pick one such solution g, and let'), !shortRail)
    assert.equal(owner.fragments.length, shortRail ? 1 : 2)
    assert.ok(!owner.items.includes('1:2'))
  }
)

it.each([false, true])(
  'joins a wrapped word between native folios only on the same rail: %s',
  (shifted) => {
    const imprint = {
      ...item('arXiv: draft imprint', 32, 229, 200, { size: 20, hasEOL: false }),
      transform: [0, 20, -20, 0, 32, 229] as PdfLayoutTextItem['transform']
    }
    const { units } = groupPdfTranslationPages({
      pages: [
        {
          page: 1,
          width: 612,
          height: 792,
          rotation: 0,
          items: [
            imprint,
            item('Calibration and measurement', 56, 650, 275, { size: 14, fontName: 'title' }),
            item(
              'The reviewed measurements agree with all the values reported earlier',
              56,
              162,
              382
            ),
            item('in the experiment, after repeating the complete calibra-', 56, 150, 382),
            item('1', 244.5, 132, 5, { hasEOL: false })
          ]
        },
        {
          page: 2,
          width: 612,
          height: 792,
          rotation: 0,
          items: [
            item('2', shifted ? 65 : 56, 754, 5),
            item(
              'tion procedure across the entire operating range before comparing the',
              56,
              736,
              382
            ),
            item('measurements with the previous estimates.', 56, 724, 195),
            item('This second paragraph describes the equipment independently.', 66, 712, 372),
            item('The recorded values agree with the stated measurement uncertainty.', 56, 700, 382)
          ]
        }
      ]
    })
    const restored = units.find((unit) => unit.items.includes('1:3'))
    assert.equal(restored?.source.includes('complete calibration procedure'), !shifted)
    assert.deepEqual(
      restored?.fragments.map((part) => part.page),
      shifted ? [1] : [1, 2]
    )
    for (const key of ['1:4', '2:0'])
      assert.equal(units.find((unit) => unit.items.includes(key))?.preserve, 'literal')
    assert.ok(units.some((unit) => unit.items.includes('2:3') && !unit.sourceOnly))
  }
)

it.each([false, true])(
  'keeps parallel indexed values together without taking the preceding formula: %s',
  (differentIndex) => {
    const open = { hasEOL: false },
      math = { ...open, fontName: 'math' },
      script = { ...open, fontName: 'script', size: 7 }
    const units = translationUnits([
      item(
        'Earlier calibration data identify the pressure scale and its physical units.',
        54,
        228,
        245
      ),
      item('and', 54, 217, 16, open),
      item('Y', 73, 217, 7.5, math),
      item('0', 80.5, 215.5, 4, script),
      item('= 7', 88, 217, 15.5, open),
      item('×', 104.5, 217, 7.8, math),
      item('10', 113.6, 217, 10, open),
      item('−', 123.6, 220.6, 6.2, script),
      item('3', 129.8, 220.6, 4, script),
      item('m', 134.2, 217, 8.8, math),
      item('2', 143, 220.6, 4, script),
      item('. These are the typical values of', 147.5, 217, 138, open),
      item('X', 288.2, 217, 6.4, math),
      item('0', 294.6, 215.5, 4, script),
      item('', 0, 0, 0, { size: 0 }),
      item('and', 54, 205.5, 16, open),
      item('Y', 73.3, 205.5, 7.5, math),
      item(differentIndex ? '1' : '0', 80.8, 204, 4, script),
      item('[2, 4] used in the measurements.', 88.7, 205.5, 153),
      item('The following table reports the measurements from separate trials.', 64, 194, 235),
      item('The results are listed with their uncertainty.', 54, 182.5, 245)
    ])
    const result = units.find((unit) => unit.items.includes('1:11'))
    assert.equal(result?.source.includes('X0 and Y0 [2, 4]'), !differentIndex)
    assert.equal(result?.fragments.length, differentIndex ? 1 : 2)
    assert.equal(units.find((unit) => unit.items.includes('1:1'))?.preserve, 'formula')
  }
)

it.each([false, true])(
  'joins an open clause across the folio before a numbered display (skipped label=%s)',
  (skipped) => {
    const open = { hasEOL: false }
    const math = { ...open, fontName: 'math' }
    const imprint = {
      ...item('arXiv: draft imprint', 32, 229, 200, { size: 20, hasEOL: false }),
      transform: [0, 20, -20, 0, 32, 229] as PdfLayoutTextItem['transform']
    }
    const { units } = groupPdfTranslationPages({
      pages: [
        {
          page: 1,
          width: 612,
          height: 792,
          rotation: 0,
          items: [
            imprint,
            item('Calibration of an elastic surface', 150, 690, 310, { size: 15 }),
            item('The equipment monitors changes in the elastic material.', 54, 530, 245),
            item('x + y = z', 130, 495, 60, math),
            item('(1)', 286, 495, 13),
            item('We measured the combined response with the same setup.', 54, 451, 245),
            item('The selected range is adequate for the repeat measurements.', 317, 109, 245),
            item('The threshold was determined by the fitted curve in the', 317, 97, 245),
            item('prior test.', 317, 85, 39),
            item('Under normal conditions,', 327, 68, 120, open),
            item(' ', 447, 68, 7, open),
            item('at the free surface the', 454, 68, 108, open)
          ]
        },
        {
          page: 2,
          width: 612,
          height: 792,
          rotation: 0,
          items: [
            item('2', 557, 756, 5),
            item('Shear stress is balanced by the additional restoring force', 54, 730, 245, open),
            item('', 0, 0, 0, { size: 0 }),
            item('x', 123, 706, 7, math),
            item('=', 134, 706, 8, open),
            item('y + z', 146, 706, 27, math),
            item(skipped ? '(3)' : '(2)', 286, 706, 13),
            item('The initial test shows the same trend in the observed data.', 54, 679, 245)
          ]
        }
      ]
    })
    const proof = units.find((unit) => unit.items.includes('1:9'))
    assert.ok(proof)
    assert.equal(proof.items.includes('2:1'), !skipped)
    assert.deepEqual(
      proof.fragments.map((part) => part.page),
      skipped ? [1] : [1, 2]
    )
    assert.equal(units.find((unit) => unit.items.includes('2:6'))?.preserve, 'formula')
    assert.ok(units.find((unit) => unit.items.includes('2:0'))?.sourceOnly)
  }
)

it.each([false, true])(
  'returns a signed setting to its paragraph on the same native rail (shifted=%s)',
  (shifted) => {
    const units = translationUnits([
      item('The cache is initialized before the first measurement has started.', 59, 621, 241),
      item('The program can determine a threshold as it compares the stored', 49, 609, 251),
      item('results with the new samples. It operates in automatic mode when', 49, 597, 251),
      item('the parameter controlling the maximum delay is set', 49, 585, 251),
      item('to -2.', shifted ? 56 : 49, 573, 22),
      item('IV. MEASUREMENT LIMITS', 93, 549, 163),
      item('The first new series is recorded at the same reference temperature.', 59, 527, 241),
      item('Additional trials are needed for further comparisons.', 49, 515, 180)
    ])
    const owner = units.find((unit) => unit.items.includes('1:3'))
    assert.ok(owner)
    assert.equal(owner.items.includes('1:4'), !shifted)
    assert.equal(owner.items.includes('1:5'), false)
  }
)

it.each([false, true])(
  'keeps a wrapped numbered table locator with its prose (displaced marker=%s)',
  (displaced) => {
    const open = { hasEOL: false }
    const units = translationUnits([
      item('The first line introduces an ordinary explanatory paragraph.', 72, 690, 468),
      item('The second line uses the same body font and pair of margins.', 72, 678, 468),
      item('The third line ends the paragraph with punctuation.', 72, 666, 320),
      item('Several earlier outcomes under this condition are summarized.', 72, 420, 468),
      item('α = β − 1', 300, 408, 159, { ...open, fontName: 'math' }),
      item('. Comparing the controls', 459, 408, 81),
      item('keeps the response stable, so all six cases are illustrated in Table', 72, 396, 468),
      item('3, right.', 72, 384, 35, open),
      item(' ', 107, 384, 425, { ...open, size: 0 }),
      item('\x03', displaced ? 517 : 532, 384, 8, { ...open, fontName: 'ending' }),
      item('', 0, 0, 0, { size: 0 }),
      item('Table 3. Measurements across the selected combinations.', 160, 225, 292, {
        fontName: 'caption',
        size: 8
      }),
      item('The final paragraph starts independently below the table.', 72, 175, 468)
    ])
    const paragraph = units.find((unit) => unit.source.startsWith('. Comparing the controls'))
    assert.equal(paragraph?.source.endsWith('Table 3, right.'), !displaced)
    assert.equal(paragraph?.items.includes('1:7'), !displaced)
    assert.ok(units.some((unit) => unit.source === '\x03' && unit.preserve === 'formula'))
  }
)

it.each([false, true])(
  'keeps a wrapped set introduction before its native display (shifted=%s)',
  (shifted) => {
    const body = { size: 12 },
      open = { ...body, hasEOL: false },
      math = { ...open, fontName: 'math' },
      script = { ...math, size: 8 },
      offset = shifted ? 18 : 0
    const units = translationUnits([
      item(
        'The observations are sorted before any measurements are calculated.',
        72,
        699,
        468,
        body
      ),
      item('The same sequence of comparisons is used for all recorded trials.', 72, 685, 468, body),
      item('We retain the resulting records.', 72, 670, 178, body),
      item('We define a planar set', 89, 650, 123, open),
      item('F', 220, 650, 8, math),
      item('β', 228, 648, 4, script),
      item(
        'of all measurement points in the experiment for the selected sequence',
        238,
        650,
        283,
        open
      ),
      item(', as', 521, 650, 19, body),
      item('follows. Let', 72, 635.5, 59, open),
      item('', 0, 0, 0, { size: 0 }),
      item('F', 210 + offset, 621, 8, math),
      item('β', 218 + offset, 619, 4, script),
      item('= {β, 1 + β, 2 + β, …, k − 1 + β}.', 225 + offset, 621, 177, {
        fontName: 'math',
        size: 12
      }),
      item(
        'If the tolerance is small enough, this construction covers the stated interval.',
        90,
        596,
        425,
        body
      ),
      item('This gives an independent bound for the number of test points.', 72, 580, 420, body)
    ])
    const introduction = units.find((unit) => unit.source.startsWith('We define a planar set'))
    assert.equal(introduction?.source.endsWith('as follows. Let'), !shifted)
    assert.equal(introduction?.fragments.length, shifted ? 1 : 2)
    assert.ok(!introduction?.items.includes('1:10'))
    assert.equal(units.find((unit) => unit.items.includes('1:10'))?.preserve, 'formula')
  }
)

it.each([false, true])(
  'keeps a short claim reference beside the proof ending (shifted=%s)',
  (shifted) => {
    const rail = shifted ? 87 : 72
    const open = { hasEOL: false, size: 12 }
    const items = [
      item('The first line introduces an ordinary explanatory paragraph.', 72, 690, 468, {
        size: 12
      }),
      item('The second line uses the same body font and pair of margins.', 72, 675.5, 468, {
        size: 12
      }),
      item('The third line ends the paragraph with punctuation.', 72, 661, 320, { size: 12 }),
      item(
        'Comparing both proposed intervals, the new upper bound is negative, which contradicts',
        72,
        430,
        468,
        { size: 12 }
      ),
      item('Claim 4.', rail, 415.5, 44, open),
      item(' ', rail + 44, 415.5, 5, { ...open, size: 0 }),
      item('\x03', rail + 49, 415.5, 9, { ...open, fontName: 'ending' }),
      item('', 0, 0, 0, { size: 0 }),
      item(
        'Claims 4 and 5 immediately imply that the observed interval is bounded.',
        89,
        395.7,
        451,
        { size: 12 }
      ),
      item('This final line ends the independent paragraph.', 72, 381.2, 275, { size: 12 })
    ]
    const units = translationUnits(items)
    const paragraph = units.find((unit) => unit.source.startsWith('Comparing both'))
    assert.equal(paragraph?.source.endsWith('which contradicts Claim 4.'), !shifted)
    assert.equal(paragraph?.items.includes('1:4'), !shifted)
    assert.ok(units.some((unit) => unit.source === '\x03' && unit.preserve === 'formula'))
  }
)

it.each([false, true])('keeps a dated bullet on its own hanging margin (shifted=%s)', (shifted) => {
  const open = { hasEOL: false }
  const gap = { ...open, size: 0 }
  const units = translationUnits([
    item('The original contract applies to the archive and its staff.', 54, 622, 232),
    item('The project proceeds through the following stages:', 329, 620, 206),
    item('•', 329, 602, 3.5, open),
    item(' ', 332.5, 602, 10.5, gap),
    item('2047: audit the catalog and renew the con-', 343, 602, 204),
    item('tract signed last summer;', 343, 589.5, 80),
    item('•', 329, 577, 3.5, open),
    item(' ', 332.5, 577, 10.5, gap),
    item('2048–2049:', 343, 577, 52, open),
    item(' ', 395, 577, 4, gap),
    item('index the incoming records and', 399, 577, 148),
    item('verify the metadata;', shifted ? 349 : 343, 564.5, 94),
    item('•', 329, 552, 3.5, open),
    item(' ', 332.5, 552, 10.5, gap),
    item('from 2050 onward: provide access to the digital catalog', 343, 552, 204),
    item('and publish regular usage reports for the staff', 343, 539.5, 204)
  ])
  const first = units.find((unit) => unit.items.includes('1:2'))
  const second = units.find((unit) => unit.items.includes('1:6'))
  const third = units.find((unit) => unit.items.includes('1:12'))
  if (shifted) {
    assert.deepEqual(units.find((unit) => unit.items.includes('1:11'))?.items, ['1:11'])
  } else {
    assert.equal(
      first?.source,
      '• 2047: audit the catalog and renew the contract signed last summer;'
    )
    assert.deepEqual(first?.items, ['1:2', '1:4', '1:5'])
    assert.equal(second?.source, '• 2048–2049: index the incoming records and verify the metadata;')
    assert.deepEqual(second?.items, ['1:6', '1:8', '1:10', '1:11'])
  }
  assert.deepEqual(third?.items, ['1:12', '1:14', '1:15'])
})

it.each([0, 4])(
  'preserves paired extrema and their native under-limits (lowered by %s)',
  (shift) => {
    const open = { hasEOL: false }
    const greek = { ...open, fontName: 'variable' }
    const sub = { ...open, fontName: 'script', size: 7.3 }
    const eol = (): PdfLayoutTextItem => item('', 0, 0, 0, { size: 0 })
    const row = (
      y: number,
      v: string,
      d: string,
      bound: string,
      offset = 0
    ): PdfLayoutTextItem[] => {
      const value = (x: number): PdfLayoutTextItem[] => [
        item('φ', x, y, 5.7, greek),
        item('(', x + 5.7, y, 3.9, open),
        item(v, x + 9.6, y, 5, greek),
        item(')', x + 14.8, y, 3.9, open)
      ]
      return [
        item('max', 253, y, 18.6, open),
        eol(),
        item(v, 255, y - 6.66, 4, sub),
        item('∈', 259.2, y - 6.66, 5.2, sub),
        item(d, 264.4, y - 6.66, 5.3, sub),
        ...value(273),
        item('−', 294.8, y, 7.8, { ...open, fontName: 'symbol' }),
        item('min', 305, y, 16.7, open),
        eol(),
        item(v, 306, y - 6.66 - offset, 4, sub),
        item('∈', 310.2, y - 6.66 - offset, 5.2, sub),
        item(d, 315.4, y - 6.66 - offset, 5.3, sub),
        ...value(323),
        item(bound, 345, y, 13)
      ]
    }
    const units = translationUnits([
      item('Under the stated assumptions the results satisfy', 72, 600, 432),
      item('these estimates,', 72, 586, 85),
      ...row(564, 'p', 'D', '< q'),
      item('and', 72, 538, 16, { fontName: 'italic' }),
      ...row(526, 'n', 'H', '< m.', shift),
      item('Proof. This follows by applying the bound to each region.', 72, 503, 459),
      item('The details appear in an independent calculation.', 72, 490, 252)
    ])
    const formulae = units.filter(({ source }) => /^(?:max|[pn]∈)/u.test(source))
    assert.equal(formulae.length, 6)
    for (const owner of formulae) {
      assert.equal(owner.sourceOnly, shift ? undefined : true)
      assert.equal(owner.preserve, shift ? undefined : 'formula')
    }
    assert.equal(units.find(({ source }) => source === 'and')?.sourceOnly, undefined)
  }
)

it.each([0, 3])('keeps a wrapped product index beside its bracket (shifted by %s)', (shift) => {
  const open = { size: 9, hasEOL: false }
  const variable = { ...open, fontName: 'variable' }
  const sub = { ...open, fontName: 'subscript', size: 6 }
  const units = translationUnits([
    item('Abstract', 286, 466.5, 40, { size: 9, fontName: 'bold' }),
    item('The isolated region is a subset of [', 172.4, 451.6, 239.2, open),
    item('r', 411.6, 451.6, 4.8, variable),
    item('1', 416.4, 450.6, 3.65, sub),
    item(']', 420.6, 451.6, 2.6, open),
    item('× · · · ×', 424.6, 451.6, 28, { size: 9, fontName: 'operator' }),
    item('[', 158.6, 440.7, 2.5, open),
    item('r', 161.1, 440.7, 4.8, variable),
    item('m', 165.9, 439.6 - shift, 3.8, sub),
    item('], whose boundary belongs to the transformed space', 170.3, 440.7, 282.3, { size: 9 })
  ])
  const prose = units.find(({ source }) => source.startsWith('The isolated region'))
  assert.equal(prose?.source.includes('× [rm], whose'), shift === 0)
  assert.equal(prose?.items.includes('1:8'), shift === 0)
  assert.equal(
    units.some(({ source, preserve }) => source === '[rm' && preserve === 'formula'),
    shift > 0
  )
})

it.each(['matching front matter', 'different subject'] as const)(
  'keeps the noun of the centered title with its designation: %s',
  (variant) => {
    const draft = { size: 8, hasEOL: false }
    const title = { fontName: 'title' }
    const author = { size: 9, hasEOL: false }
    const line = item('', 0, 0, 0, { size: 0 })
    const number = { size: 6, hasEOL: false }
    const head = 'Independent tests reveal systematic noise in measurements made with class II'
    const units = translationUnits([
      item('Draft version April 5, 2025', 60, 733, 130, draft),
      line,
      item('Typeset using LATEX default style in ArticleTools', 60, 724, 141, {
        ...draft,
        fontName: 'small'
      }),
      line,
      item(head, 68, 676, 476, title),
      item('sensors', 278, 663.5, 56, { ...title, hasEOL: false }),
      line,
      item('Ann Reader', 267, 643.5, 61, author),
      item('1', 337, 647.3, 3.5, number),
      line,
      item('1', 128, 629.5, 3.6, { ...number, fontName: 'affiliation-marker' }),
      item('Institute of Field Measurements and Applied Instrumentation', 132, 626.5, 348, {
        size: 8,
        fontName: 'affiliation',
        hasEOL: false
      }),
      line,
      item('ABSTRACT', 278, 602, 56),
      item(
        variant === 'matching front matter'
          ? 'The class II sensors record a repeatable response in all independent trials.'
          : 'The selected instruments record a repeatable response in all independent trials.',
        93,
        586.5,
        433
      ),
      item('The reported data agree closely with the independent control experiment.', 85, 574, 442)
    ])
    const joined = variant === 'matching front matter'
    const headline = units.find((unit) => unit.items.includes('1:4'))
    assert.equal(headline?.source, joined ? head + ' sensors' : head)
    assert.deepEqual(headline?.items, joined ? ['1:4', '1:5'] : ['1:4'])
    assert.equal(headline?.fragments.length, joined ? 2 : 1)
    assert.ok(
      units.some((unit) => unit.items.includes('1:7') && unit.source.startsWith('Ann Reader'))
    )
  }
)

it.each(['same catalog', 'different catalog'] as const)(
  'joins a preprint title before its catalog designation: %s',
  (variant) => {
    const title = { fontName: 'title', size: 12 }
    const author = { fontName: 'byline', size: 10.9, hasEOL: false }
    const marker = { ...author, size: 8 }
    const affiliation = { fontName: 'affiliation', size: 10, hasEOL: false }
    const affiliationMarker = { ...affiliation, size: 7, fontName: 'affiliation-marker' }
    const line = item('', 0, 0, 0, { size: 0 })
    const head = 'Slow Gas Exchange Enriches Matter in a Galaxy Group Housing QSO'
    const tail = 'OBJ1234−567 and Ambient Clouds'
    const units = translationUnits([
      item('Draft version April 5, 2025', 51, 728, 166, { hasEOL: false }),
      line,
      item('Typeset using LATEX preprint style in ArticleTools', 51, 714, 227, {
        hasEOL: false
      }),
      line,
      item(head, 60.3, 666, 492, title),
      item('OBJ1234', 199, 651, 54, { ...title, hasEOL: false }),
      item('−', 253, 651, 9.3, { ...title, fontName: 'symbol', hasEOL: false }),
      item('567 and Ambient Clouds', 262.3, 651, 151.2, { ...title, hasEOL: false }),
      line,
      item('Ann M. Reader', 125.1, 632.4, 80.3, author),
      item(',', 216.4, 632.4, 3.4, author),
      item('1, 2', 219.8, 636.4, 12.8, marker),
      item('Robin Q. Writer', 237.2, 632.4, 99, author),
      item(',', 347.2, 632.4, 3.5, author),
      item('2', 350.7, 636.4, 4.4, marker),
      item('and Lee Editor', 359.7, 632.4, 106, author),
      item('2', 476.5, 636.4, 4.4, marker),
      line,
      item('1', 140.6, 617, 4, affiliationMarker),
      item('Department of Applied Studies, North Campus', 145.1, 613.4, 323, affiliation),
      line,
      item('2', 111.3, 603, 4, affiliationMarker),
      item(
        'Institute for Measurements and Instrumentation, Central Campus',
        115.8,
        599.4,
        381.5,
        affiliation
      ),
      line,
      item('ABSTRACT', 273, 572, 66, { size: 12 }),
      item(
        'The experimental records around QSO ' +
          (variant === 'same catalog' ? 'OBJ1234−567' : 'OBJ9876−123') +
          ' show stable properties.',
        93.6,
        554.7,
        433.4,
        { size: 12 }
      ),
      item(
        'Independent trials corroborated the main observation in all conditions.',
        84.6,
        539.7,
        442.4,
        { size: 12 }
      )
    ])
    const merged = variant === 'same catalog'
    const titleOwner = units.find((unit) => unit.items.includes('1:4'))
    assert.equal(titleOwner?.source, merged ? head + ' ' + tail : head)
    assert.equal(titleOwner?.fragments.length, merged ? 2 : 1)
    assert.equal(titleOwner?.items.includes('1:9'), false)
  }
)

it.each(['none', 'gap', 'closed', 'foreign run', 'unit suffix', 'new rail', 'baseline'] as const)(
  'keeps a full-width paragraph with its compact closing measurement (%s)',
  (fault) => {
    const items = [
      item('The instrument records a stable value through the calibration interval.', 52, 550, 504),
      item(
        'The detector samples the output until the reference level becomes stable.',
        52,
        537.5,
        504
      ),
      item(
        fault === 'closed'
          ? 'The response is stable after the second pass.'
          : 'At the final sampling point, the reference response is approximately',
        52,
        525,
        504
      ),
      item('∼', fault === 'new rail' ? 72 : 52, 512.5, 8, {
        fontName: 'relation',
        hasEOL: false
      }),
      item('36', 63, 512.5, 10, { hasEOL: false }),
      item('μ', 76, fault === 'baseline' ? 514.5 : 512.5, 6, {
        fontName: 'greek',
        hasEOL: false
      }),
      item(fault === 'unit suffix' ? 'x.' : 'V.', 82, 512.5, 11),
      item('Further calibration uses a separate sensor and a reference standard.', 61, 500, 495),
      item('The comparison is repeated once to confirm the response interval.', 52, 487.5, 504)
    ]
    if (fault === 'gap') for (const run of items.slice(3)) run.transform[5] -= 6
    const quantity = items[3]
    const newParagraph = items[7]
    if (fault === 'foreign run') {
      items.splice(3, 0, item('x = y', 310, 515, 25, { fontName: 'formula' }))
    }
    const units = translationUnits(items)
    const before = units.find((unit) => unit.items.includes('1:2'))
    const after = units.find((unit) => unit.items.includes('1:' + items.indexOf(quantity)))
    const next = units.find((unit) => unit.items.includes('1:' + items.indexOf(newParagraph)))
    assert.ok(before && after && next)
    assert.notEqual(before, next)
    if (fault === 'none') {
      assert.equal(before, after)
      assert.equal(before.sourceOnly, undefined)
      assert.match(before.source, /approximately ∼ 36 μV\.$/u)
      assert.deepEqual(before.items, ['1:0', '1:1', '1:2', '1:3', '1:4', '1:5', '1:6'])
      assert.equal(before.fragments.length, 1)
      assert.equal(before.fragments[0].rect.bottom, 282)
    } else {
      assert.notEqual(before, after)
    }
  }
)

it.each([false, true])(
  'keeps a same-row decibel measurement with its wrapped prose word (detached=%s)',
  (detached) => {
    const run = (
      text: string,
      x: number,
      y: number,
      width: number,
      hasEOL = false,
      fontName = 'body'
    ): PdfLayoutTextItem => ({
      ...item(text, x, y, width, { size: 9, hasEOL, fontName }),
      fontAscent: 0,
      fontDescent: 0
    })
    const units = translationUnits([
      run('The baselines were established by independent calibration', 318, 249, 241, true),
      run('and checked before the final sequence was measured.', 318, 238, 241, true),
      run('The values were collected without a separate adjustment.', 318, 227, 241, true),
      run('All supporting estimates were recorded.', 318, 216, 111, true),
      run('The instrument improved on', 328, 205, 110),
      run('9 of 9 samples', 441, 205, 51, false, 'bold'),
      run('against both base-', 495, 205, 65, true),
      run('lines (', 318, 194, 23),
      run('+', 341, 194, 6, false, 'math'),
      run('8', 347, 194, 4, false, 'digit'),
      run('.', 351, 194, 2, false, 'dot'),
      run('6', 353.2, 194, 4, false, 'digit'),
      run('dB over the control,', detached ? 371 : 359, 194, 65),
      run('+', 426, 194, 6, false, 'math'),
      run('10', 432, 194, 8.5, false, 'digit'),
      run('.', 440.5, 194, 2, false, 'dot'),
      run('1', 442.5, 194, 4, false, 'digit'),
      run('dB over the comparison) with a lower', 448, 194, 111, true),
      run('measurement error. The independent estimate closely', 318, 183, 241, true),
      run('agreed with the values from the longer setup and its', 318, 172, 241, true),
      run('reference model after the data were pooled.', 318, 161, 168, true)
    ])
    const owner = units.find((unit) => unit.items.includes('1:4'))!
    assert.equal(owner.source.includes('baselines (+8.6 dB over the control'), !detached)
    assert.equal(owner.items.includes('1:7'), !detached)
    assert.equal(owner.items.includes('1:12'), !detached)
    assert.equal(owner.fragments.length, detached ? 1 : 3)
    assert.equal(
      units.some((unit) => unit.sourceOnly && unit.items.includes('1:7')),
      detached
    )
  }
)

it.each(['raised', 'flat', 'separate word'])(
  'joins a spacing acute inside a cover name (%s)',
  (shape) => {
    const body = { size: 10, hasEOL: false }
    const units = translationUnits([
      item('AN ILLUSTRATIVE TEST OF AN INDEPENDENT RESULT', 88, 728, 420, {
        fontName: 'title',
        size: 12
      }),
      item('TEST READER AND SOL ', 168, 698, 117.2, body),
      item('´', 285.2, shape === 'flat' ? 698 : 700.5, 5, body),
      item('ARIA DE SILVA', shape === 'separate word' ? 289 : 283.75, 698, 143.3, body),
      item('Abstract.', 108, 669, 51.2, { fontName: 'heading', size: 10 }),
      item('The independent comparison confirms the stated result.', 108, 654, 295)
    ])
    const byline = units.find((unit) => unit.items.includes('1:1'))
    assert.equal(byline?.source === 'TEST READER AND SOLÁRIA DE SILVA', shape === 'raised')
    if (shape === 'raised') {
      assert.deepEqual(
        byline?.items
          .map((key, index) => [key, byline.originalStrings[index]])
          .sort(([a], [b]) => a.localeCompare(b)),
        [
          ['1:1', 'TEST READER AND SOL '],
          ['1:2', '´'],
          ['1:3', 'ARIA DE SILVA']
        ]
      )
    }
  }
)

it.each(['connected', 'unrelated transitions', 'reversed thresholds'])(
  'keeps aligned threshold descriptions on separate bullet rows (%s)',
  (shape) => {
    const firstLabel = 'm: AB16 to CD8 transition.'
    const secondLabel =
      shape === 'unrelated transitions'
        ? 'm: XY8 to EF4 per-channel transition.'
        : 'm: CD8 to EF4 per-channel transition.'
    const row = (index: number, y: number, value: string, label: string): PdfLayoutTextItem[] => {
      const bullet = { size: 9, fontName: 'bullet', hasEOL: false }
      const math = { ...bullet, fontName: 'math' }
      const digits = { ...bullet, fontName: 'digits' }
      const subscript = { ...digits, size: 6.6 }
      const equals = { ...bullet, fontName: 'equals' }
      return [
        item('•', 334, y, 4.5, bullet),
        { ...item(' ', 338.5, y, 3.5, bullet), height: 0 },
        item('𝑟', 342, y, 4.4, math),
        item(String(index), 346.7, y - 1.35, 3.05, subscript),
        { ...item(' ', 349.75, y - 1.35, 2.95, subscript), height: 0 },
        item('=', 352.7, y, 5.7, equals),
        { ...item(' ', 358.4, y, 2.1, equals), height: 0 },
        item(value, 360.5, y, 8.3, digits),
        { ...item(' ', 368.8, y, 2.25, digits), height: 0 },
        item(label, 371.05, y, index === 0 ? 98 : 140, { size: 9, hasEOL: index === 1 })
      ]
    }
    const units = translationUnits([
      item('Two optional modes are available for every test configuration.', 318, 625, 238, {
        size: 9,
        hasEOL: false
      }),
      item('Default measurement thresholds:', 328, 599, 111, { size: 9, hasEOL: false }),
      ...row(0, 584.6, '20', firstLabel),
      ...row(1, 573.6, shape === 'reversed thresholds' ? '10' : '60', secondLabel),
      item('These bounds can be calibrated for the selected environment.', 328, 559, 230, {
        size: 9
      }),
      item('Select a matching profile before checking the measurements.', 318, 548, 233, {
        size: 9,
        hasEOL: false
      })
    ])
    const labels = units.filter(
      (unit) => unit.items.includes('1:11') || unit.items.includes('1:21')
    )
    assert.deepEqual(
      labels.map((unit) => unit.source),
      shape === 'connected' ? [firstLabel, secondLabel] : [firstLabel + ' ' + secondLabel]
    )
    assert.deepEqual(
      labels.flatMap((unit) => unit.items),
      ['1:11', '1:21']
    )
    assert.equal(units.filter((unit) => unit.sourceOnly && unit.source.startsWith('• ')).length, 2)
  }
)

it.each(['known journal', 'complete locator', 'year alone', 'number gap', 'off rail'])(
  'retains a hanging reference tail with a witnessed journal name or locator (%s)',
  (shape) => {
    const base = { size: 8 }
    const run = { ...base, hasEOL: false }
    const journal = { ...run, fontName: 'journal' }
    const indent = shape === 'off rail' ? 150 : 139.8
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
              'Several measurements support the claim when independently calibrated.',
              126.7,
              201.8,
              350
            ),
            item('References', 277.1, 181.5, 57.8, { fontName: 'heading', hasEOL: false }),
            item('[1] A. Reader. Methods for independent measurement.', 126.7, 165.6, 211, run),
            item(
              ['complete locator', 'year alone', 'number gap'].includes(shape)
                ? 'Journal of Applied Methods'
                : 'Journal of Applied Samples',
              339.1,
              165.6,
              143.8,
              journal
            ),
            item(',', 482.9, 165.6, 2.4, base),
            item('12(1):8–32, 2004.', 139.8, 155.6, 79.8, base),
            item('[2] D. Editor. Follow-up experiments.', 126.7, 145.6, 203.4, run),
            item('Review of Experimental Examples', 332.2, 145.6, 150.6, journal),
            item(',', 482.9, 145.6, 2.4, base),
            item('2006.', 139.8, 135.6, 19.2, base),
            item('[3] J. Writer. Further checks of observed results.', 126.7, 125.6, 253.7, run),
            item('Journal of Applied', 380.4, 125.6, 104.8, { ...journal, hasEOL: true }),
            item('Samples', indent, 115.6, 30.3, journal),
            item(
              shape === 'year alone' ? ', 2002.' : ', 65(3):81–94, 2002.',
              indent + 30.3,
              115.6,
              85.2,
              base
            ),
            item(
              shape === 'number gap'
                ? '[5] G. Reviewer. Extending the earlier approach.'
                : '[4] G. Reviewer. Extending the earlier approach.',
              126.7,
              105.6,
              237.4,
              run
            ),
            item('Review of Experimental Exam-', 366.7, 105.6, 118.5, { ...journal, hasEOL: true }),
            item('ples', 139.8, 95.6, 36.6, journal),
            item(', 2009.', 176.4, 95.6, 24.4, base),
            item('1', 304, 82, 4, { size: 7, hasEOL: false })
          ]
        }
      ]
    })
    const wrap = units.find((unit) => unit.items.includes('1:12'))
    assert.deepEqual(wrap?.items, ['1:12', '1:13'])
    assert.equal(
      Boolean(wrap?.sourceOnly),
      shape === 'known journal' || shape === 'complete locator'
    )
    const hyphenated = units.find((unit) => unit.items.includes('1:16'))
    assert.deepEqual(hyphenated?.items, ['1:16', '1:17'])
    if (shape === 'known journal') assert.equal(hyphenated?.sourceOnly, true)
  }
)

it.each([true, false])('retains a journal continuation with a styled volume (%s)', (aligned) => {
  const normal = { size: 9 }
  const italic = { ...normal, fontName: 'italic' }
  const left = aligned ? 77.7 : 89
  const { units } = groupPdfTranslationPages({
    pageCount: 1,
    pages: [
      {
        page: 1,
        width: 612,
        height: 792,
        rotation: 0,
        items: [
          item('References', 277, 682, 58, { fontName: 'heading', hasEOL: false }),
          item(
            '[1] A. Reed, Field stability, Example Studies 4 (1998), 3–6.',
            73,
            667,
            326,
            normal
          ),
          item(
            '[2] J. Perez, A comparison of the first and second instrument settings,',
            73,
            656,
            432,
            { ...normal, hasEOL: false }
          ),
          item('J. Appl.', 510, 656, 45, italic),
          item('Methods Ser. B', left, 645, 57.5, { ...italic, hasEOL: false }),
          item('21', left + 60.5, 645, 10.6, { ...normal, fontName: 'bold', hasEOL: false }),
          item('(1988), 28–34.', left + 74.3, 645, 56.6, normal),
          item('[3] D. Reid, Controls, Example Letters 9 (2002), 7–8.', 73, 634, 375, normal)
        ]
      }
    ]
  })
  const wrap = units.find((unit) => unit.items.includes('1:4'))
  assert.deepEqual(wrap?.items, ['1:4', '1:5', '1:6'])
  assert.equal(wrap?.preserve, aligned ? 'reference' : undefined)
  assert.equal(Boolean(wrap?.sourceOnly), aligned)
})

it.each([
  { variable: '𝜑𝜑', fontName: 'math', joined: true },
  { variable: '𝜑𝜒', fontName: 'math', joined: false },
  { variable: '𝜑𝜑', fontName: 'body', joined: false }
])(
  'keeps a wrapped variable with its noun when the math run is unambiguous: $variable $fontName',
  ({ variable, fontName, joined }) => {
    const units = translationUnits([
      item('The controller records the latest setting from the active sensor.', 58, 702, 267),
      item('The reconstructed value of the sensor signal’s steady-state phase angle', 58, 690, 267),
      item('(', 58, 676, 3.3, { hasEOL: false }),
      item(variable, 63, 676, 5.6, { fontName, hasEOL: false }),
      item(') is displayed in the overview panel for comparison with the', 70.7, 676, 254.3),
      item('remaining readings. Results are saved at the end of the session.', 58, 664, 262)
    ])
    const prose = units.find((unit) => unit.items.includes('1:1'))
    assert.equal(
      [2, 3, 4].every((index) => prose?.items.includes(`1:${index}`)),
      joined
    )
    if (joined) {
      assert.equal(prose?.sourceOnly, undefined)
      assert.ok(prose?.source.includes(`angle ( ${variable} ) is displayed`))
    }
    const owned = units.flatMap((unit) => unit.items)
    assert.deepEqual(owned.sort(), ['1:0', '1:1', '1:2', '1:3', '1:4', '1:5'])
  }
)

it.each(['aligned', 'different rail', 'loose pitch'])(
  'joins a footnote conclusion after its native math (%s)',
  (shape) => {
    const body = { size: 8.73, hasEOL: false }
    const formula = { ...body, fontName: 'math', size: 10.91 }
    const delimiter = { ...formula, fontName: 'large' }
    const script = { ...body, fontName: 'small', size: 7.636 }
    const units = translationUnits([
      item('The expressions agree when substituting the selected values.', 72, 145, 450, {
        size: 11
      }),
      item('1', 61.7, 98.4, 4.35, script),
      item('Compute', 72, 94.44, 34, body),
      item('u + v =', 124, 94.44, 35, formula),
      item('(', 355, 103.32, 5, delimiter),
      item('k', 360, 99.36, 5.39, { ...script, hasEOL: true }),
      item('s', 360.6, 90.72, 4.05, script),
      item(')', 365.4, 103.32, 5, delimiter),
      item('and then apply the counting', 421.2, 94.44, 118.73, {
        ...body,
        hasEOL: true
      }),
      item(
        'lemma once.',
        shape === 'different rail' ? 79 : 72,
        shape === 'loose pitch' ? 75 : 79.2,
        59.45,
        body
      ),
      item('1', 303.8, 62, 5, script)
    ])
    const owner = units.find((unit) => unit.items.includes('1:8'))!
    const joined = shape === 'aligned'
    assert.equal(
      owner.source,
      joined ? 'and then apply the counting lemma once.' : 'and then apply the counting'
    )
    assert.deepEqual(owner.items, joined ? ['1:8', '1:9'] : ['1:8'])
    assert.equal(owner.fragments.length, joined ? 2 : 1)
    assert.ok(units.find((unit) => unit.items.includes('1:6'))?.sourceOnly)
  }
)

it.each(['same row', 'different baseline', 'large gap'])(
  'joins a native condition to its upper bound in running prose (%s)',
  (shape) => {
    const body = { size: 10.91, hasEOL: false }
    const units = translationUnits([
      item('The preceding formula gives a reliable estimate.', 72, 524, 420, { size: 10.91 }),
      item('The claim applies.', 72, 510.55, 83, { size: 10.91 }),
      item('For', 88.94, 497, 15.94, body),
      item('q', 108.25, 497, 6.55, { ...body, fontName: 'variable' }),
      item('≤', 117.83, 497, 8.49, { ...body, fontName: 'operator' }),
      item(
        '6, the maximum value of ',
        shape === 'large gap' ? 141 : 129.35,
        shape === 'different baseline' ? 495 : 497,
        124,
        body
      ),
      item('Q', 253.35, 497, 7, { ...body, fontName: 'variable' }),
      item('in the inspected region is attained when', 265, 497, 275, { size: 10.91 }),
      item(
        'the first condition holds for every selected observation. For the alternative',
        72,
        483.45,
        463,
        {
          size: 10.91
        }
      ),
      item('case the conclusion follows from the same comparison and yields 5.', 72, 469.9, 368, {
        size: 10.91
      }),
      item('The recorded measurements agree at the reported resolution.', 89, 456.35, 327, {
        size: 10.91
      })
    ])
    const owner = units.find((unit) => unit.items.includes('1:2'))!
    const joined = shape === 'same row'
    assert.equal(owner.source.startsWith('For q ≤ 6, the maximum value'), joined)
    assert.deepEqual(
      owner.items,
      joined ? ['1:2', '1:3', '1:4', '1:5', '1:6', '1:7', '1:8', '1:9'] : ['1:2', '1:3', '1:4']
    )
    assert.equal(units.flatMap((unit) => unit.items).length, 11)
    assert.equal(new Set(units.flatMap((unit) => unit.items)).size, 11)
  }
)

it.each(['aligned', 'shifted'])(
  'rejoins a split run-in acknowledgment before the next field (%s)',
  (shape) => {
    const label = { fontName: 'label', size: 12, hasEOL: false }
    const units = translationUnits([
      item('The sample data were obtained using an independent instrument.', 320, 530, 241),
      item('A separate calibration confirms the instrument response.', 320, 517.5, 210),
      item('Acknowledgments:', 320, 492, 92, label),
      item('The test data were ob-', 421, 492, 140),
      item(
        'tained over two weeks with help from the survey team.',
        shape === 'shifted' ? 326 : 320,
        479.5,
        shape === 'shifted' ? 235 : 241
      ),
      item('The equipment', 320, 467, 87, { hasEOL: false }),
      item('was supplied by two research partners', 414, 467, 147),
      item('under a shared grant.', 320, 454.5, 101),
      item('Facilities:', 320, 436, 46, label),
      item('Optical bench and a field sensor.', 371, 436, 155)
    ])
    const acknowledgment = units.find((unit) => unit.items.includes('1:2'))
    const joins = shape === 'aligned'
    assert.deepEqual(
      acknowledgment?.items,
      joins ? ['1:2', '1:3', '1:4', '1:5', '1:6', '1:7'] : ['1:2', '1:3']
    )
    assert.equal(acknowledgment?.source.includes('were obtained over two weeks'), joins)
    assert.equal(acknowledgment?.items.includes('1:8'), false)
  }
)

it.each([0, 8])('rejoins a wrapped keyword category on its native rail (offset=%s)', (offset) => {
  const units = translationUnits([
    item('Keywords:', 85, 567, 44, { fontName: 'label', hasEOL: false }),
    item('imaging systems: test data, sensor calibration, tech-', 133, 567, 392),
    item('niques: spectroscopic', 133 + offset, 555, 90),
    item(
      'The test records reveal smooth changes in the optical signal over each cycle.',
      54,
      540,
      482
    ),
    item(
      'The repeated measurements follow a similar distribution across all stations.',
      54,
      528,
      482
    )
  ])
  const keywords = units.find((unit) => unit.items.includes('1:0'))
  assert.equal(keywords?.source.endsWith('techniques: spectroscopic'), offset === 0)
  assert.equal(keywords?.items.includes('1:2'), offset === 0)
  assert.equal(keywords?.items.includes('1:3'), false)
  assert.deepEqual(units.flatMap((unit) => unit.items).sort(), ['1:0', '1:1', '1:2', '1:3', '1:4'])
})

it.each([0, 3])('keeps a wrapped year range and citation in prose (shift=%s)', (shift) => {
  const inline = { hasEOL: false, size: 12 }
  const units = translationUnits([
    item('The measurements from several field stations were first recorded in the', 62, 614, 490, {
      size: 12
    }),
    item('1986-1988', 62 + shift, 600, 51, inline),
    item('separately', 119 + shift, 600, 51, inline),
    item('from', 176 + shift, 600, 23, inline),
    item('(', 205 + shift, 600, 4, inline),
    item(
      '3) using distinct sensors and the readings were logged each day.',
      209 + shift,
      600,
      343 - shift,
      { size: 12 }
    ),
    item('The resulting records are consistent with the independent controls.', 62, 586, 474, {
      size: 12
    })
  ])
  const owner = units.find((unit) => unit.items.includes('1:0'))
  const indices = ['1:1', '1:2', '1:3', '1:4', '1:5']
  assert.equal(
    indices.every((index) => owner?.items.includes(index)),
    shift === 0
  )
  if (!shift)
    assert.match(owner?.source ?? '', /in the 1986-1988 separately from \(3\) using distinct/)
  assert.deepEqual(units.flatMap((unit) => unit.items).sort(), ['1:0', ...indices, '1:6'])
})

it.each([0, 4])(
  'joins a qualified year across an alternating opening folio (shift=%s)',
  (shift) => {
    const rotated = item('Height', 170, 436, 30, { fontName: 'axis' })
    rotated.transform = [0, 10, -10, 0, 170, 436]
    const result = groupPdfTranslationPages({
      pages: [
        {
          page: 1,
          width: 612,
          height: 792,
          rotation: 0,
          items: [
            item('1', 64, 740, 5),
            rotated,
            item(
              'Reliable survey records are available from all the stations along the main branch.',
              71,
              124,
              481
            ),
            item(
              'They describe several separate campaigns documented in the regional collection.',
              62,
              111.5,
              490
            ),
            item('The most complete observations were made near the lower station in', 62, 99, 490)
          ]
        },
        {
          page: 2,
          width: 612,
          height: 792,
          rotation: 0,
          items: [
            item('2', 547, 740, 5),
            item('1974', 62 + shift, 717, 20, { hasEOL: false }),
            item('±', 82.2 + shift, 717, 7.8, { hasEOL: false, fontName: 'math' }),
            item(
              '4, having followed the earlier protocols approved for the whole region.',
              90 + shift,
              717,
              462 - shift
            ),
            item('The records are available to other researchers on request.', 62, 704.5, 403)
          ]
        }
      ]
    })
    const owner = result.units.find((unit) => unit.items.includes('1:4'))
    assert.equal(owner?.items.includes('2:1'), shift === 0)
    if (!shift) assert.match(owner?.source ?? '', /station in 1974±4, having followed/u)
    assert.equal(result.units.find((unit) => unit.items.includes('2:0'))?.source, '2')
    assert.equal(result.units.find((unit) => unit.items.includes('1:1'))?.source, 'Height')
    assert.equal(owner?.items.includes('2:0'), false)
  }
)

it.each([false, true])(
  'keeps a terminal preposition with its quantifier (misaligned=%s)',
  (misaligned) => {
    const run = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      size: number,
      hasEOL = false
    ): PdfLayoutTextItem => item(str, x, y, width, { fontName, size, hasEOL })
    const items = [
      run('toward the marked zone [', 72, 214.019, 95.004, 'Body', 9.963),
      run('j', 167.004, 214.019, 4.151, 'Variable', 9.963),
      run(']', 171.156, 214.019, 2.768, 'Body', 9.963),
      run('±', 173.926, 217.635, 6.227, 'Symbol', 6.974),
      run(
        '. We verify that the estimate from the experiment is stable conditional on the state Ψ',
        180.65,
        214.019,
        298.903,
        'Body',
        9.963
      ),
      run('[', 479.551, 212.22, 2.255, 'Lower', 6.974),
      run('j', 481.806, 212.22, 3.335, 'LowerVariable', 6.974),
      run(']', 485.141, 212.22, 2.255, 'Lower', 6.974),
      run('d', 487.397, 214.213, 3.235, 'Tiny', 4.981),
      run(' ', 490.632, 214.213, 4.56, 'Tiny', 0),
      run('=', 495.192, 214.019, 7.749, 'Body', 9.963),
      run(' ', 502.941, 214.019, 3.567, 'Body', 0),
      run('ω', 506.508, 214.019, 5.693, 'Variable', 9.963),
      run('[', 512.197, 212.22, 2.255, 'Lower', 6.974),
      run('j', 514.452, 212.22, 3.335, 'LowerVariable', 6.974),
      run(']', 517.787, 212.22, 2.255, 'Lower', 6.974),
      run('d', 520.043, 214.213, 3.235, 'Tiny', 4.981),
      run(' ', 523.278, 214.213, 4.795, 'Tiny', 0),
      run('for', 528.073, 214.019, 11.928, 'Body', 9.963, true),
      run('any', misaligned ? 78 : 72, 202.064, 15.496, 'Body', 9.963),
      run(' ', 87.496, 202.064, 2.959, 'Body', 0),
      run('ω', 90.455, 202.064, 5.693, 'Variable', 9.963),
      run('[', 96.148, 200.265, 2.255, 'Lower', 6.974),
      run('j', 98.403, 200.265, 3.335, 'LowerVariable', 6.974),
      run(']', 101.738, 200.265, 2.255, 'Lower', 6.974),
      run('d', 103.994, 202.258, 3.235, 'Tiny', 4.981),
      run(' ', 107.229, 202.258, 0.996, 'Tiny', 0),
      run(
        ', giving the expected quantity after averaging. For any',
        108.225,
        202.064,
        332,
        'Body',
        9.963
      ),
      run(' ', 440.225, 202.064, 2.959, 'Body', 0),
      run('ω', 443.184, 202.064, 5.693, 'Variable', 9.963),
      run('[', 448.879, 200.265, 2.255, 'Lower', 6.974),
      run('j', 451.134, 200.265, 3.335, 'LowerVariable', 6.974),
      run(']', 454.469, 200.265, 2.255, 'Lower', 6.974),
      run('d', 456.725, 202.258, 3.235, 'Tiny', 4.981),
      run(' ', 459.96, 202.258, 0.996, 'Tiny', 0),
      run(', we repeat the comparison', 460.956, 202.064, 79.042, 'Body', 9.963)
    ]
    const units = translationUnits(items)
    const owner = units.find((unit) => unit.items.includes('1:18'))
    assert.ok(owner)
    if (misaligned) {
      assert.ok(!owner?.items.includes('1:19'))
      return
    }
    assert.equal(
      owner?.source,
      'for any ω[j]d, giving the expected quantity after averaging. For any ω[j]d, we repeat the comparison'
    )
    assert.equal(owner?.fragments.length, 2)
    assert.ok(owner?.items.includes('1:19'))
    assert.ok(!owner?.items.includes('1:16'))
  }
)

it.each([
  { shape: 'matching rows', titleWrap: true, footnoteWrap: true },
  { shape: 'different abstract term', titleWrap: false, footnoteWrap: true },
  { shape: 'shifted second title row', titleWrap: false, footnoteWrap: true },
  { shape: 'different title marker', titleWrap: false, footnoteWrap: false },
  { shape: 'shifted footnote word', titleWrap: true, footnoteWrap: false }
])('reassembles the title and its footnote when native evidence agrees: $shape', (testCase) => {
  const { shape, titleWrap, footnoteWrap } = testCase
  const title = { fontName: 'title', size: 14.4 }
  const footnote = { fontName: 'footnote', size: 9 }
  const shift = shape === 'shifted second title row' ? 6 : 0
  const term = shape === 'different abstract term' ? 'River Delta' : 'River Basin'
  const units = translationUnits([
    item('Field Notes - Learn about the River', 170, 666, 272, title),
    item('Basin while exploring local records', 190 + shift, 648, 226, {
      ...title,
      hasEOL: false
    }),
    item(shape === 'different title marker' ? '†' : '⋆', 416 + shift, 653.2, 6, {
      size: 10,
      fontName: 'title-mark',
      hasEOL: false
    }),
    item('', 0, 0, 0, { size: 0 }),
    item('Example Author', 240, 613.5, 95, { hasEOL: false }),
    item('1', 335, 617, 4, { size: 7, fontName: 'affiliation-mark' }),
    item(
      'Abstract. We compare records around the ' +
        term +
        ' with measurements from the previous year.',
      135,
      480,
      340
    ),
    item(
      'Each reader can review the full collection of measurements used for this summary.',
      135,
      468,
      348
    ),
    item('The survey describes the regional differences in the annual series.', 135, 176, 345),
    item('Our first observations show that several records changed during spring.', 135, 164, 345, {
      hasEOL: false
    }),
    item('⋆', 137.5, 148.8, 4, { size: 6, fontName: 'footnote-mark', hasEOL: false }),
    item(
      'This summary was prepared for presentation at the Regional Climate Forum',
      145,
      145,
      335,
      footnote
    ),
    item('Workshop.', shape === 'shifted footnote word' ? 150 : 145, 134, 39, {
      ...footnote,
      hasEOL: false
    })
  ])
  const titleOwner = units.find((unit) => unit.items.includes('1:0'))
  const footnoteOwner = units.find((unit) => unit.items.includes('1:11'))
  assert.equal(titleOwner?.items.includes('1:1'), titleWrap)
  assert.equal(footnoteOwner?.items.includes('1:12'), footnoteWrap)
  if (titleWrap) {
    assert.match(titleOwner?.source ?? '', /River Basin while exploring local records⋆$/u)
    assert.deepEqual(titleOwner?.items, ['1:0', '1:1', '1:2'])
    assert.equal(titleOwner?.fragments.length, 2)
  }
  if (footnoteWrap) {
    assert.match(footnoteOwner?.source ?? '', /Climate Forum Workshop\.$/u)
    assert.deepEqual(footnoteOwner?.items, ['1:10', '1:11', '1:12'])
    assert.equal(footnoteOwner?.fragments.length, 2)
  }
  const ownership = units.flatMap((unit) => unit.items)
  assert.equal(ownership.length, 12)
  assert.equal(new Set(ownership).size, 12)
})

it.each(['axis script', 'raised label word', 'mismatched variable'])(
  'keeps the lowered word of a plotted difference native for %s',
  (shape) => {
    const axis = { fontName: 'axis', size: 9.2, hasEOL: false }
    const ticks = Array.from({ length: 8 }, (_, i) => {
      const x = 135 + 29.4 * i
      const tick = item(String(2 * i - 2), x, 215.1, i === 0 ? 8 : 6, { ...axis, hasEOL: i === 7 })
      return i === 7
        ? [tick]
        : [tick, item(' ', x + tick.width, 215.1, 29.4 - tick.width, { ...axis, size: 0 })]
    }).flat()
    const items = [
      item('An overview of the measurements', 168, 655, 276),
      item('The instrument records values throughout each observation.', 53, 609, 500),
      ...ticks,
      item('D', 242, 204, 6, axis),
      item('−', 250, 204, 5, { ...axis, fontName: 'symbol' }),
      item(shape === 'mismatched variable' ? 'H' : 'D', 258, 204, 6, axis),
      item('low', 264, shape === 'raised label word' ? 202.5 : 200.3, 12, {
        ...axis,
        size: 6.5
      }),
      item('(hours)', 277.6, 204, 25, axis),
      item('Figure 2. Values recorded during the calibration exercise.', 51, 145, 510),
      item('The collected data are summarized along the horizontal axis.', 51, 133, 510)
    ]
    const units = translationUnits(items)
    const key = items.findIndex((item) => item.str === 'low')
    const label = units.find((unit) => unit.items.includes(`1:${key}`))
    assert.ok(label, 'the lowered word belongs to a source unit')
    assert.equal(label.preserve === 'formula' && !!label.sourceOnly, shape === 'axis script')
    if (shape === 'axis script') assert.deepEqual(label.items, [`1:${key}`, `1:${key + 1}`])
    const ownership = units.flatMap((unit) => unit.items)
    const visibleCount = items.filter((item) => item.str.trim()).length
    assert.equal(ownership.length, visibleCount)
    assert.equal(new Set(ownership).size, visibleCount)
  }
)

it('preserves the DOI rows missed between two-column references', () => {
  const journal = { size: 8.9664, fontName: 'journal' }
  const rows: [string, boolean, number][] = [
    ['2014, R&R, 428, A89, doi: 10.5555/1234-5678/20140102', true, 231.14],
    ['de Ver, R. S. T., Able, P., Baker, M., et al. 2016, R&R,', false, 236.93],
    ['238, A52, doi: 10.5555/1234-5678/20160506', true, 180.46],
    ['del’Mar, B., & Cruz, C. 2007, in Collected Proceedings', false, 194.19],
    ['Publication, Vol. 238, The Three-Dimensional Model', true, 223.12],
    ['with Examples, ed. M. Dale, H. Earl, & R. J. G.', true, 221.92],
    ['Fenn, 428', true, 59.05],
    ['Gale, P. T. 2002, Measurements from the Boreal Survey', false, 241.36],
    ['Studies (London: Example Press), 215–228,', true, 208.21],
    ['doi: 10.5555/123-45-6789-0 12', true, 139.45],
    ['Survey Consortium, Hall, N., de Ver, R. S. T., et al.', false, 232.11],
    ['2017, R&R, 349, A8, doi: 10.5555/1234-5678/20170206', true, 226.53],
    ['Survey Consortium, Irons, P. W. T., Jones, J., et al.', false, 232.24],
    ['2019a, R&R, 270, A6, doi: 10.5555/1234-5678/20190510', true, 231.14],
    ['Survey Consortium, Keen, N., Lane, A., et al. 2019b,', false, 219.72],
    ['R&R, 270, A18, doi: 10.5555/1234-5678/20190812', true, 207.07],
    ['Survey Consortium, Irons, P. W. T., Jones, J., et al.', false, 232.24],
    ['2022, R&R, 429, A8, doi: 10.5555/1234-5678/20220714', true, 226.53]
  ]
  const items = [
    item('REFERENCES', 272.094, 445.235, 68.495, { size: 9.9626, hasEOL: false }),
    ...rows.map(([str, hanging, width], i) =>
      item(str, hanging ? 59.955 : 50.74, 413.852 - i * 12.9513, width, journal)
    ),
    item('Maruˇ', 50.74, 180.726, 25.6215, { ...journal, hasEOL: false }),
    item('s, J., Peary, P., Rower, M., et al. 2019, R&R,', 72.2369, 180.726, 216.172, journal),
    item('639, A62, doi: 10.5555/1234-5678/20190402', 59.956, 167.775, 180.455, journal),
    item('Miraˇ', 320.579, 426.804, 25.6215, { ...journal, hasEOL: false })
  ].map((row) => ({ ...row, fontFamily: 'sans-serif', fontAscent: 0.694, fontDescent: -0.194 }))
  const { units } = groupPdfTranslationPages({
    pageCount: 3,
    pages: [[], [], items].map((pageItems, i) => ({
      page: i + 1,
      width: 612,
      height: 792,
      rotation: 0,
      items: pageItems
    }))
  })
  const mixed = units.find((unit) => unit.items.includes('3:3'))
  const last = units.find((unit) => unit.items.includes('3:21'))
  assert.deepEqual(mixed?.items, ['3:3', '3:4'])
  assert.equal(mixed?.preserve, 'reference')
  assert.equal(mixed?.sourceOnly, true)
  assert.deepEqual(last?.items, ['3:21'])
  assert.equal(last?.preserve, 'reference')
  assert.equal(last?.sourceOnly, true)
  const ownership = units.flatMap((unit) => unit.items)
  assert.equal(ownership.length, items.length)
  assert.equal(new Set(ownership).size, items.length)
})

it.each([true, false])(
  'keeps the right-column bibliography native with a matching left-column entry (%s)',
  (hasLeftDate) => {
    const body = { size: 9 }
    const inline = { ...body, hasEOL: false }
    const items = [
      item('References', 154.5, 273.75, 40, body),
      item(
        hasLeftDate
          ? 'Field, J., García, R., & Lane, F. (2019).'
          : 'Field, J., García, R., & Lane, F. (in preparation).',
        54,
        72.75,
        241.19,
        inline
      ),
      item('', 317.25, 591.75, 0, { size: 0 }),
      item('“Results from the northern calibration campaign.”', 317.25, 591.75, 240.96, inline),
      item('Measurement Reports', 317.25, 581.25, 78.99, { ...inline, fontName: 'italic' }),
      item('52', 398.49, 581.25, 9, { ...inline, fontName: 'bold' }),
      item(', 124-129.', 407.49, 581.25, 36.75, body),
      item('Case,', 317.25, 564.75, 19.74, inline),
      item('A.B.,', 342.99, 564.75, 18.25, inline),
      item('Drake, S.A., & Evan, J.R. (2020). “A summary of early', 317.25, 554.25, 240.95, body),
      item(
        'measurements from the experiment.” Submitted for review.',
        317.25,
        543.75,
        241.47,
        body
      ),
      item('Green, B.D., Hill, A.W., Reed, P. (2008). “The Archive', 317.25, 516.75, 240.93, body),
      item(
        'of Instrument Records.” Data Notes 182, 64-76. Updated in May.',
        317.25,
        506.25,
        241.43,
        body
      ),
      item('https://example.test/records', 317.25, 495.75, 192.21, body),
      item('Green. B.D. (2020). Data Catalog.', 317.25, 479.25, 241.4, body),
      item('https://example.test/catalog', 317.25, 468.75, 92.75, inline),
      item('Measurement Reports 52 (2020)', 247.5, 46.5, 115.99, inline)
    ].map((row) => ({
      ...row,
      fontFamily: 'serif',
      fontAscent: 0.8911,
      fontDescent: -0.2163
    }))
    const { units } = groupPdfTranslationPages({
      pageCount: 2,
      pages: [[], items].map((pageItems, n) => ({
        page: n + 1,
        width: 612,
        height: 792,
        rotation: 0,
        items: pageItems
      }))
    })
    for (const index of [3, 7, 11, 14]) {
      const owner = units.find((unit) => unit.items.includes(`2:${index}`))
      assert.ok(owner)
      assert.equal(owner.preserve === 'reference' && !!owner.sourceOnly, hasLeftDate)
    }
    const ownership = units.flatMap((unit) => unit.items)
    assert.equal(ownership.length, items.length - 1)
    assert.equal(new Set(ownership).size, items.length - 1)
  }
)

it.each([0, 4])(
  'keeps a wrapped calendar day with its preceding date and citation (shift=%s)',
  (shift) => {
    const body = { size: 9.9626 }
    const inline = { ...body, hasEOL: false }
    const author = 'North & Remy 2019'
    const items = [
      item('Observations from the Northern Ridge', 153, 699, 306, { size: 14 }),
      item(
        'The survey reviewed a set of reports from the same station during the previous year.',
        59.76,
        265,
        502.24,
        body
      ),
      item('An earlier sample was included (', 50.76, 252.55, 182.6, inline),
      item(author, 233.36, 252.55, 214.26, inline),
      item('). The records can be compared.', 447.62, 252.55, 114.38, body),
      item(
        'The recorded times remain provisional. A later observation was confirmed on 2021 October',
        50.76,
        240.1,
        511.24,
        body
      ),
      item('14 (', 50.76 + shift, 227.65, 17.19, inline),
      item(author, 67.95 + shift, 227.65, 214.26, inline),
      item(').', 282.21 + shift, 227.65, 6.6, body),
      item(
        'We thank the readers who helped to check the details of these records.',
        59.76,
        198.7,
        405,
        body
      )
    ]
    const units = translationUnits(items)
    const paragraph = units.find((unit) => unit.items.includes('1:5'))
    assert.equal(paragraph?.items.includes('1:6'), shift === 0)
    if (!shift) {
      assert.match(paragraph?.source ?? '', /2021 October 14 \(North & Remy 2019\)\.$/u)
      assert.deepEqual(paragraph?.items.slice(-3), ['1:6', '1:7', '1:8'])
    }
    const ownership = units.flatMap((unit) => unit.items)
    assert.equal(ownership.length, items.length)
    assert.equal(new Set(ownership).size, items.length)
  }
)

it.each([true, false])(
  'restores the deferred figure caption between proven reference lanes (%s)',
  (twoPanels) => {
    const body = { size: 8.9664, fontName: 'body' }
    const inline = { ...body, hasEOL: false }
    const rows: PdfLayoutTextItem[][] = [
      [],
      [
        item('REFERENCES', 272.04, 154.08, 68.65, { hasEOL: false }),
        item('Blair, C., & Grant, R. 2013,', 320.52, 135.6, 232.84, body),
        item('Data Notes, 528, B46', 329.76, 118.68, 74.2, body),
        item('Blair, C., & Grant, R. 2016,', 320.52, 97.68, 232.84, body),
        item('Data Notes, 622, 3147', 329.76, 80.76, 77.56, inline)
      ],
      [
        item('3', 556.92, 740.4, 4.98, { hasEOL: false }),
        item('Figure 2.', 50.76, 214.32, 42.3, { ...inline, fontName: 'caption-label' }),
        item(
          'Changes in the measured intensity (top panel) during the first recording session and a comparison with the',
          98.52,
          214.32,
          463.29,
          body
        ),
        item(
          twoPanels
            ? 'calibrated response (bottom panel) as a function of time over the full period for the reference instrument'
            : 'calibrated response as a function of time over the full observation period for the reference instrument',
          50.76,
          203.4,
          511.12,
          body
        ),
        item(
          'and for the detector used in the parallel experiment. Additional labels correspond to the original ranges',
          50.76,
          192.48,
          364.52,
          inline
        ),
        item(
          'shown in the appendix and in the description of the instrument. Our fitted curves and residuals are shown',
          50.76,
          181.44,
          511.11,
          body
        ),
        item('for each independent recording in the comparison.', 50.76, 170.52, 278.32, body),
        item('Blair, C., Grant, R., & Hall, S.', 50.76, 146.4, 211.4, body),
        item('Quinn, P., Reed, M. H., Stone, D., et al. 2014,', 320.52, 146.4, 226.35, body)
      ]
    ]
    const { units } = groupPdfTranslationPages({
      pageCount: rows.length,
      pages: rows.map((items, i) => ({ page: i + 1, width: 612, height: 792, rotation: 0, items }))
    })
    const caption = units.find((unit) => unit.items.includes('3:1'))
    assert.equal(!!caption?.sourceOnly, !twoPanels)
    assert.equal(caption?.preserve, twoPanels ? undefined : 'reference')
    assert.deepEqual(caption?.items, ['3:1', '3:2', '3:3', '3:4', '3:5', '3:6'])
    for (const key of ['3:7', '3:8']) {
      const citation = units.find((unit) => unit.items.includes(key))
      assert.equal(citation?.preserve, 'reference')
    }
    const ownership = units.flatMap((unit) => unit.items)
    const count = rows.flat().length
    assert.equal(ownership.length, count)
    assert.equal(new Set(ownership).size, count)
  }
)

it.each([0, 12])('joins a dependent question across the front-page columns (shift=%s)', (shift) => {
  const body = { size: 9 }
  const inline = { ...body, hasEOL: false }
  const gap = { ...inline, size: 0 }
  const heading = { size: 9.5, fontName: 'heading', hasEOL: false }
  const left = 'What remains unknown is an independent estimate of how'
  const first = 'much variation the instrument must have.'
  const lines = (x: number, y: number, count: number): PdfLayoutTextItem[] =>
    Array.from({ length: count }, (_, i) =>
      item(
        'The observations remain consistent throughout the measurement procedure',
        x,
        y - 11 * i,
        250,
        body
      )
    )
  const items = [
    item('Report', 54, 760, 28, { size: 8 }),
    item('1', 558, 760, 5, { size: 8 }),
    item('Measuring Repeatability in a Shared Laboratory', 54, 665, 490, { size: 19 }),
    item('A brief account of repeated observations collected during a shared test', 48, 530, 250),
    item('and of the protocol used to compare the independent calibrations.', 48, 518, 250),
    item('1. INTRODUCTION', 48, 278, 135, heading),
    ...lines(48, 258, 7),
    item('The earlier observations are available for comparison.', 48, 181, 170, body),
    item('The consistent observations establish the limits of this procedure.', 60, 170, 238, body),
    ...lines(48, 159, 8),
    item('The individual observations are reported elsewhere.', 48, 71, 200, body),
    item(left, 60, 60, 238, body),
    item(first, 322, 528, 189, inline),
    item(' ', 511, 528, 6, gap),
    item('Earlier tests', 517, 528 + shift, 55, body),
    ...lines(322, 517, 10),
    item('The results were recorded for both instruments.', 322, 407, 190, inline),
    item('', 322, 378, 0, { ...gap, hasEOL: true }),
    item('2. MEASUREMENT METHOD', 322, 378, 175, heading),
    ...lines(322, 359, 1),
    item('The following observations were made on separate days.', 322, 73, 183, body)
  ]
  const units = translationUnits(items)
  const owner = (source: string): string => `1:${items.findIndex((row) => row.str === source)}`
  const question = units.find((unit) => unit.items.includes(owner(left)))
  assert.equal(question?.source.startsWith(left + ' ' + first), shift === 0)
  assert.equal(question?.items.includes(owner(first)), shift === 0)
  assert.equal(question?.items.includes(owner('2. MEASUREMENT METHOD')), false)
  if (!shift) assert.equal(question?.fragments.length, 2)
})

it.each(['K', 'M'])('joins a theorem lead to its matching native scope in %s', (scope) => {
  const head = 'We prove the following theorem which completes the earlier result for graphs'
  const body = { hasEOL: false }
  const variable = { ...body, fontName: 'math' }
  const items = [
    item(
      'Suppose that the graph is connected and that all the vertices are included.',
      72,
      659,
      336
    ),
    item('Any two components are separated by the indicated boundary.', 72, 647, 336),
    item(head, 87, 635, 321),
    item('in', 72, 623, 8, body),
    item(' ', 80, 623, 3.5, { ...body, size: 0 }),
    item('K', 83.5, 623, 6, variable),
    item('.', 90, 623, 2.8, body),
    item('', 72, 604, 0, { size: 0 }),
    item('Theorem 1', 72, 604, 55, { ...body, fontName: 'heading' }),
    item('Let', 132, 604, 14, { ...body, fontName: 'italic' }),
    item('H', 151, 604, 6, variable),
    item('∈', 160, 604, 7, variable),
    item(scope, 170, 604, 6, variable),
    item('and suppose that every vertex has an incident edge.', 181, 604, 227, {
      fontName: 'italic'
    }),
    item('Then the assigned components satisfy both conditions.', 72, 592, 260, {
      fontName: 'italic'
    })
  ]
  const units = groupPdfTranslationPages({
    pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
  }).units
  const lead = units.find((unit) => unit.items.includes('1:2'))
  assert.equal(lead?.source, scope === 'K' ? `${head} in K.` : head)
  assert.equal(lead?.fragments.length, 1)
  assert.equal(
    units.find((unit) => unit.items.includes('1:8'))?.source.startsWith('Theorem 1'),
    true
  )
  assert.deepEqual(
    units.flatMap((unit) => unit.items),
    items.flatMap((item, i) => (item.str.trim() ? [`1:${i}`] : []))
  )
})

it.each(['Total', 'Subtotal'])(
  'joins a repeated noun phrase below a closed page-opening table (%s)',
  (label) => {
    const pages = [
      {
        page: 1,
        width: 612,
        height: 792,
        rotation: 0,
        items: [
          item('The survey explains the field procedure and lists the samples used.', 40, 700, 250),
          item('We monitored the river after an unusually dry season and measured', 322, 84, 250),
          item('the changes in each section. The channel shifted as water slowed,', 322, 72, 250),
          item('leaving a layer of loose sand and causing the sediment', 322, 60, 250, {
            hasEOL: false
          })
        ]
      },
      {
        page: 2,
        width: 612,
        height: 792,
        rotation: 0,
        items: [
          item('Table 1.', 40, 730, 31, { fontName: 'table', hasEOL: false }),
          item('Depth and length at each survey station.', 78, 730, 170),
          ...['1.2', '2.3', '3.4', '4.5', '5.6', '6.7', '7.8', '8.9'].map((value, i) =>
            item(value, i % 2 ? 180 : 70, 704 - Math.floor(i / 2) * 14, 15)
          ),
          item(label, 71, 645, 24, { hasEOL: false }),
          item('23.7', 180, 645, 19, { hasEOL: false }),
          item('1', 204, 649, 4, { size: 7 }),
          item(
            'layer to become uneven. This was consistent with our other readings,',
            40,
            605,
            250
          ),
          item(
            'which also showed a deeper sediment layer at the site near the bend.',
            40,
            593,
            250
          ),
          item('All remaining stations showed comparable readings for the month.', 40, 581, 234)
        ]
      }
    ]
    const { units } = groupPdfTranslationPages({ pages })
    const result = units.find((unit) => unit.items.includes('1:3'))
    assert.equal(result?.source.includes('the sediment layer to become uneven'), label === 'Total')
    assert.equal(result?.fragments.length, label === 'Total' ? 2 : 1)
    assert.equal(result?.items.includes('2:0'), false)
  }
)

it.each([0, 10])(
  'continues an opening paragraph below the next page figure (shift=%s)',
  (shift) => {
    const head = 'The software library is designed to support'
    const last = 'the processing of irregularly sampled'
    const tail = 'time-series data in Julia and Python. Currently,'
    const caption = 'Fig. 1. The measurements recorded by each of the instruments in the study.'
    const heading = { fontName: 'heading' }
    const inline = { hasEOL: false }
    const page = (number: number, items: PdfLayoutTextItem[]): PdfLayoutPage => ({
      page: number,
      width: 595,
      height: 842,
      rotation: 0,
      items
    })
    const pages = [
      page(1, [
        item('A short report on measurement procedures', 100, 681, 384, { ...heading, size: 15 }),
        item('The method was evaluated across three independent recording stations.', 99, 264, 185),
        item(
          'The observations indicate consistent accuracy under realistic conditions.',
          99,
          228,
          185
        ),
        item('Independent tests confirmed the results.', 296, 242, 185),
        item('2. Data processing', 296, 210, 109, { ...heading, ...inline }),
        item('', 296, 192, 0, { size: 0 }),
        item(head, 296, 192, 185),
        item(last, 296, 181, 185, inline)
      ]),
      page(2, [
        item('Author: Report on measurement procedures', 170, 752, 260, { ...heading, size: 9 }),
        item(caption, 99, 439, 382, { ...inline, size: 9.5 }),
        item('', 99, 409 + shift, 0, { size: 0 }),
        item(tail, 99, 409 + shift, 185),
        item('the library includes several modules for processing', 99, 398 + shift, 185),
        item('the samples collected at the three reference sites.', 99, 387 + shift, 185),
        item('All calibration measurements can be compared.', 99, 376 + shift, 185, inline),
        item('Experimental methods', 296, 362, 120, heading),
        item('The secondary methods were evaluated separately.', 296, 348, 185)
      ])
    ]
    const { units } = groupPdfTranslationPages({ pages })
    const paragraph = units.find((unit) => unit.items.includes('1:6'))
    assert.equal(paragraph?.source.includes(`${last} ${tail}`), shift === 0)
    assert.deepEqual(
      paragraph?.fragments.map(({ page }) => page),
      shift ? [1] : [1, 2]
    )
    assert.deepEqual(units.find((unit) => unit.source === caption)?.items, ['2:1'])
  }
)

it.each([85, 86])('joins a repeated split word across facing running folios (%s)', (next) => {
  const small = { size: 9, hasEOL: false }
  const open = { hasEOL: false }
  const gap = { size: 0, hasEOL: false }
  const title = 'Writer: Repeated sample measurements in a regional survey'
  const pages = [
    {
      page: 1,
      width: 595,
      height: 842,
      rotation: 0,
      items: [
        item('84', 98, 751, 13, small),
        item(' ', 111, 751, 53, gap),
        item(title, 164, 751, 250, small),
        item('Fig. 2. Results for the regional monitoring stations.', 98, 236, 382),
        item('and the performance of the sampling algorithm', 98, 190, 186, open),
        item(' ', 284, 190, 11, gap),
        item('can be seen, with a persistent effect on per-', 295, 190, 186, open)
      ]
    },
    {
      page: 2,
      width: 595,
      height: 842,
      rotation: 0,
      items: [
        item(title, 164, 751, 250, small),
        item(' ', 414, 751, 54, gap),
        item(String(next), 468, 751, 13, small),
        item('', 98, 729, 0, { size: 0 }),
        item('formance when samples exceed the recommended', 98, 729, 186),
        item('minimum. The independent checks revealed the', 98, 718, 186),
        item('same difference last month.', 98, 707, 110)
      ]
    }
  ]
  const { units } = groupPdfTranslationPages({ pages })
  const result = units.find((unit) => unit.items.includes('1:6'))
  assert.equal(result?.source.includes('on performance when samples'), next === 85)
  assert.equal(result?.fragments.length, next === 85 ? 2 : 1)
  assert.equal(result?.items.includes('2:0'), false)
})

it.each([true, false])(
  'joins a short numeric wrap when the following paragraph repeats it (repeated=%s)',
  (repeated) => {
    const units = translationUnits([
      item('Proof.', 72, 405, 26, { fontName: 'label', hasEOL: false }),
      item('Read the entries of the sequence in ascending order for each record.', 105, 405, 435),
      item('To ensure consistent outcomes we count the available groups beginning', 72, 391.6, 468),
      item('with 3.', 72, 378.2, 31),
      item(
        repeated
          ? 'If the first group is beginning with 3, a matching order follows.'
          : 'If the groups begin at the same point, a matching order follows.',
        87,
        364.8,
        453
      ),
      item('The second comparison settles the result.', 72, 351.4, 152)
    ])
    const proof = units.find((unit) => unit.items.includes('1:2'))
    assert.equal(proof?.source.endsWith('beginning with 3.'), repeated)
    assert.equal(proof?.items.includes('1:3'), repeated)
    assert.ok(units.some((unit) => unit.items.includes('1:4') && !unit.items.includes('1:2')))
    assert.deepEqual(units.flatMap((unit) => unit.items).sort(), [
      '1:0',
      '1:1',
      '1:2',
      '1:3',
      '1:4',
      '1:5'
    ])
  }
)

it.each([false, true])(
  'preserves a letter and attached period only below its native root (detached=%s)',
  (detached) => {
    const units = translationUnits([
      item('The following equation gives the required analytical upper bound', 72, 699, 405),
      item('√', 300, 680, 8.3, { fontName: 'root', hasEOL: false }),
      item('v.', detached ? 312.1 : 308.3, 672.3, 8.75, {
        fontName: 'italic',
        hasEOL: false
      }),
      item('The upper bound is always valid for sufficiently large observations.', 72, 645, 468)
    ])
    const glyph = units.find((unit) => unit.items.includes('1:2'))
    assert.equal(glyph?.source, 'v.')
    assert.equal(glyph?.sourceOnly, detached ? undefined : true)
    assert.equal(glyph?.preserve, detached ? undefined : 'formula')
    assert.deepEqual(units.flatMap((unit) => unit.items).sort(), ['1:0', '1:1', '1:2', '1:3'])
  }
)

it.each([false, true])(
  'keeps a numeral and its shared text run below an aligned native radical (detached=%s)',
  (detached) => {
    const units = translationUnits([
      item('The control gives the expected value on the left, but', 72, 404, 468, {
        hasEOL: false
      }),
      item('√', 72, 400.2, 8.3, { fontName: 'radical', hasEOL: false }),
      item('3 on the other side.', detached ? 85 : 80.3, 392, 95, { hasEOL: false }),
      item('Independent observations confirm the measured response.', 86, 365, 391)
    ])
    const tail = units.find((unit) => unit.items.includes('1:2'))
    const previous = units.find((unit) => unit.items.includes('1:0'))
    assert.equal(tail?.source, '3 on the other side.')
    assert.equal(tail?.sourceOnly, detached ? undefined : true)
    assert.equal(tail?.preserve, detached ? undefined : 'formula')
    assert.equal(previous?.sourceOnly, undefined)
    assert.deepEqual(units.flatMap((unit) => unit.items).sort(), ['1:0', '1:1', '1:2', '1:3'])
  }
)

it.each([false, true])(
  'preserves prose that ends inside a native negated premise (detached=%s)',
  (detached) => {
    const plain = { hasEOL: false }
    const italic = { ...plain, fontName: 'italic' }
    const symbol = { ...plain, fontName: 'symbol' }
    const units = translationUnits([
      item('r', 72, 698, 4.9, italic),
      item('and then', 104.5, 698, 44.7, plain),
      item('r', 153.5, 698, 4.9, italic),
      item('from (4), which is sufficient.', 196, 698, 159.1, plain),
      item('Consider another possibility once', 362.3, 698, 177.8),
      item('we evaluate the case assuming that', 72, 686.2, 182.9, plain),
      item('V', 259.6, 686.2, 6.8, italic),
      item('Q', 266.4, 684.7, 5.7, { ...italic, fontName: 'index', size: 7 }),
      item('∗', 272.6, 686.6, 3.7, { ...italic, fontName: 'script', size: 5 }),
      item(' ', 276.3, 686.6, 6.1, { ...plain, size: 0 }),
      item('\u0338', detached ? 286 : 282.4, 686.2, 0, symbol),
      item('=', 282.4, 686.2, 7.7, plain),
      item('∅', 295.1, 686.2, 5, symbol)
    ])
    const premise = units.find((unit) => unit.items.includes('1:5'))
    const relation = units.find((unit) => unit.items.includes('1:10'))
    assert.equal(premise?.sourceOnly, detached ? undefined : true)
    assert.equal(premise?.preserve, detached ? undefined : 'formula')
    if (!detached) {
      assert.ok(premise?.source.endsWith('assuming that VQ∗'))
      assert.equal(relation?.source, '\u0338= ∅')
      assert.equal(relation?.preserve, 'formula')
      assert.notEqual(premise, relation)
    }
    assert.deepEqual(
      units.flatMap((unit) => unit.items).sort(),
      Array.from({ length: 13 }, (_, index) => index)
        .filter((index) => index !== 9)
        .map((index) => `1:${index}`)
        .sort()
    )
  }
)

it.each([0, 8])('keeps a funded research group name on its native paragraph rail (%s)', (shift) => {
  const continued = 'Marine Research Group on'
  const units = translationUnits([
    item('Earlier observations establish the baseline for this series.', 70, 244, 390),
    item('Funding acknowledgement.', 70, 220, 150, {
      fontName: 'heading',
      size: 12,
      hasEOL: false
    }),
    item('The authors received support within the Aurora', 226, 220, 312),
    item(continued, 70 + shift, 208, 118, { hasEOL: false }),
    item('Coastal Monitoring', 192 + shift, 208, 110, { fontName: 'italic', hasEOL: false }),
    item('as part of a regional programme', 310 + shift, 208, 228 - shift),
    item('for applied field sciences (grant no. A12/04).', 70, 196, 260),
    item('3', 303, 72, 5)
  ])
  const funding = units.find((u) => u.items.includes('1:1'))
  assert.equal(funding?.items.includes('1:3'), shift === 0)
  if (shift === 0) {
    assert.match(funding?.source ?? '', /the Aurora Marine Research Group on Coastal Monitoring/u)
    assert.equal(funding?.fragments.length, 2)
  }
  assert.deepEqual(
    units.flatMap((u) => u.items).filter((i) => i === '1:3'),
    ['1:3']
  )
})

it.each([0, 6])('joins a software citation only on its native continuation row (%s)', (offset) => {
  const first = 'Vector (Reed Group et al. 2014,'
  const second = '2017, 2021), Orbit (Morgan et al. 2022)'
  const units = translationUnits([
    item('6. ACKNOWLEDGEMENTS', 380, 514, 123),
    item('Software:', 330, 492, 46, { fontName: 'heading', size: 12, hasEOL: false }),
    item(first, 383, 492, 178),
    item(second, 320, 479.5 - offset, 162),
    item('REFERENCES', 275, 449, 62)
  ])
  const credit = units.find((unit) => unit.items.includes('1:1'))
  assert.equal(credit?.source, 'Software: ' + first + (offset ? '' : ' ' + second))
  assert.deepEqual(credit?.items, offset ? ['1:1', '1:2'] : ['1:1', '1:2', '1:3'])
  assert.equal(credit?.fragments.length, 1)
  assert.equal(credit?.fragments[0].rect.x, offset ? 330 : 320)
  assert.deepEqual(
    units.flatMap((unit) => unit.items),
    ['1:0', '1:1', '1:2', '1:3', '1:4']
  )
})

it.each(['repeat', 'different year'] as const)(
  'keeps a wrapped software author citation together when the preceding prose corroborates it (%s)',
  (evidence) => {
    const first = 'gridplot (Dale et al. 2013) mapcalc (J.'
    const second = 'Reed et al. 2021)'
    const year = evidence === 'repeat' ? '2021' : '2022'
    const units = translationUnits([
      item(`The software was described earlier (J. Reed et al. ${year}).`, 50, 520, 480),
      item('Software:', 59, 492, 47, { fontName: 'heading', size: 12, hasEOL: false }),
      item(first, 113, 492, 449),
      item(second, 50, 479.5, 78),
      item('REFERENCES', 275, 448, 62)
    ])
    const credit = units.find((unit) => unit.items.includes('1:1'))
    assert.equal(credit?.source, 'Software: ' + first + (evidence === 'repeat' ? ' ' + second : ''))
    assert.deepEqual(credit?.items, evidence === 'repeat' ? ['1:1', '1:2', '1:3'] : ['1:1', '1:2'])
    assert.equal(credit?.fragments.length, 1)
    assert.deepEqual(
      units.flatMap((unit) => unit.items),
      ['1:0', '1:1', '1:2', '1:3', '1:4']
    )
  }
)

it.each(['aligned', 'outside bibliography'] as const)(
  'keeps a terminal software citation with its credited package (%s)',
  (format) => {
    const first =
      'rayplot (Sable Group et al. 2013, 2018), mapgrid (M. Rowe et al. 2020), lineblend'
    const second = '(A. M. Cooper 2006).'
    const units = translationUnits([
      item(
        'These observations confirm that the instrument responds to the calibrated test signal.',
        60,
        520,
        502
      ),
      item('Software:', 59, 492, 47, { fontName: 'heading', size: 12, hasEOL: false }),
      item(first, 113, 492, 449),
      item(second, 50, 479.5, 88),
      item(format === 'aligned' ? 'REFERENCES' : 'FURTHER WORK', 272, 448, 68)
    ])
    const credit = units.find((unit) => unit.items.includes('1:1'))
    const joined = format === 'aligned'
    assert.equal(credit?.source, 'Software: ' + first + (joined ? ' ' + second : ''))
    assert.deepEqual(credit?.items, joined ? ['1:1', '1:2', '1:3'] : ['1:1', '1:2'])
    assert.equal(credit?.fragments.length, 1)
    assert.deepEqual(
      units.flatMap((unit) => unit.items),
      ['1:0', '1:1', '1:2', '1:3', '1:4']
    )
  }
)

it.each([0, 2])('keeps each centered native affiliation on its own row (%s)', (shift) => {
  const name = { fontName: 'address', size: 8, hasEOL: false }
  const marker = { fontName: 'marker', size: 6, hasEOL: false }
  const lines = [
    item('Ann M. Reader and Robin Writer', 171, 661, 270, { size: 9 }),
    item('1', 69, 591, 4, marker),
    item(
      'Center for Field Research, Example University, 180 West Road, North City',
      73,
      588.2,
      470,
      name
    ),
    item('', 0, 0, 0, { size: 0 }),
    item('2', 69 + shift, 579, 4, marker),
    item(
      'Centro de Estudios del Mar, Universidad Ejemplar, Avenida del Puerto, Villa Azul',
      73 + shift,
      576.2,
      470,
      name
    )
  ]
  const units = translationUnits(lines)
  const head = units.find((unit) => unit.items.includes('1:1'))
  assert.equal(head?.items.includes('1:4'), shift > 0, JSON.stringify(units))
  if (shift === 0)
    assert.deepEqual(units.find((unit) => unit.items.includes('1:4'))?.items, ['1:4', '1:5'])
})

it.each(['centered row', 'shifted row', 'centered address'])(
  'keeps a numbered institution independent from the byline (%s)',
  (placement) => {
    const shift = placement === 'shifted row' ? 3 : 0
    const bodyCentered = placement === 'centered address'
    const open = { hasEOL: false }
    const author = { ...open, size: 10, fontName: 'name' }
    const address = { ...open, size: 9, fontName: 'address' }
    const marker = { ...open, size: 6, fontName: 'index' }
    const lineBreak = item('', 0, 0, 0, { size: 0 })
    const units = translationUnits([
      item('Alex Reader and Casey Stone', 137, 676, 333, author),
      item('2', 470, 679.6, 4, { ...marker, size: 7 }),
      lineBreak,
      item('1', 81, 664.4, 4, marker),
      item('Science Network, Example Campus, North City', 85, 660.6, 446, address),
      lineBreak,
      item('2', (bodyCentered ? 128 : 132) + shift, 653.4, 4, marker),
      item(
        'Field Research Group, Example College, West City',
        (bodyCentered ? 132 : 139) + shift,
        649.6,
        bodyCentered ? 348 : 341,
        address
      ),
      lineBreak,
      item('3', 72, 642.4, 4, marker),
      item('Department of Applied Studies, Sample Campus, South City', 79, 638.6, 461, address)
    ])
    const owner = (index: number): PdfTranslationLayout['units'][number] | undefined =>
      units.find((unit) => unit.items.includes(`1:${index}`))
    assert.equal(owner(0)?.items.includes('1:6'), shift > 0, JSON.stringify(units))
    if (!shift) assert.deepEqual(owner(6)?.items, ['1:6', '1:7'])
    assert.deepEqual(owner(3)?.items, ['1:3', '1:4'])
    assert.deepEqual(owner(9)?.items, ['1:9', '1:10'])
  }
)

it.each([0, 6])('joins a measurement comparison across opposite page rails (shift=%s)', (shift) => {
  const open = { hasEOL: false }
  const gap = { ...open, size: 0 }
  const header = { ...open, fontName: 'header' }
  const page = (page: number, items: PdfLayoutTextItem[]): PdfLayoutPage => ({
    page,
    width: 612,
    height: 792,
    rotation: 0,
    items
  })
  const { units } = groupPdfTranslationPages({
    pageCount: 3,
    pages: [
      page(1, [item('Draft version April 8, 2025', 60, 733, 123, { ...header, size: 8 })]),
      page(2, [
        item('2', 51, 740, 5, open),
        item(' ', 56, 740, 215, gap),
        item('Walker et al.', 271, 740, 76, header),
        item('the sample includes stars in the reference sequence', 321, 121.5, 241),
        item('which were measured as part of the original survey.', 321, 109, 241),
        item('For the remaining samples the amount of light', 321, 96.5, 241),
        item('was estimated by comparing it to other stars in', 321, 84, 241, open)
      ]),
      page(3, [
        item('Report on sample measurements', 232, 740, 147, header),
        item(' ', 379, 740, 178, gap),
        item('3', 557, 740, 5),
        item('the reference sequence which covered B magnitudes', 51 + shift, 717.5, 241),
        item('from 5 to 15.', 51 + shift, 705, 57, open),
        item('', 142, 634, 0, { size: 0 }),
        item('3.', 142, 634, 7, { ...open, size: 9, fontName: 'section' }),
        item(' ', 149, 634, 6, gap),
        item('FINDINGS', 155, 634, 45),
        item('The amended measurements show a different trend.', 330, 692.5, 232),
        item('No further samples were excluded from the analysis.', 321, 667.5, 241),
        item('The additional checks passed.', 455, 655, 107)
      ])
    ]
  })
  const comparison = units.find((unit) => unit.items.includes('2:6'))
  assert.equal(comparison?.items.includes('3:3'), shift === 0)
  assert.equal(comparison?.fragments.length, shift ? 1 : 2)
  assert.deepEqual(units.find((unit) => unit.items.includes('3:0'))?.items, ['3:0'])
})

it.each([0, 8])('keeps a terminal hanging bibliography on its native rows (shift=%s)', (shift) => {
  const open = { hasEOL: false }
  const citation = { fontName: 'citation', size: 9 }
  const styled = { ...citation, fontName: 'journal', hasEOL: false }
  const units = translationUnits([
    ...Array.from({ length: 12 }, (_, n) =>
      item('The observations agree with the independent control experiment.', 56, 435 - n * 12, 382)
    ),
    item('Acknowledgment', 56, 286, 90, { ...open, fontName: 'section' }),
    item('', 66, 271, 0, { size: 0 }),
    item('The project received research funding.', 66, 271, 371, open),
    item('', 56, 239, 0, { size: 0 }),
    item('References', 56, 239, 54, { ...open, fontName: 'section' }),
    item('', 56, 225, 0, { size: 0 }),
    item('Harper, I., and Reeves, B. 2001,', 56, 225, 134, { ...citation, ...open }),
    item('Field Review', 193, 225, 49, styled),
    item(', 12, 48', 242, 225, 28, citation),
    item(
      'Reeves, B., Bell, S., and Stone, K. 2004, in Field Methods Meeting, Research Methods Series',
      56,
      214,
      381,
      citation
    ),
    item('Annual Meeting, 271', 76 + shift, 204, 86, citation),
    item('Bell, S. 2007, Field Review, 16, 289', 56, 193, 141, citation),
    item('Raine, M. 2012, Field Review, 31, 78', 56, 182, 155, citation),
    item('Stone, K. 2017, Research Reports, 8, A14', 56, 171, 165, citation),
    item('Wells, J. 2020, Research Reports, 12, 159', 56, 160, 168, { ...citation, ...open })
  ])
  const bibliography = units.filter((unit) =>
    unit.items.some((key) => Number(key.split(':')[1]) >= 16)
  )
  assert.equal(bibliography.length, shift ? 3 : 2)
  assert.ok(bibliography.every((unit) => Boolean(unit.sourceOnly) === (shift === 0)))
  if (shift === 0) {
    assert.ok(bibliography.every((unit) => unit.preserve === 'reference'))
  }
  assert.deepEqual(
    bibliography.flatMap((unit) => unit.items),
    [16, 18, 19, 20, 21, 22, 23, 24, 25, 26].map((index) => `1:${index}`)
  )
  assert.ok(units.filter((unit) => !bibliography.includes(unit)).every((unit) => !unit.sourceOnly))
})

it.each([
  { figure: 3, comparison: 'The fluctuating sensor shows many', joins: true },
  { figure: 4, comparison: 'The fluctuating sensor shows many', joins: false },
  {
    figure: 3,
    comparison: 'A second trace (top panel in Fig. 4). The sensor shows many',
    joins: true
  },
  { figure: 3, comparison: 'shows many', joins: false }
])('joins a panel comparison across pages (case $#)', ({ figure, comparison, joins }) => {
  const open = { hasEOL: false }
  const caption = { size: 9, fontName: 'caption' }
  const gap = { size: 0 }
  const first = [
    item('Field notes on repeated sensor runs', 56, 682, 247, { fontName: 'title', size: 13 }),
    item('Independent measurements suggest the peak was reproducible.', 56, 191, 382),
    item('The steady sensor produced the same samples as the reference', 66, 162, 372),
    item(`run (top panel in Fig. 3). ${comparison}`, 56, 150, 382),
    item('1', 244.5, 132, 5, open)
  ]
  const second = [
    item('2', 56, 754, 5, open),
    item('Field notes', 221, 754, 50, open),
    item(`Figure ${figure}.`, 56, 455, 44, { ...caption, ...open, fontName: 'label' }),
    item(
      'Signal traces. (top) The steady sensor confirms the reference response.',
      104,
      455,
      334,
      caption
    ),
    item(
      '(bottom) The fluctuating sensor shows extra peaks at several positions.',
      56,
      445,
      382,
      caption
    ),
    item('Minute intervals were used.', 56, 435, 110, { ...caption, ...open }),
    item('', 56, 412, 0, gap),
    item('secondary peaks caused by the drift (bottom panel in', 56, 412, 382),
    item('Fig. 3). The response pattern is consistent over the whole run.', 56, 400, 382),
    item('All measurements were valid according to the original control procedure.', 56, 388, 382)
  ]
  const { units } = groupPdfTranslationPages({
    pages: [first, second].map((items, i) => ({
      width: 612,
      height: 792,
      rotation: 0,
      page: i + 1,
      items
    }))
  })
  const head = units.find((unit) => unit.items.includes('1:3'))
  assert.equal(head?.items.includes('2:7'), joins, JSON.stringify(units))
  assert.equal(head?.fragments.length, joins ? 2 : 1)
  assert.deepEqual(units.find((unit) => unit.items.includes('2:2'))?.items, [
    '2:2',
    '2:3',
    '2:4',
    '2:5'
  ])
  assert.equal(units.filter((unit) => unit.items.includes('2:7')).length, 1)
})

it.each([0, 5])('joins a native prose wrap after an inline sum (shift=%s)', (shift) => {
  const body = { size: 11, hasEOL: false }
  const glyph = { ...body, fontName: 'symbol' }
  const subscript = { ...body, size: 8, fontName: 'script' }
  const space = (x: number, y: number, width = 0): PdfLayoutTextItem =>
    item(width ? ' ' : '', x, y, width, { size: 0, hasEOL: !width })
  const lead = 'of batches omitted from the records. Failing to obtain one of the omitted'
  const follow = 'batches under this rule ends the check.'
  const units = groupPdfTranslationPages({
    pages: [
      ...[1, 2].map((page) => ({ page, width: 596, height: 842, rotation: 0, items: [] })),
      {
        page: 3,
        width: 596,
        height: 842,
        rotation: 0,
        items: [
          item('COUNTS FOR INDEPENDENT SAMPLING', 186, 762, 224, { size: 8, hasEOL: false }),
          space(410, 762, 108),
          item('3', 518, 762, 4, { size: 8, hasEOL: false }),
          space(72, 738),
          item('total', 72, 738, 36, body),
          space(108, 738, 4),
          item('∑', 112, 746, 10, { ...glyph, size: 10 }),
          space(122, 735),
          item('j', 122, 735, 3, subscript),
          item('∈', 125, 735, 6, { ...glyph, size: 8 }),
          item('[', 131, 735, 2, { ...subscript, fontName: 'punctuation' }),
          item('b', 133.5, 735, 3.5, subscript),
          item(']', 137, 735, 2.5, { ...subscript, fontName: 'punctuation' }),
          space(139.5, 735, 2.5),
          item('y', 142, 738, 6, { ...body, fontName: 'math' }),
          item('j', 148, 736.4, 3, subscript),
          space(151, 736.4, 4),
          item(lead, 155, 738, 367, { ...body, hasEOL: true }),
          item(follow, 72 + shift, 724, 190, { ...body, hasEOL: true }),
          item('The following estimate is obtained by a different argument.', 84, 711, 370, {
            ...body,
            hasEOL: true
          })
        ]
      }
    ],
    pageCount: 3
  }).units
  const owner = units.find((unit) => unit.items.includes('3:17'))
  assert.equal(owner?.source, shift ? lead : `${lead} ${follow}`)
  assert.equal(owner?.sourceOnly, undefined)
  assert.equal(owner?.fragments.length, shift ? 1 : 2)
  assert.equal(units.find((unit) => unit.items.includes('3:6'))?.preserve, 'formula')
  assert.equal(units.find((unit) => unit.items.includes('3:14'))?.preserve, 'formula')
})

it.each([0, 6])('joins a figure locator after a styled inline variable (shift=%s)', (shift) => {
  const open = { hasEOL: false }
  const units = translationUnits([
    item('Before each trial, the samples are compared with the baseline.', 325, 664, 234),
    item('The settings stay fixed during the repeat observations.', 315, 652, 244),
    item('The measured', 315, 640, 77, open),
    item(' ', 392, 640, 3, { ...open, size: 0 }),
    item('R', 395, 640, 8, { ...open, fontName: 'math' }),
    item(' ', 403, 640, 3, { ...open, size: 0 }),
    item('for these samples is reported in', 406, 640, 153),
    item('Fig. 2.', 315 + shift, 628, 29),
    item('The next experiment used a separate set of benchmarks.', 325, 616, 234)
  ])
  const owner = units.find((unit) => unit.items.includes('1:6'))
  assert.equal(owner?.items.includes('1:7'), shift === 0)
  assert.equal(owner?.items.includes('1:8'), false)
})

it.each([0, 6])('joins the short centered end of a draft title (shift=%s)', (shift) => {
  const open = { hasEOL: false }
  const blank = item('', 0, 0, 0, { size: 0 })
  const title = { fontName: 'title' }
  const top = 'FORECAST METHODS FOR RECURRING CHANGES IN MULTIYEAR WATER LEVEL'
  const tail = 'MEASUREMENTS'
  const owners = translationUnits([
    item('Draft version April 7, 2025', 60, 739, 115, { ...open, size: 8 }),
    blank,
    item('Preprint typeset using LATEX style ArticleTools', 60, 731, 200, {
      ...open,
      size: 7,
      fontName: 'imprint'
    }),
    blank,
    item(top, 56, 684, 500, title),
    item(tail, 270 + shift, 673.4, 72, { ...title, ...open }),
    blank,
    item('J. Example', 281, 659, 50, { ...open, size: 9, fontName: 'authors' }),
    blank,
    item('Department of Field Studies, Example University', 121, 649, 370, {
      ...open,
      size: 8,
      fontName: 'office'
    }),
    blank,
    item('ABSTRACT', 278, 585, 56, title),
    item('Several recordings establish the baseline measurement.', 86, 569, 440)
  ])
  const titleOwner = owners.find((u) => u.items.includes('1:4'))
  assert.equal(titleOwner?.source, shift ? top : top + ' ' + tail, JSON.stringify(owners))
  assert.equal(titleOwner?.fragments.length, shift ? 1 : 2)
  assert.equal(
    owners.some((u) => u.source === tail),
    shift !== 0
  )
})

it.each([0, 5])('joins a wrapped example after preserved inline math (shift=%s)', (shift) => {
  const prose = { size: 11, hasEOL: false }
  const script = { ...prose, size: 8, fontName: 'index' }
  const symbol = { ...prose, fontName: 'operator' }
  const lead = '. As another illustrative example'
  const follow = 'the following equation appears in the appendix:'
  const units = translationUnits([
    item('j−1', 300, 523, 12, script),
    item('∈', 320, 525, 7, symbol),
    item('N', 330, 525, 8, symbol),
    item(lead, 338, 525, 170, { ...prose, hasEOL: true }),
    item(follow, 120, 512 - shift, 300, prose),
    item('', 250, 492, 0, { size: 0 }),
    item('n', 250, 492, 5, script),
    item('∑', 245, 489, 16, symbol)
  ])
  const intro = units.find((unit) => unit.items.includes('1:3'))
  assert.equal(intro?.source, shift ? lead : `${lead} ${follow}`, JSON.stringify(units))
  assert.equal(intro?.fragments.length, shift ? 1 : 2)
  assert.equal(units.find((unit) => unit.items.includes('1:2'))?.preserve, 'formula')
  assert.equal(units.find((unit) => unit.items.includes('1:7'))?.preserve, 'formula')
})

it.each([0, 3])('retains a signed factor before a stacked binomial (shift=%s)', (shift) => {
  const base = { size: 11, hasEOL: false }
  const script = { ...base, size: 8, fontName: 'script' }
  const large = { ...base, fontName: 'large-operator' }
  const units = translationUnits([
    item('1', 361.7, 637, 4.2, { ...script, fontName: 'index-number' }),
    item('∑', 350.5, 633.7, 15.8, large),
    item('i', 351.6, 610.2, 2.9, script),
    item('=0', 354.5, 610.2, 10.8, { ...script, fontName: 'index-number' }),
    item('(', 366.4, 623.3, 4.2, base),
    item('−', 370.6, 623.3, 8.5, { ...base, fontName: 'operator' }),
    item('1)', 379.1, 623.3, 9.6, base),
    item('it', 388.7, 627.9, 8, script),
    item('(', 397.2, 638.8, 8.1, large),
    item('2', 405.3, 630.7, 5.4, base),
    item('m', 410.7, 630.7, 4.9, { ...base, fontName: 'variable', hasEOL: true }),
    item('i', 408.7 + shift, 615.8, 3.8, { ...base, fontName: 'variable' }),
    item(')', 415.9, 638.8, 8, large)
  ])
  const factor = units.find((unit) => unit.items.includes('1:7'))
  assert.equal(factor?.source, '(−1)it')
  assert.deepEqual(factor?.items, ['1:4', '1:5', '1:6', '1:7'])
  assert.equal(factor?.preserve, shift ? undefined : 'formula')
  assert.equal(factor?.sourceOnly, shift ? undefined : true)
})

it.each([0, 5])('keeps linked authors above their numbered institutions (%s)', (shift) => {
  const author = { hasEOL: false, size: 9, fontName: 'author' }
  const index = { ...author, size: 6, fontName: 'index' }
  const address = { ...author, size: 8, fontName: 'address' }
  const units = translationUnits(
    [
      item('', 92, 656.3, 0, { size: 0 }),
      item('Avery J. Carter,', 92, 656.3, 95, author),
      item('1, 2', 187, 660.1, 11, index),
      item('Jamie A. Reed,', 201, 656.3, 77, author),
      item('1, 3', 278, 660.1, 11, index),
      item('Ren M. Bell,', 292, 656.3, 97, author),
      item('4', 389, 660.1, 4, index),
      item('and Sam D. Brooks', 397, 656.3, 94, author),
      item('1, 2, 5, 6', 491, 660.1, 25, { ...index, hasEOL: true }),
      item('1', 82 + shift, 642.2, 4, index),
      item(
        'Northern Valley University, Field Studies, Meadow City, 10001',
        86 + shift,
        639.4,
        445,
        address
      ),
      item('', 156, 630.7, 0, { size: 0 }),
      item('2', 156, 630.7, 4, index),
      item('Lakeside Research Institute, Science Park, Elm City, 20003', 160, 627.9, 296, address),
      item('River Monitoring Observatory, Willow Road, Bay City', 176, 605, 266, address)
    ].map((row) => ({ ...row, fontAscent: 0.694, fontDescent: -0.194 }))
  )
  const byline = units.find((unit) => unit.items.includes('1:1'))
  assert.ok(byline)
  assert.equal(Boolean(byline.sourceOnly), shift === 0)
  if (!shift) {
    assert.equal(byline.items.includes('1:9'), false)
    assert.deepEqual(units.find((unit) => unit.items.includes('1:9'))?.items, ['1:9', '1:10'])
  }
})

it.each([0, 5])('joins a centered title confirmed by the abstract (shift=%s)', (shift) => {
  const title = { fontName: 'title', size: 11 }
  const names = { size: 9, fontName: 'name', hasEOL: false }
  const blank = item('', 0, 0, 0, { size: 0 })
  const head = 'A NOTE ON THE FORMULA IN ROWAN’S'
  const tail = 'FINITE MATRIX HANDBOOK'
  const units = translationUnits([
    item(head, 113, 696, 386, title),
    item(tail, 224 + shift, 682, 164, { ...title, hasEOL: false }),
    blank,
    item('JAMIE A. REED AND SAM BROOKS', 200, 652, 212, names),
    blank,
    item('Abstract.', 135, 623, 44, { size: 9, fontName: 'heading', hasEOL: false }),
    item('A formula in Rowan’s finite matrix handbook is derived again.', 184, 623, 294, {
      size: 9,
      fontName: 'name'
    })
  ])
  const owner = units.find((unit) => unit.items.includes('1:0'))
  assert.equal(owner?.source, shift ? head : `${head} ${tail}`, JSON.stringify(units))
  assert.equal(owner?.fragments.length, shift ? 1 : 2)
  assert.equal(owner?.items.includes('1:3'), false)
})

it.each([0, 5])('rejoins justified numbered keywords at a multiword term (shift=%s)', (shift) => {
  const units = translationUnits([
    item('Keywords:', 85, 555, 44, { fontName: 'label', hasEOL: false }),
    item('Optical sensors (1001), Field measurements (1002), Signal data', 133, 555, 390),
    item(
      'analysis (1003), Surface optics (1004), Calibration methods (1005)',
      132 + shift,
      542.5,
      391,
      {
        hasEOL: false
      }
    ),
    item('1.', 120, 507.5, 8, { hasEOL: false }),
    item('INTRODUCTION', 132, 507.5, 90),
    item('The measured signal varies across the range of sampling conditions.', 54, 495, 239)
  ])
  const keywords = units.find((unit) => unit.items.includes('1:0'))
  assert.equal(keywords?.source.includes('Signal data analysis (1003)'), shift === 0)
  assert.equal(keywords?.items.includes('1:2'), shift === 0)
  assert.equal(keywords?.items.includes('1:3'), false)
})

it.each([0, 18])('keeps a terminal acronym after a styled possessive (shift=%s)', (shift) => {
  const units = translationUnits([
    item('Figure 2.', 45, 420, 36, { fontName: 'label', hasEOL: false }),
    item('Each panel plots responses for a separate setting.', 85, 420, 190),
    item('The vertical guides mark measurements across', 45, 408, 178, { hasEOL: false }),
    item('Willow', 227, 408, 39, { fontName: 'emphasis', hasEOL: false }),
    item('’s', 266, 408, 9),
    item('LEDs.', 45 + shift, 396, 24)
  ])
  const caption = units.find((unit) => unit.items.includes('1:0'))
  assert.ok(caption)
  assert.equal(caption.source.endsWith('Willow’s LEDs.'), shift === 0)
  assert.equal(caption.items.includes('1:5'), shift === 0)
  assert.equal(units.filter((unit) => unit.items.includes('1:5')).length, 1)
})

it.each(['adjacent', 'shifted', 'display glyph'] as const)(
  'continues a scientific caption through a lowercase figure reference (%s)',
  (kind) => {
    const dx = kind === 'shifted' ? 22 : 0
    const units = translationUnits([
      item('Figure 7.', 45, 420, 35, { fontName: 'label', hasEOL: false }),
      item('The panels compare each sample with the corresponding control.', 83, 420, 202),
      item('For each setting the solid segment shows the median response.', 45, 409, 240),
      item('The right panel is calibrated against the function', 45, 398, 181, {
        hasEOL: false
      }),
      item('T', 230, 398, 6, { fontName: 'math', hasEOL: false }),
      item('(', 236, 398, 3, { hasEOL: false }),
      item('θ', 239, 398, 5, { fontName: 'math', hasEOL: false }),
      item(') shown in', 244, 398, 41),
      item('figure 8. Values in this example are greater than 2', 45 + dx, 387, 190, {
        hasEOL: false
      }),
      item('°', 235 + dx, kind === 'display glyph' ? 393 : 390, 3, {
        fontName: 'symbol',
        size: 7,
        hasEOL: false
      }),
      item(' in either group.', 238 + dx, 387, 47)
    ])
    const caption = units.find((unit) => unit.items.includes('1:0'))
    assert.equal(caption?.items.includes('1:8'), kind === 'adjacent')
    assert.equal(units.filter((unit) => unit.items.includes('1:8')).length, 1)
  }
)

it.each([true, false])('joins a short centered title above paired author marks (%s)', (witness) => {
  const title = { size: 12, fontName: 'title' }
  const name = { hasEOL: false }
  const ordinal = { fontName: 'ordinal', size: 7, hasEOL: false }
  const units = translationUnits([
    item(
      'Latency and Stability in Controlled Measurements for Multi-Channel Adaptive',
      73,
      730,
      470,
      title
    ),
    item('Sampling Systems', 236, 716, 144, title),
    item('Mira Stone', 208, 692, 76, name),
    item('1', 284, 696, 4, ordinal),
    item('and Ellis Reed', 294, 692, 110, name),
    item('2', 404, 696, 4, { ...ordinal, hasEOL: true }),
    item(
      witness
        ? 'We compare adaptive sampling methods using independent controls.'
        : 'We compare fixed intervals using independent controls.',
      115,
      639,
      386,
      { size: 9 }
    ),
    item('The recorded measurements show reproducible differences in both settings.', 54, 585, 470),
    item('All parameters are reported in the accompanying analysis.', 54, 573, 400)
  ])
  const owner = units.find((unit) => unit.items.includes('1:0'))
  assert.equal(owner?.items.includes('1:1'), witness)
  assert.equal(units.filter((unit) => unit.items.includes('1:1')).length, 1)
})

it.each([true, false])(
  'joins a centered title when its short final phrase opens the abstract (%s)',
  (repeated) => {
    const lead = 'From Signals to Sensors: A Practical Method for Comparing'
    const tail = 'Reference Readings'
    const title = { size: 12, fontName: 'title' }
    const author = { hasEOL: false }
    const office = { size: 9, fontName: 'office', hasEOL: false }
    const abstract = { size: 9, fontName: 'abstract' }
    const units = translationUnits([
      item(lead, 78, 730, 460, title),
      item(tail, 249, 716, 118, { ...title, hasEOL: false }),
      item('Ada Field', 278, 692, 56, author),
      item('∗', 334, 695.5, 4, { size: 7, fontName: 'marker', hasEOL: false }),
      item('Department of Instrumentation, Example Institute', 110, 681.5, 396, office),
      item('Rene Lane', 263, 657.5, 90, author),
      item('Independent Researcher', 260, 647, 96, office),
      item('(Dated: April 3, 2024)', 262, 636.5, 92, abstract),
      item(
        `${repeated ? 'Reference readings' : 'Signal traces'} preserve the dynamic response under controlled sampling conditions.`,
        118,
        619.5,
        381,
        { ...abstract, hasEOL: false }
      ),
      item('The working group tested each probe independently.', 54, 238, 221, author)
    ])
    const owner = units.find((unit) => unit.items.includes('1:0'))
    assert.equal(owner?.source, repeated ? lead + ' ' + tail : lead)
    assert.deepEqual(owner?.items, repeated ? ['1:0', '1:1'] : ['1:0'])
    assert.equal(units.filter((unit) => unit.items.includes('1:1')).length, 1)
  }
)

it.each(['marked authors', 'unmarked author', 'off-center title'])(
  'joins two centered title rows above an marked byline (%s)',
  (shape) => {
    const lead = 'Two Practical Schemes for Frequency Calibration without'
    const tail = 'direct external field measurements'
    const title = { fontName: 'title', size: 17 }
    const author = { fontName: 'byline', size: 12, hasEOL: false }
    const marker = { fontName: 'mark', size: 8, hasEOL: false }
    const units = translationUnits([
      item(lead, 167, 665, 278, title),
      item(tail, shape === 'off-center title' ? 188 : 183, 643, 246, {
        ...title,
        hasEOL: false
      }),
      item('', 0, 0, 0, { size: 0 }),
      item('A. B. Meadow', 210, 613, 86, author),
      item('∗', 296, 617, 4, marker),
      item('J. C. Vale', 326, 613, 67, author),
      item(shape === 'unmarked author' ? '•' : '†', 393, 617, 5, marker),
      item('', 0, 0, 0, { size: 0 }),
      item('Abstract', 286, 561, 40, { fontName: 'heading' }),
      item('The measured values remain stable across the selected operating range.', 91, 543, 420)
    ])
    const owner = units.find((unit) => unit.items.includes('1:0'))
    const merged = shape === 'marked authors'
    assert.equal(owner?.source, merged ? lead + ' ' + tail : lead)
    assert.equal(owner?.items.includes('1:1'), merged)
    assert.equal(units.filter((unit) => unit.items.includes('1:1')).length, 1)
  }
)

it.each(['aligned', 'shifted', 'no heading'] as const)(
  'keeps the last numbered keyword on its hanging rail (%s)',
  (kind) => {
    const units = translationUnits([
      item('Keywords:', 85, 498, 44, { fontName: 'label', hasEOL: false }),
      item(
        'Thermal flux (1201), Sensor data (1202), Remote imaging (1203), Wide field',
        133,
        498,
        389
      ),
      item('imaging (1204)', kind === 'shifted' ? 141 : 133, 485.5, 76),
      item(kind === 'no heading' ? 'OBSERVATIONS' : 'INTRODUCTION', 264, 450, 84),
      item('We show the calibrated measurements for each source in the next section.', 50, 432, 510)
    ])
    const keywords = units.find((unit) => unit.items.includes('1:0'))
    assert.equal(keywords?.source.endsWith('Wide field imaging (1204)'), kind === 'aligned')
    assert.equal(keywords?.items.includes('1:2'), kind === 'aligned')
    assert.equal(keywords?.items.includes('1:3'), false)
  }
)

it.each(['centered address', 'shifted address', 'missing postal code'])(
  'keeps a centered postal continuation with its numbered affiliation (%s)',
  (placement) => {
    const marker = { fontName: 'ordinal', size: 6, hasEOL: false }
    const body = { fontName: 'address', size: 8 }
    const breakLine = item('', 0, 0, 0, { size: 0 })
    const units = translationUnits([
      item('Department Affiliations', 215, 665, 182, { size: 13 }),
      item('1', 126, 592, 4, marker),
      item('Department of Field Studies, West Campus, Hill Town', 130, 589.2, 352, body),
      item('2', 52, 580.6, 4, marker),
      item(
        'Example Observatory, Independent Research Foundation, P.O. Box 42,',
        56,
        577.8,
        500,
        body
      ),
      item(
        placement === 'missing postal code'
          ? 'Sample City, BC, Canada'
          : 'Sample City, BC A1B 2C3, Canada',
        placement === 'shifted address' ? 248 : 238,
        568.3,
        136,
        { ...body, hasEOL: false }
      ),
      breakLine,
      item('3', 121, 559.6, 4, marker),
      item('Institute for Signal Analysis, North Campus, Lake City', 125, 556.8, 362, body)
    ])
    const affiliation = units.find((unit) => unit.items.includes('1:4'))
    assert.equal(affiliation?.items.includes('1:5'), placement === 'centered address')
    assert.equal(affiliation?.items.includes('1:7'), false)
    assert.equal(units.filter((unit) => unit.items.includes('1:5')).length, 1)
  }
)

it.each(['wrap', 'shifted', 'closed prose'] as const)(
  'retains the terminal signed decibel list with its prose (%s)',
  (kind) => {
    const x = kind === 'shifted' ? 317 : 54
    const continued = { hasEOL: false }
    const sign = { ...continued, fontName: 'symbol' }
    const digit = { ...continued, fontName: 'math' }
    const units = translationUnits([
      item('The experiment measured the response of each independent', 54, 451, 242),
      item(
        kind === 'closed prose'
          ? 'sample before recording the results in its original form.'
          : 'sample at the configured levels of [30, 15, 5,',
        54,
        439,
        242
      ),
      item('0,', x, 427, 6, continued),
      item('−', x + 9, 427, 6, sign),
      item('5', x + 15, 427, 5, digit),
      item(',', x + 20, 427, 2, continued),
      item('−', x + 25, 427, 6, sign),
      item('15', x + 31, 427, 9, digit),
      item('] dB.', x + 40, 427, 18),
      item('The next trial controls for the earlier measurements.', 64, 415, 232)
    ])
    const owner = units.find((unit) => unit.items.includes('1:0'))
    assert.equal(owner?.source.endsWith('[30, 15, 5, 0, −5, −15] dB.'), kind === 'wrap')
    assert.equal(owner?.items.includes('1:8'), kind === 'wrap')
    assert.equal(owner?.items.includes('1:9'), false)
  }
)

it.each(['wrap', 'shifted', 'closed prose'] as const)(
  'retains a confidence level at the end of its native prose (%s)',
  (kind) => {
    const units = translationUnits([
      item(
        'We evaluated each outcome in an independent replication before reporting the final',
        54,
        451,
        401
      ),
      item('values. The adjusted estimate', 54, 438.5, 170, { hasEOL: false }),
      item('μ', 230, 438.5, 6, { fontName: 'math', hasEOL: false }),
      item(
        kind === 'closed prose' ? 'is similar to our prior result.' : 'is significantly below the',
        242,
        438.5,
        213
      ),
      item('90% CI.', kind === 'shifted' ? 317 : 54, 426, 31, { hasEOL: false })
    ])
    const body = units.find((unit) => unit.items.includes('1:0'))
    assert.ok(body?.items.includes('1:3'))
    assert.equal(body.items.includes('1:4'), kind === 'wrap')
    assert.equal(body.source.endsWith('90% CI.'), kind === 'wrap')
    assert.equal(units.filter((unit) => unit.items.includes('1:4')).length, 1)
  }
)

it.each(['wrapped citation', 'shifted year', 'unopened citation'] as const)(
  'keeps the closing year with its no-comma author citation (%s)',
  (kind) => {
    const units = translationUnits([
      item(
        'We fit the response independently before recording the final estimate for each',
        54,
        451,
        400
      ),
      item('R', 54, 438.5, 9, { fontName: 'math', hasEOL: false }),
      item('0', 63, 437, 5, { fontName: 'script', size: 7, hasEOL: false }),
      item(
        kind === 'unopened citation'
          ? 'value with the published benchmark results of L. Q. Writer'
          : 'value with the published benchmark for this instrument (L. Q. Writer',
        73,
        438.5,
        381
      ),
      item('2018).', kind === 'shifted year' ? 300 : 54, 426, 28, { hasEOL: false })
    ])
    const owner = units.find((unit) => unit.items.includes('1:0'))
    assert.ok(owner?.items.includes('1:3'))
    assert.equal(owner.items.includes('1:4'), kind === 'wrapped citation')
    assert.equal(owner.source.endsWith('(L. Q. Writer 2018).'), kind === 'wrapped citation')
    assert.equal(units.filter((unit) => unit.items.includes('1:4')).length, 1)
  }
)

it.each(['continued', 'shifted', 'ordinary next row'] as const)(
  'keeps a terminal predicate with its operator introduction (%s)',
  (shape) => {
    const open = { hasEOL: false }
    const math = { ...open, fontName: 'math' }
    const items = [
      item('while the scale factor e', 54, 631, 94, open),
      item('is independent of', 178, 631, 77, open),
      item('Hence in Eq. (2) only the', 279.5, 631, 118, open),
      item('Z', 402, 631, 6, math),
      item('-dependent part of the operator', 410, 631, 152),
      item('survives:', shape === 'shifted' ? 72 : 54, 619, 38, open),
      item('', 190, 591, 0, { fontName: 'math' }),
      item(
        shape === 'ordinary next row' ? 'New material begins here.' : 'ψ',
        190,
        591,
        shape === 'ordinary next row' ? 150 : 7,
        math
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 2, width: 612, height: 792, rotation: 0, items }],
      pageCount: 3
    })
    const prose = units.find((u) => u.items.includes('2:4'))
    assert.equal(prose?.items.includes('2:5'), shape === 'continued')
    assert.equal(prose?.source.endsWith('operator survives:'), shape === 'continued')
    assert.equal(prose?.items.includes('2:7'), false)
  }
)

it.each(['matched columns', 'closed first paragraph', 'intervening text'] as const)(
  'keeps a role phrase with the continued paragraph below a floating caption (%s)',
  (shape) => {
    const body = { size: 9 }
    const caption = { ...body, fontName: 'caption' }
    const end =
      shape === 'closed first paragraph'
        ? 'We chose the apparatus after evaluating a different practical tool.'
        : 'We considered several applications and ended up using it as'
    const tail = 'a field calibration device. These trials demonstrate that the'
    const items = [
      item('We developed several aids for independent measurements.', 54, 129, 240, body),
      item('The group evaluated them in a set of carefully matched sessions.', 54, 118, 240, body),
      item('The findings helped the team plan the next round of tests.', 54, 107, 240, body),
      item('This included exploring how a device might help other groups.', 54, 96, 240, body),
      item(end, 54, 85, 240, { ...body, hasEOL: false }),
      item('Figure 2. The comparison device used during the independent', 318, 594, 240, caption),
      item('measurements at a second station with a different source and', 318, 583, 240, caption),
      item('a measured reference profile.', 318, 572, 136, { ...caption, hasEOL: false }),
      ...(shape === 'intervening text'
        ? [item('A separate note appears below the drawing.', 318, 560, 170, body)]
        : []),
      item(tail, 318, 545, 240, body),
      item(
        'new equipment can be set up without changing the reference protocol.',
        318,
        534,
        240,
        body
      ),
      item('We report the remaining measurements in the next section.', 318, 523, 240, body),
      item('The raw data are archived.', 318, 512, 92, body)
    ]
    const units = translationUnits(items)
    const source = units.find((unit) => unit.items.includes('1:4'))
    assert.equal(source?.source.includes(tail), shape === 'matched columns')
    assert.ok(units.some((unit) => unit.items.join(',') === '1:5,1:6,1:7'))
  }
)

it.each(['centered', 'shifted', 'no abstract witness'])(
  'joins a plural noun phrase before a numbered byline (%s)',
  (shape) => {
    const title = {
      fontName: 'title'
    }
    const draft = { size: 8, hasEOL: false }
    const author = { size: 9, hasEOL: false }
    const mark = { ...author, size: 6 }
    const office = { size: 8 }
    const line = item('', 0, 0, 0, { size: 0 })
    const head =
      'A revised approach to identifying weak measurements in field surveys through independent'
    const tail = 'sensor readings'
    const units = translationUnits([
      item('Draft version May 8, 2025', 60, 733, 130, draft),
      line,
      item('Typeset using LATEX default style in ArticleTools', 60, 724, 141, {
        ...draft,
        fontName: 'small'
      }),
      line,
      item(head, 59, 676, 494, title),
      item(tail, shape === 'shifted' ? 286 : 269, 663.5, 74, { ...title, hasEOL: false }),
      line,
      item('Ann Reader,', 180, 647.5, 88, author),
      item('1', 268, 651.3, 4, mark),
      item('and Rob Writer', 280, 647.5, 148, author),
      item('2', 428, 651.3, 4, mark),
      line,
      item('1', 145, 633.3, 4, { ...mark, fontName: 'affiliation' }),
      item('Department of Measurement Science, North Institute', 150, 630.5, 317, office),
      line,
      item('2', 141, 621.8, 4, { ...mark, fontName: 'affiliation' }),
      item('Centre for Independent Sampling, West University', 146, 619, 325, office),
      line,
      item('ABSTRACT', 279, 595, 54, { fontName: 'abstract' }),
      item(
        shape === 'no abstract witness'
          ? 'We study independent measurements from two stations throughout the same survey.'
          : 'We study independent sensor readings from two stations throughout the same survey.',
        89,
        580,
        434,
        { fontName: 'abstract' }
      )
    ])
    const owner = units.find((unit) => unit.items.includes('1:4'))
    assert.equal(owner?.source, shape === 'centered' ? head + ' ' + tail : head)
    assert.equal(owner?.items.includes('1:5'), shape === 'centered')
    assert.equal(owner?.items.includes('1:7'), false)
  }
)

it.each(['aligned', 'shifted operand', 'unaligned relation'])(
  'retains a word-shaped binomial coefficient within aligned display rows (%s)',
  (shape) => {
    const glyph = { size: 12, fontName: 'Variable', hasEOL: false }
    const encoded = { ...glyph, fontName: 'Large operator' }
    const relation = { ...glyph, fontName: 'Relation' }
    const rows = [
      item('An estimate follows from the next calculation.', 66, 576, 260),
      item('≤', 237, 533, 9, relation),
      item('\u0012', 250, 550, 9, encoded),
      item('uv', shape === 'shifted operand' ? 277 : 272, 541, 14, { ...glyph, hasEOL: true }),
      item('u', 261, 525, 8, glyph),
      item('−', 273, 525, 10, relation),
      item('v', 288, 525, 9, glyph),
      item('\u0013', 299, 550, 9, encoded),
      item('≤', shape === 'unaligned relation' ? 247 : 237, 497, 9, relation),
      item('The preceding estimate remains valid.', 66, 467, 290)
    ].map((row) =>
      row.fontName === encoded.fontName ? { ...row, fontAscent: 0.04, fontDescent: -0.6 } : row
    )
    const units = translationUnits(rows)
    const atom = units.find((unit) => unit.items.includes('1:3'))
    assert.equal(atom?.source, 'uv')
    assert.equal(atom?.sourceOnly === true && atom.preserve === 'formula', shape === 'aligned')
    assert.equal(units.find((unit) => unit.items.includes('1:9'))?.sourceOnly, undefined)
  }
)

it.each(['aligned', 'offset marker', 'missing references'])(
  'keeps terminal numbered affiliations in their own native records (%s)',
  (shape) => {
    const names = [
      'North Institute',
      'Delta University',
      'School of Optics',
      'South Laboratory',
      'Eastern College'
    ]
    const entries = names.flatMap((name, index) => {
      const y = 216 - index * 20
      return [
        item(
          String(index + 1),
          shape === 'offset marker' && index === 3 ? 326.5 : 325,
          y + 3.3,
          3,
          { size: 6, hasEOL: false }
        ),
        item(name + ', Signal Road, 9021', 333, y, 166, { size: 9 }),
        item('Harbor City', 333, y - 10, 54, { size: 9 })
      ]
    })
    const { units } = groupPdfTranslationPages({
      pageCount: 2,
      pages: [
        {
          page: 1,
          width: 595,
          height: 842,
          rotation: 0,
          items: [item('Introduction', 40, 730, 110, { size: 9 })]
        },
        {
          page: 2,
          width: 595,
          height: 842,
          rotation: 0,
          items: [
            item(shape === 'missing references' ? 'Further reading' : 'References', 40, 170, 75, {
              size: 9
            }),
            item('Example, A. 2018, Studies, 20, 30', 320, 257, 171, { size: 8 }),
            item('Sample, B. 2021, Studies, 31, 22', 320, 247, 171, { size: 8 }),
            ...entries,
            item('Page two', 40, 86, 44, { size: 9 })
          ]
        }
      ]
    })
    const keys = entries.map((_, index) => `2:${index + 3}`)
    const owners = units.filter((unit) => unit.items.some((key) => keys.includes(key)))
    assert.deepEqual(
      owners.flatMap((unit) => unit.items),
      keys
    )
    assert.equal(
      owners.every((unit) => unit.sourceOnly === true),
      shape === 'aligned'
    )
    if (shape === 'aligned') {
      assert.deepEqual(
        owners.map((unit) => unit.items),
        names.map((_, index) => keys.slice(index * 3, index * 3 + 3))
      )
    }
  }
)

it.each([0, 4])('joins a cited word at the end of a native paragraph (shift=%s)', (shift) => {
  const continues = { hasEOL: false }
  const units = translationUnits([
    item('The earlier problem was resolved by comparing the complete set.', 72, 600, 330),
    item('We use an independent estimate for a related prob-', 82, 588, 320),
    item('lem [', 72 + shift, 576, 22, continues),
    item('7', 94 + shift, 576, 5, continues),
    item('].', 99 + shift, 576, 6, continues),
    item('Department of Applied Measurement', 82, 558, 182, { fontName: 'affiliation' })
  ])
  const owner = units.find((unit) => unit.items.includes('1:1'))
  assert.equal(owner?.sourceOnly, undefined)
  assert.equal(owner?.source.endsWith('related problem [7].'), shift === 0)
  assert.equal(owner?.items.includes('1:3'), shift === 0)
  assert.equal(units.filter((unit) => unit.items.includes('1:3')).length, 1)
})

it.each([0, 3])(
  'joins native body text around a split author-year citation (shift=%s)',
  (shift) => {
    const continues = { hasEOL: false }
    const units = translationUnits([
      item('A separate introduction uses the left column for context.', 64, 620, 229),
      item('The preceding experiment followed the published method.', 64, 608, 229),
      item('The conditions were selected before the measurements.', 64, 596, 229),
      item('This note presents three independent measurements', 319, 620, 214),
      item('using a calibrated instrument in the initial', 304, 608, 229),
      item('comparison. The proposed simulation', 304, 596, 229),
      item('model (', 304 + shift, 584, 34, continues),
      item('Waller 2006', 338 + shift, 584, 49, continues),
      item(') describes a familiar process', 387 + shift, 584, 146),
      item('across the measured range and shows a stable result.', 304, 572, 229),
      item('The records are available for further inspection.', 319, 548, 214)
    ])
    const paragraph = units.find((unit) => unit.items.includes('1:5'))
    const prefix = units.filter((unit) => unit.items.includes('1:6'))
    assert.equal(prefix.length, 1)
    assert.equal(
      paragraph?.source.includes('simulation model (Waller 2006) describes'),
      shift === 0
    )
    assert.equal(prefix[0] === paragraph, shift === 0)
    assert.equal(prefix[0].preserve, shift === 0 ? undefined : 'formula')
  }
)

it.each([0, 2])('keeps an attached flux measurement within its figure caption (%s)', (gap) => {
  const run = { hasEOL: false }
  const roman = 'caption'
  const units = translationUnits([
    item('Fig. 4.', 60, 520, 32, { ...run, fontName: 'label' }),
    item(
      'The panels show an independent measurement of a calibrated signal over the full field.',
      95,
      520,
      449,
      { fontName: roman }
    ),
    item('Contours are drawn at fixed intervals where the signal ranges between', 60, 508, 484, {
      fontName: roman
    }),
    item('12 and 38', 60, 496, 45, { ...run, fontName: roman }),
    item('μ', 108, 496, 6, { ...run, fontName: 'symbol' }),
    item('Jy. The beam is shown in the lower corner.', 114 + gap, 496, 227, { fontName: roman })
  ])
  const caption = units.find((unit) => unit.items.includes('1:0'))
  assert.equal(caption?.source.includes('between 12 and 38 μJy.'), gap === 0)
  assert.equal(caption?.items.includes('1:4'), gap === 0)
  assert.equal(units.filter((unit) => unit.items.includes('1:4')).length, 1)
})

it.each([true, false])('keeps repeated centered figure caption endings together (%s)', (match) => {
  const openings = [
    'Direction of the incident signal',
    'Shape of the outgoing intensity',
    'Measured change in the beam',
    'Profile of the reference field'
  ]
  const endings = [
    'using three independent modules.',
    'after calibration of the sensors.',
    'as viewed from the midpoint.',
    'before the source is adjusted.'
  ]
  const units = translationUnits(
    openings.flatMap((opening, n) => {
      const y = 680 - n * 140
      const caption = { size: 9, fontName: 'caption', hasEOL: false }
      const label = { ...caption, fontName: !match && n === 2 ? 'other-label' : 'label' }
      return [
        item('Figure', 322, y, 28, label),
        item(String(n + 1), 352, y, 5, label),
        item('.', 357, y, 2.5, label),
        item(opening, 362, y, 188, caption),
        item('', 368, y - 10.4, 0, { size: 0 }),
        item(endings[n].slice(0, -1), 368, y - 10.4, 133.5, caption),
        item('.', 501.5, y - 10.4, 2.5, caption)
      ]
    })
  )
  const captions = units.filter((unit) => /^Figure \d\. /u.test(unit.source))
  assert.equal(captions.length, 4)
  for (let n = 0; n < openings.length; n++) {
    const head = `Figure ${n + 1}. ${openings[n]}`
    assert.equal(captions[n].source, match ? `${head} ${endings[n]}` : head)
    assert.equal(captions[n].fragments.length, match ? 2 : 1)
  }
})

it.each([2019, 2018])(
  'keeps a repeated accented citation together across native rows (%s)',
  (year) => {
    const col = 320.579
    const closed = { size: 9.9626 }
    const open = { ...closed, hasEOL: false }
    const space = { size: 0, hasEOL: false }
    const units = translationUnits([
      item(
        'Our independent survey identifies the source as M804 Field, a',
        col + 9,
        411.52,
        232.358,
        closed
      ),
      item('similar object among the young group in the Western', col, 399.067, 241.364, closed),
      item('Sector (Voˇ', col, 386.613, 52.11, open),
      item('ba´', 368.818, 386.613, 11.064, open),
      item('n et al. 2019). The group has an inferred age', 376.011, 386.613, 185.932, closed),
      item('of 5 Myr and is at a distance of 630', col, 374.16, 150.744, open),
      item(' ', 471.323, 374.16, 2.972, space),
      item('±', 474.295, 374.16, 7.749, { ...open, fontName: 'symbol' }),
      item(' ', 482.044, 374.16, 2.976, { ...space, fontName: 'symbol' }),
      item('17 pc (Voˇ', 485.02, 374.16, 46.346, open),
      item('ba´', 527.495, 374.16, 11.064, open),
      item('n et al.', 534.688, 374.16, 27.248, closed),
      item(year + ').', col, 361.707, 25.733, closed),
      item(
        'The collected sample is consistent with the revised model',
        col + 9,
        349.253,
        232.358,
        closed
      ),
      item('under the conditions described in the following section.', col, 336.8, 241.364, closed)
    ])
    const owner = units.find((unit) => unit.items.includes('1:0'))
    assert.equal(owner?.source.includes('Sector (Voˇba´n et al. 2019). The group'), year === 2019)
    assert.equal(owner?.items.includes('1:12'), year === 2019)
    assert.equal(
      units.find((unit) => unit.items.includes('1:12'))?.sourceOnly,
      year === 2019 ? undefined : true
    )
    assert.equal(units.filter((unit) => unit.items.includes('1:12')).length, 1)
  }
)

it.each([0, 5])('joins only a centered postal address continuation (%s)', (shift) => {
  const row = (
    index: number,
    name: string,
    width: number,
    y: number,
    hasEOL = false
  ): PdfLayoutTextItem[] => [
    item(String(index), (612 - width) / 2 - 4.5, y + 3.6, 4, {
      fontName: 'marker',
      size: 7,
      hasEOL: false
    }),
    item(name, (612 - width) / 2, y, width, { fontName: 'address', hasEOL })
  ]
  const units = translationUnits([
    item('A new approach to steady-state measurements', 91, 665, 430, {
      size: 16,
      fontName: 'title'
    }),
    item('Ann Example and Robert Example', 183.5, 608, 245, { size: 12, fontName: 'byline' }),
    ...row(
      1,
      'Central Research University, 18 Bennet Road, Metro City, 75231, USA',
      408,
      558,
      true
    ),
    ...row(2, 'Meridian Science Institute, 32 Hill Road, Plainview, IL 61832, USA', 380, 535),
    ...row(3, 'Department of Physics, Meridian University, AB-452 82', 379, 522, true),
    item('Hillside, Finland', 262 + shift, 512.5, 88, { fontName: 'address', hasEOL: false }),
    ...row(4, 'Department of Engineering, 300 Center Street, Westfield, MO 63821', 338, 499.5),
    item('ABSTRACT', 276, 441, 60, { size: 12 }),
    item(
      'The measured response remains similar across the independent test conditions.',
      91,
      420,
      430,
      {
        size: 12
      }
    )
  ])
  const head = units.find((unit) => unit.items.includes('1:6'))
  const tail = units.find((unit) => unit.items.includes('1:8'))
  assert.ok(head && tail)
  assert.equal(head === tail, shift === 0)
  assert.deepEqual(head.items, shift ? ['1:6', '1:7'] : ['1:6', '1:7', '1:8'])
  assert.equal(head.fragments.length, shift ? 1 : 2)
})

it.each(['valid', 'spacing', 'face', 'baseline', 'terminal', 'detached', 'year', 'prime'])(
  'joins a split accented author-date citation only with native prose evidence (%s)',
  (mode) => {
    const x = 70
    const units = translationUnits([
      item('A careful record of the original conditions accompanies', x + 9, 530, 231),
      item(
        'the software package developed by the laboratory' + (mode === 'terminal' ? '.' : ''),
        x,
        517.5,
        240
      ),
      item(mode === 'prime' ? '(T′' : '(T´', x, mode === 'detached' ? 502.5 : 505, 14, {
        hasEOL: false
      }),
      item('anner-D´', x + (mode === 'spacing' ? 13 : 9), mode === 'baseline' ? 503 : 505, 38, {
        hasEOL: false,
        fontName: mode === 'face' ? 'other' : 'body'
      }),
      item(
        `over et al. ${mode === 'year' ? '200' : '2002'}) for cases that had a stable`,
        x + 42,
        505,
        198
      ),
      item('reference value and adequate calibration of the current', x, 492.5, 240),
      item('instruments, together with matching monthly reports.', x, 480, 217),
      item('The following experiment describes a separate model.', x + 9, 467.5, 227)
    ])
    const citationOwners = units.filter((unit) => unit.items.includes('1:2'))
    assert.equal(citationOwners.length, 1)
    const [owner] = citationOwners
    if (mode === 'valid') {
      assert.equal(owner.sourceOnly, undefined)
      assert.ok(owner.source.includes('laboratory (T´anner-D´over et al. 2002) for cases'))
      assert.deepEqual(
        owner.items,
        Array.from({ length: 7 }, (_, index) => `1:${index}`)
      )
      assert.equal(owner.fragments.length, 1)
    } else {
      assert.equal(owner.sourceOnly, true)
      assert.equal(owner.preserve, 'formula')
      assert.deepEqual(owner.items, ['1:2'])
    }
  }
)

it.each(['lead-in', 'sentence', 'face', 'detached', 'year', 'baseline'])(
  'keeps a wrapped grave-accent author citation in its native prose (%s)',
  (mode) => {
    const x = 320
    const head = 'We applied the reference method and found a change'
    const prefix = mode === 'lead-in' ? 'by (Q. N`' : '(Q. N`'
    const suffix =
      mode === 'lead-in'
        ? ', we also recorded a useful response'
        : '. This second test records the response'
    const tail = `evan et al. ${mode === 'year' ? '202' : '2007'})${suffix}`
    const prefixWidth = mode === 'lead-in' ? 44 : 27
    const units = translationUnits([
      item('The procedure records measurements across several intervals', x + 9, 530, 231),
      item(head, x, 517.5, 240),
      item(prefix, x, 505, prefixWidth, { hasEOL: false }),
      item(
        tail,
        x + prefixWidth - (mode === 'detached' ? 1 : 4.7),
        mode === 'baseline' ? 503 : 505,
        240 - prefixWidth + 4.7,
        {
          fontName: mode === 'face' ? 'other' : 'body'
        }
      ),
      item('under the conditions described later in this study.', x, 492.5, 215)
    ])
    const owner = units.find((unit) => unit.items.includes('1:2'))
    assert.ok(owner)
    assert.equal(units.filter((unit) => unit.items.includes('1:2')).length, 1)
    if (mode === 'lead-in' || mode === 'sentence') {
      assert.equal(owner.sourceOnly, undefined)
      assert.ok(owner.source.includes(`${head} ${prefix}${tail}`))
      assert.deepEqual(owner.items, ['1:0', '1:1', '1:2', '1:3', '1:4'])
    } else {
      assert.equal(owner.items.includes('1:1') && owner.items.includes('1:3'), false)
    }
  }
)

it.each(['continuous', 'shifted tail', 'different claim'])(
  'keeps the final assertion word with the numbered claim before its proof (%s)',
  (shape) => {
    const italic = { fontName: 'italic', size: 12 }
    const italicRun = { ...italic, hasEOL: false }
    const variable = { ...italicRun, fontName: 'math' }
    const units = translationUnits([
      item('Claim 4.', 72, 634, 50, { ...italicRun, fontName: 'claim' }),
      item('If', 128, 634, 8, italicRun),
      item('A', 141, 634, 9, variable),
      item('lies in the domain of', 155, 634, 110, italicRun),
      item('B', 271, 634, 9, variable),
      item('then the conclusion of the rule is', 285, 634, 255, italic),
      item('true.', shape === 'shifted tail' ? 78 : 72, 620, 24, italic),
      item(`Proof of Claim ${shape === 'different claim' ? 5 : 4}:`, 89, 600, 90, italicRun),
      item('We verify the rule directly.', 186, 600, 131, { ...italicRun, fontName: 'body' })
    ])
    const joinsTail = shape === 'continuous'
    const claim = units.find((unit) => unit.items.includes('1:0'))
    const proof = units.find((unit) => unit.items.includes('1:7'))
    assert.equal(claim?.source.endsWith(' is true.'), joinsTail)
    assert.equal(claim?.fragments.length, joinsTail ? 2 : 1)
    assert.equal(claim?.items.includes('1:6'), joinsTail)
    assert.equal(claim?.items.includes('1:7'), false)
    assert.match(proof?.source ?? '', /^Proof of Claim [45]: We verify the rule directly\.$/)
  }
)

it.each([0, 4])(
  'retains a stacked coefficient after a native difference exponent (%s)',
  (shift) => {
    const base = { size: 11, hasEOL: false }
    const script = { ...base, size: 8, fontName: 'script' }
    const math = { ...base, fontName: 'regular-math' }
    const large = { ...base, fontName: 'large-operator' }
    const units = translationUnits([
      item('r', 206.4, 613.3, 5.2, script),
      item('∑', 201, 610, 15.9, large),
      item('j', 201.2, 586.2, 4.4, script),
      item('=0', 205.6, 586.2, 10.9, { ...script, fontName: 'script-number' }),
      item('(', 216.9, 599.5, 4.3, base),
      item('−', 221.2, 599.5, 8.5, math),
      item('1)', 229.7, 599.5, 9.7, base),
      item('r', 239.4, 604.1, 5.2, script),
      item('−', 244.6, 604.1, 6.6, { ...script, fontName: 'script-symbol' }),
      item('j', 251.2, 604.1 - shift, 4.5, script),
      item('(', 256.2, 615.1, 8, large),
      item('r', 264.2, 607, 6.4, { ...math, hasEOL: true }),
      item('j', 264.5, 592.1, 5.8, math),
      item(')', 270.6, 615.1, 8, large)
    ])
    for (const index of [11, 12]) {
      const owner = units.find((unit) => unit.items.includes(`1:${index}`))
      assert.equal(owner?.sourceOnly === true, shift === 0)
      assert.equal(owner?.preserve, shift ? undefined : 'formula')
    }
  }
)

it.each([0, 4])(
  'keeps a wrapped preposition with the prose introducing a native formula (rail shift %s)',
  (shift) => {
    const math = { fontName: 'math', hasEOL: false }
    const subscript = { fontName: 'script', size: 7.3, hasEOL: false }
    const formula = Array.from({ length: 6 }, (_, step) => {
      const x = 244.5 + 22 * step
      return [
        item(step % 2 ? 'v' : 'u', x, 559, 6, math),
        item(String(2 + (step >> 1)), x + 6, 557.5, 4, subscript),
        step === 5 ? item('.', x + 10, 559, 3, math) : item('−', x + 13, 559, 6, math)
      ]
    }).flat()
    const units = translationUnits([
      item(
        'Our main expression represents the difference between successive values.',
        126,
        610,
        359
      ),
      item(
        'Replacing the three entries with their equivalent forms gives a new list.',
        126,
        598,
        359
      ),
      item('The sequence of remaining differences is now determined. Write it', 126, 586, 359),
      item('as', 126 + shift, 574, 9, { hasEOL: false }),
      item('', 244.5, 559, 0, { size: 0 }),
      ...formula,
      item('', 126, 542, 0, { size: 0 }),
      item('The remaining construction follows from the displayed difference.', 126, 542, 348),
      item('This also fixes the sign convention for every subsequent estimate.', 126, 530, 347)
    ])
    const prose = units.find((unit) => unit.items.includes('1:2'))
    assert.equal(prose?.items.includes('1:3'), shift === 0)
    assert.equal(prose?.source.endsWith('Write it as'), shift === 0)
    const display = units.find((unit) => unit.items.includes('1:5'))
    assert.equal(display?.preserve, 'formula')
    assert.equal(display?.sourceOnly, true)
    assert.deepEqual(
      display?.items,
      Array.from({ length: 18 }, (_, index) => '1:' + (index + 5))
    )
  }
)

it.each(['native', 'shifted result'] as const)(
  'joins a word wrapped after a preserved inline result (%s)',
  (shape) => {
    const roman = { hasEOL: false }
    const units = translationUnits([
      item('The measured rate agrees with the predicted ratio.', 54, 680, 235),
      item('The result has a reproducible dependence on time.', 54, 664, 240),
      item('The baseline is shown in the following relation:', 54, 650, 234),
      item('x', 175, 636, 6, { ...roman, fontName: 'math' }),
      item('=', 187, 636, 7, { ...roman, fontName: 'symbol' }),
      item('0.', 202, shape === 'shifted result' ? 641 : 636, 11, roman),
      item('To confirm this we mea-', 218, 636, 81),
      item('sure the reference signal.', 54, 624, 135, roman),
      item('Independent samples measure a second signal.', 64, 607, 221)
    ])
    const owner = units.find((unit) => unit.items.includes('1:6'))
    assert.equal(owner?.items.includes('1:7'), shape === 'native')
    if (shape === 'native') {
      assert.equal(owner?.source, 'To confirm this we measure the reference signal.')
      assert.deepEqual(owner?.items, ['1:6', '1:7'])
      assert.equal(units.find((unit) => unit.items.includes('1:5'))?.preserve, 'formula')
    }
  }
)

it.each([0, 5])('joins the line-end introduction to its named inequality (%s)', (rise) => {
  const rows = [
    ['for a bounded', 150.73, 248.66, 70.43, 10.91, 0, 10.78],
    ['H', 224.78, 248.66, 9.07, 10.91, 1],
    ['-point collection of weight', 234.74, 248.66, 140.38, 10.91, 0, 10.78],
    ['α', 378.73, 248.66, 6.98, 10.91, 1],
    ['. This estimate follows because', 385.75, 248.66, 124.5, 10.91, 0, 10.78],
    ['we have', 299.93, 235.11, 39.07, 10.91, 0, 11.13],
    ['+', 421.16, 240.43, 6.59, 7.97, 2],
    ['I', 427.75, 240.43, 4.67, 7.97, 3],
    ['H', 436.25, 240.43, 6.96, 7.97, 4],
    ['|', 447.11, 240.43, 2.35, 7.97, 3, 7.97, true],
    ['|', 425.25, 231.26, 2.35, 7.97, 3],
    ['≤', 455.03, 235.11, 8.49, 10.91, 5],
    ['1', 469.08, 239.41, 4.23, 7.97, 2],
    ['−', 473.31, 239.41, 6.59, 7.97, 3],
    ['α', 479.9, 239.41, 5.44, 7.97, 4, 7.97, true],
    ['.', 486.54, 235.11, 3.09, 10.91, 0, 11.13],
    [' ', 489.63, 235.11, 7.11, 0, 0, 11.13],
    ['By', 496.88, 235.11, 13.75, 10.91, 0, 11.13, true],
    ['Alder’s inequality,', 85.04, 214.6, 105.88, 10.91, 0, 10.69],
    ['F', 194.24, 214.6, 7.02, 10.91, 1],
    ['−', 467.71, 218.89, 6.59, 7.97, 3],
    ['α', 468.88, 210.84, 5.44, 7.97, 4],
    ['2', 486.88, 223.14 + rise, 4.23, 7.97, 2]
  ] as const
  const items: PdfLayoutTextItem[] = rows.map(([str, x, y, width, size, face, scale, end]) => ({
    ...item(str, x, y, width, { size, fontName: String(face), hasEOL: end ?? false }),
    transform: [scale ?? size, 0, 0, size || 10.91, x, y],
    fontFamily: 'sans-serif',
    fontAscent: [0.689, 0.694, 0.689, 0.75, 0.694, 0.75][face],
    fontDescent: -0.194
  }))
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 595.276, height: 841.89, rotation: 0, items }]
  })
  const clause = units.find((unit) => unit.items.includes('1:18'))
  assert.equal(clause?.source, rise ? 'Alder’s inequality, F' : 'By Alder’s inequality, F')
  assert.equal(clause?.items.includes('1:22'), false)
  assert.deepEqual(
    units.flatMap((unit) => unit.items).sort(),
    items.flatMap((entry, index) => (entry.str.trim() ? [`1:${index}`] : [])).sort()
  )
})

it.each([0, 15])(
  'joins a section outline below the next page figure on the same rail (%s)',
  (shift) => {
    const head = 'The article is organized as follows. In Section 2, we describe the'
    const first = 'updated estimate of the sample. In Section 3, we explain'
    const last = 'the recalibration. In Section 4, we summarize the results.'
    const content = [
      [
        item('This earlier paragraph closes with an independent observation.', 310, 61, 240),
        item(head, 320, 47, 230, { hasEOL: false }),
        item('©', 40, 22, 6, { size: 9, hasEOL: false, fontName: 'mark' }),
        item('2025 The Authors', 48, 22, 80, { size: 9, hasEOL: false })
      ],
      [
        item('2', 40, 740, 6, { size: 12, hasEOL: false }),
        item('A. Writer et al.', 65, 740, 84, { size: 12, hasEOL: false, fontName: 'running' }),
        item('Normalized residuals for the two survey series', 95, 555, 178),
        item('Figure 1.', 40, 510, 38, { size: 9, hasEOL: false, fontName: 'caption' }),
        item('Comparison of the independent survey measurements.', 81, 510, 199, {
          size: 9,
          hasEOL: false
        }),
        item(first, 40 + shift, 470, 240 - shift),
        item(last, 40 + shift, 458, 240 - shift),
        item('2 UPDATED SURVEY ESTIMATE', 40, 390, 150, { fontName: 'heading' }),
        item('We summarize the measurements before describing the experiment.', 40, 369, 240)
      ]
    ]
    const { units } = groupPdfTranslationPages({
      pages: content.map((items, index) => ({
        page: index + 1,
        width: 600,
        height: 780,
        rotation: 0,
        items
      })),
      pageCount: 2
    })
    const outline = units.find((unit) => unit.items.includes('1:1'))
    assert.equal(outline?.source, shift ? head : [head, first, last].join(' '))
    assert.deepEqual(outline?.items, shift ? ['1:1'] : ['1:1', '2:5', '2:6'])
    assert.deepEqual(units.find((unit) => unit.items.includes('2:3'))?.items, ['2:3', '2:4'])
  }
)

it.each([0, 6])('joins a wrapped figure number before inline math (shift=%s)', (shift) => {
  const open = { hasEOL: false }
  const math = { ...open, fontName: 'math' }
  const start = 'The measured profiles at all three stations are shown in Figure'
  const continuation = '6. The preferred setting uses'
  const end = ', which gives the largest response'
  const units = translationUnits([
    item(start, 315, 644, 244),
    item(continuation, 315 + shift, 632, 117 - shift, open),
    item('𝑘', 435, 632, 5, math),
    item('=', 443, 632, 6, math),
    item('3', 452, 632, 5, math),
    item(end, 457, 632, 102),
    item('at the control station during the repeated measurement.', 315, 620, 203)
  ])
  const owner = units.find((unit) => unit.items.includes('1:0'))
  assert.equal(
    owner?.source,
    shift
      ? start
      : `${start} ${continuation} 𝑘 = 3${end} at the control station during the repeated measurement.`
  )
  assert.equal(owner?.items.includes('1:1'), shift === 0)
  assert.equal(owner?.fragments.length, 1)
})

it.each([0, 6])(
  'keeps a short indexed caption ending on its original rail (offset=%s)',
  (offset) => {
    const run = { hasEOL: false }
    const symbol = { ...run, fontName: 'variable' }
    const subscript = { ...run, fontName: 'subscript', size: 7 }
    const units = translationUnits([
      item('Figure 8:', 70, 550, 39, run),
      item('The patterns', 115, 550, 53, run),
      item('R', 172, 550, 7, symbol),
      item('1', 180, 548.5, 4, subscript),
      item('and', 187, 550, 15, run),
      item('R', 206, 550, 7, symbol),
      item('2', 214, 548.5, 4, subscript),
      item('share one more portion of their reflected', 222, 550, 177),
      item('profile.', 70 + offset, 538, 28),
      item('measure the distance at each point along the remaining part of the curve', 70, 508, 329)
    ])
    const owner = units.find((unit) => unit.items.includes('1:0'))
    assert.equal(owner?.source.endsWith('their reflected profile.'), offset === 0)
    assert.equal(owner?.items.includes('1:8'), offset === 0)
    assert.equal(owner?.items.includes('1:9'), false)
  }
)

it.each([0, 2])('keeps the native unit on a caption dimension (%s)', (shift) => {
  const roman = { hasEOL: false }
  const digits = { ...roman, fontName: 'digits' }
  const all = translationUnits([
    item('Figure 2.', 52, 327, 45, { fontName: 'label', hasEOL: false }),
    item('A map displaying the projected outline of the entire controlled region.', 102, 327, 460),
    item('The annotated field shows the full oval and indicates the angular size', 52, 314, 510),
    item('(', 52, 301, 4, roman),
    item('3.2', 56, 301, 13, digits),
    item('×', 71, 301, 8, { ...roman, fontName: 'symbol' }),
    item('8.4', 81, 301, 13, digits),
    item('arcsec).', 96, 301 - shift, 39),
    item('Independent measurements establish a separate result for the region.', 52, 276, 232)
  ])
  const suffix = all.find((unit) => unit.items.includes('1:7'))
  assert.equal(suffix?.source, 'arcsec).')
  assert.equal(suffix?.sourceOnly, shift ? undefined : true)
  assert.equal(suffix?.preserve, shift ? undefined : 'formula')
})

it.each([false, true])(
  'keeps a parenthesized numbered citation with the quotation it closes (%s)',
  (shifted) => {
    const quote = 'and then “report all changes to the original observations”'
    const y = shifted ? 501 : 506
    const units = translationUnits([
      item('The authors compare the full list of observations in both settings.', 90, 539, 392),
      item('The first protocol asks teams to review their chosen summaries', 90, 528, 392),
      item(quote, 90, 517, 392),
      item('(Morgan [', 90, y, 46, { hasEOL: false }),
      item('7', 136, y, 6, { hasEOL: false }),
      item(']). The careful review process records every requested change', 142, y, 340),
      item('and keeps the summary available to the other readers.', 90, y - 11, 310)
    ])
    const owner = units.find((unit) => unit.items.includes('1:3'))
    assert.ok(owner)
    if (shifted) {
      assert.equal(owner.sourceOnly, true)
      assert.deepEqual(owner.items, ['1:3', '1:4'])
    } else {
      assert.ok(owner.source.includes(quote + ' (Morgan [7]). The careful review'))
      assert.deepEqual(
        owner.items,
        Array.from({ length: 7 }, (_, index) => `1:${index}`)
      )
    }
  }
)

it.each([0, 4])('keeps a centered title appositive above the marked byline (%s)', (shift) => {
  const lead = 'Observatory Notes: Measuring Fields with'
  const tail = 'FFT and Calibration Methods'
  const title = { fontName: 'title', hasEOL: false }
  const name = { fontName: 'author', size: 9, hasEOL: false }
  const units = translationUnits([
    item('Draft version April 5, 2025', 51, 733, 134, { size: 8 }),
    item('Typeset using LATEX journal style in ArticleTools', 51, 721.5, 192, { size: 8 }),
    item(lead, 52, 674, 450, title),
    item('TIDE', 506, 674, 42, { ...title, fontName: 'styled acronym' }),
    item(', a', 548, 674, 12, { ...title, hasEOL: true }),
    item(tail, 219.5 + shift, 661.5, 173, title),
    item('', 79, 641.5, 0, { size: 0 }),
    item('Mira Stone', 79, 641.5, 48, name),
    item(',', 127, 641.5, 2.5, name),
    item('1', 129.5, 645.3, 4, { fontName: 'marker', size: 6 })
  ])
  const owner = units.find((unit) => unit.items.includes('1:2'))
  assert.equal(owner?.source, lead + ' TIDE, a' + (shift ? '' : ' ' + tail))
  assert.equal(owner?.items.includes('1:5'), shift === 0)
  assert.equal(units.filter((unit) => unit.items.includes('1:5')).length, 1)
})

it.each([true, false])(
  'joins centered title rows above a byline with raised affiliation markers (%s)',
  (raised) => {
    const lead = 'Calibrating the Distant, Low-Light Signals in the Western Field'
    const tail = 'with the Meridian Observatory Early Data Release 4'
    const title = { fontName: 'title' }
    const author = { fontName: 'author', size: 9, hasEOL: false }
    const mark = { ...author, size: 6 }
    const units = translationUnits([
      item('Draft version April 5, 2025', 60, 734, 120, { size: 8 }),
      item('Typeset using LATEX default style in ArticleTools', 60, 724, 176, { size: 8 }),
      item(lead, 129, 676, 354, title),
      item(tail, 160, 663.5, 296, { ...title, hasEOL: false }),
      item('', 81, 645, 0, { size: 0 }),
      item('Mira Stone,', 81, 645, 65, author),
      item('1', 146, 649, 4, mark),
      item(' ', 150, 649, 4, { ...mark, size: 0 }),
      item('Hale Brooks,', 154, 645, 71, author),
      item('2, 3', 225, raised ? 649 : 645, 15, mark)
    ])
    const owner = units.find((unit) => unit.items.includes('1:2'))
    assert.equal(owner?.source, raised ? lead + ' ' + tail : lead)
    assert.equal(owner?.items.includes('1:3'), raised)
    assert.equal(units.filter((unit) => unit.items.includes('1:3')).length, 1)
  }
)

it.each([true, false])(
  'keeps a short centered title ending with its abstract corroboration (%s)',
  (confirmed) => {
    const title = { size: 11, fontName: 'headline', hasEOL: false }
    const symbol = { ...title, fontName: 'symbol' }
    const items = [
      item('Detecting seasonal shifts with a hybrid', 75, 630, 282, title),
      item('X', 360, 630, 9, symbol),
      item('–', 370, 630, 7, title),
      item('Y', 377, 630, 9, symbol),
      item('regional spatial', 389, 630, 131, { ...title, hasEOL: true }),
      item('comparison', 264, 616.4, 67, title),
      item('', 253, 582.4, 0, { size: 0 }),
      item('Avery Hale', 253, 582.4, 89, { fontName: 'author', hasEOL: false }),
      item('', 200, 570.4, 0, { size: 0 }),
      item('Department of Environmental Measurements', 200, 570.4, 195, {
        fontName: 'affiliation',
        hasEOL: false
      }),
      item(
        'We tested a regional spatial ' + (confirmed ? 'comparison' : 'contrast') + ' (RSC).',
        110,
        440,
        308,
        { size: 9 }
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const titleOwner = units.find((unit) => unit.items.includes('1:0'))
    assert.equal(titleOwner?.items.includes('1:5'), confirmed)
    assert.equal(titleOwner?.source.endsWith('spatial comparison'), confirmed)
    assert.equal(units.filter((unit) => unit.items.includes('1:5')).length, 1)
  }
)

it.each(['2', '3'])('joins a wrapped conjunction after an inverse-square unit (%s)', (power) => {
  const rows: [string, number, number, number, number, string, boolean][] = [
    ['+2', 459, 696.79, 10.09, 6.97, 'script', false],
    ['5', 471.45, 696.79, 3.97, 6.97, 'script', false],
    ['−', 459, 689.88, 6.23, 6.97, 'symbol-script', false],
    ['×', 478.42, 692.53, 7.75, 9.96, 'symbol', false],
    ['10', 488.57, 692.53, 9.96, 9.96, 'body', false],
    ['19', 498.53, 696.15, 7.94, 6.97, 'script', false],
    ['pt', 510.29, 692.53, 12.73, 9.96, 'body', false],
    ['−', 523.02, 696.15, 6.23, 6.97, 'symbol-script', false],
    ['2', 529.25, 696.15, 3.97, 6.97, 'script', false],
    [' ', 533.22, 696.15, 4.09, 0, 'script', false],
    ['and a', 537.31, 692.53, 24.63, 9.96, 'body', true],
    ['time-scale rate-index β =', 50.74, 680.08, 124.42, 9.96, 'body', false],
    ['−', 177.93, 680.08, 7.75, 9.96, 'symbol', false],
    ['.', 190.66, 680.08, 2.77, 9.96, 'math', false],
    ['±', 200.62, 680.08, 7.75, 9.96, 'symbol', false],
    ['0', 210.58, 680.08, 4.98, 9.96, 'body', false],
    ['3, assuming', 218.33, 680.08, 51.03, 9.96, 'body', false],
    ['M', 272.69, 680.08, 8, 9.96, 'math', false],
    ['R', 280.69, 678.59, 5.88, 6.97, 'script', false],
    ['in the range (1', 290.39, 680.08, 64.79, 9.96, 'body', false],
    ['−', 357.39, 680.08, 7.75, 9.96, 'symbol', false],
    ['2', 367.35, 680.08, 4.98, 9.96, 'body', false],
    ['8)', 375.1, 680.08, 8.86, 9.96, 'body', false],
    ['×', 386.17, 680.08, 7.75, 9.96, 'symbol', false]
  ]
  const units = translationUnits(
    rows.map(([text, x, y, width, size, fontName, hasEOL], index) =>
      item(index === 8 ? power : text, x, y, width, { size, fontName, hasEOL })
    )
  )
  const owner = units.find((unit) => unit.items.includes('1:10'))
  assert.ok(owner)
  assert.equal(owner.source.startsWith('and a time-scale rate-index β ='), power === '2')
  assert.equal(owner.items.includes('1:11'), power === '2')
  assert.equal(units.find((unit) => unit.items.includes('1:8'))?.sourceOnly, true)
})

it.each([0, 5])('keeps an aligned integer range in the preceding prose (%s)', (shift) => {
  const body = { size: 12 }
  const roman = { ...body, hasEOL: false }
  const digits = { ...roman, fontName: 'numerals' }
  const blank = { ...roman, size: 0 }
  const units = translationUnits([
    item(
      'The early study reported a set of intervals that were independently verified.',
      98,
      509,
      428,
      body
    ),
    item(
      'The later study measured the same intervals under a consistent set of conditions.',
      86,
      495,
      440,
      body
    ),
    item('Repeated measurements reduced the number from', 86, 481, 423, roman),
    item(' ', 509, 481, 5, blank),
    item('17', 514, 481, 12, digits),
    item('', 86, 467, 0, { size: 0 }),
    item('to', 86 + shift, 467, 10, roman),
    item(' ', 96 + shift, 467, 4, blank),
    item('13', 100 + shift, 467, 12, digits),
    item('.', 112 + shift, 467, 3, roman),
    item('', 86, 447, 0, { size: 0 }),
    item('Theorem 1.', 86, 447, 65, { ...roman, fontName: 'title' }),
    item('Every reported interval admits two independent checks.', 156, 447, 300, body)
  ])
  const paragraph = units.find((unit) => unit.items.includes('1:4'))
  assert.ok(paragraph)
  assert.equal(paragraph.source.endsWith('from 17 to 13.'), shift === 0)
  assert.equal(paragraph.items.includes('1:8'), shift === 0)
  assert.equal(paragraph.items.includes('1:11'), false)
})

it.each([false, true])(
  'joins a dated citation whose year wraps onto the next row (%s)',
  (repeat) => {
    const units = translationUnits([
      item(
        `We follow the published method of Reed et al. (${repeat ? 2021 : 2020}).`,
        50,
        550,
        511
      ),
      item(
        'The last group shows a modest response compared with the previously reported measurements',
        59,
        510,
        502
      ),
      item(
        'and with the detection threshold estimated from the reference observations (Reed et al.',
        50,
        497.5,
        511
      ),
      item('2021).', 50, 485, 28, { hasEOL: false })
    ])
    const lead = units.find((unit) => unit.items.includes('1:2'))
    assert.equal(lead?.source.endsWith('(Reed et al. 2021).'), repeat)
    assert.equal(lead?.items.includes('1:3'), repeat)
    assert.equal(units.flatMap((unit) => unit.items).filter((item) => item === '1:3').length, 1)
  }
)

it.each([0, 5])('keeps a two-author citation with its native software credit (%s)', (offset) => {
  const units = translationUnits([
    item('This section concludes the study before the supplemental credits.', 50, 555, 350),
    item('Software:', 59, 510, 47, { fontName: 'heading', size: 12, hasEOL: false }),
    item('The analysis used the packages', 114, 510, 188, { hasEOL: false }),
    item('GridLens', 306, 510, 45, { fontName: 'package', hasEOL: false }),
    item('(Dale 2020),', 355, 510, 70, { hasEOL: false }),
    item('ArcView', 429, 510, 64, { fontName: 'package', hasEOL: false }),
    item('(Reed', 498, 510, 63),
    item('& Blake 2021),', 50, 497.5 - offset, 77, { hasEOL: false }),
    item('FlowGraph (Rowe 2022), and WaveMap (Hill 2023).', 131, 497.5 - offset, 271, {
      hasEOL: false
    })
  ])
  const lead = units.find((unit) => unit.items.includes('1:6'))
  assert.equal(lead?.source.includes('(Reed & Blake 2021)'), offset === 0)
  assert.equal(lead?.items.includes('1:7'), offset === 0)
  assert.equal(lead?.fragments.length, 1)
  assert.equal(units.flatMap((unit) => unit.items).filter((item) => item === '1:7').length, 1)
})

it.each([0, 5])('keeps a centered title with its wrapped quotation and citation (%s)', (shift) => {
  const lead =
    'A comment on the stability of the regional measurement: a response to “A comparison of the'
  const tail = 'Coastal observation methods”, arXiv:0000.00000'
  const units = translationUnits([
    item('Draft version May 2, 2022', 54, 710, 132, { size: 8 }),
    item('Typeset using a journal template', 54, 700, 145, { size: 8, hasEOL: false }),
    item(lead, 51, 650, 510, { fontName: 'title' }),
    item(tail, 144 + shift, 637.5, 324, { fontName: 'title', hasEOL: false }),
    item('', 172, 619, 0, { size: 9, fontName: 'author' }),
    item('Avery Reader,', 172, 619, 58, { size: 9, fontName: 'author', hasEOL: false }),
    item('1', 230, 622.6, 4, { size: 6, fontName: 'author', hasEOL: false }),
    item('and Riley Writer', 237, 619, 199, { size: 9, fontName: 'author', hasEOL: false }),
    item('2', 436, 622.6, 4, { size: 6, fontName: 'author', hasEOL: false }),
    item('', 170, 599, 0, { size: 8 }),
    item('Field Research Institute', 210, 596, 180, { size: 8 }),
    item('ABSTRACT', 279, 553, 54, { fontName: 'heading' }),
    item('We describe several measurements and summarize the models used.', 100, 538, 400)
  ])
  const title = units.find((unit) => unit.items.includes('1:2'))
  assert.equal(title?.source, shift ? lead : lead + ' ' + tail)
  assert.equal(title?.items.includes('1:3'), shift === 0)
  assert.equal(title?.items.includes('1:5'), false)
})

it.each([true, false])(
  'joins a wrapped caption citation with a matching body citation (%s)',
  (repeat) => {
    const units = translationUnits([
      item('Figure 3.', 50, 431, 41, { fontName: 'caption-label', size: 9, hasEOL: false }),
      item(
        'The calibrated observations for the field sites. Updated from Fig. 2 in Reed',
        96,
        431,
        464,
        { size: 9 }
      ),
      item('et al. (2021).', 50, 420, 52, { size: 9, hasEOL: false }),
      item(
        `We also compare the published calibration from Reed et al. (${repeat ? 2021 : 2020}).`,
        50,
        391,
        511
      )
    ])
    const caption = units.find((unit) => unit.items.includes('1:0'))
    assert.equal(caption?.source.endsWith('Reed et al. (2021).'), repeat)
    assert.equal(caption?.items.includes('1:2'), repeat)
    assert.equal(units.flatMap((unit) => unit.items).filter((id) => id === '1:2').length, 1)
  }
)

it.each([true, false])(
  'joins a software title with its final noun when the package is corroborated (%s)',
  (matching) => {
    const wrap = ': scientific data exploration with compass-like'
    const units = translationUnits([
      item('Journal manuscript', 50, 790, 112),
      item('orbitmap', 60, 716, 84, { size: 17.2, fontName: 'title-package', hasEOL: false }),
      item(wrap, 144, 716, 408, { size: 16.35, fontName: 'title' }),
      item('symbols', 271, 696.1, 70, { size: 16.35, fontName: 'title', hasEOL: false }),
      item('', 84, 673, 0, { size: 11, hasEOL: true }),
      item('MAP Collaboration, R. Writer', 84, 673, 221, { size: 11, hasEOL: false }),
      item('1', 305, 677, 4, { size: 8 }),
      item('ABSTRACT', 278, 590, 56, { size: 9 }),
      item('We present', 60, 552, 51, { size: 9, hasEOL: false }),
      item(matching ? 'orbitmap' : 'othermap', 115, 552, 50, {
        size: 9,
        fontName: 'package',
        hasEOL: false
      }),
      item(', a flexible', 165, 552, 46, { size: 9, hasEOL: false }),
      item('Python', 215, 552, 31, { size: 9, fontName: 'package', hasEOL: false }),
      item('package for visualizing the archived observations.', 249, 552, 211, { size: 9 })
    ])
    const title = units.find((unit) => unit.items.includes('1:1'))
    assert.equal(title?.items.includes('1:3'), matching)
    assert.equal(title?.items.includes('1:5'), false)
  }
)

it.each([true, false])(
  'preserves a letter-spaced import confirmed by its native call (%s)',
  (matches) => {
    const units = translationUnits([
      item('Add the local folder to the lookup path as follows:', 52, 417, 234),
      item('import', 76, 400, 34, { fontName: 'keyword', hasEOL: false }),
      item('m o d', 118, 400, 17),
      item(`${matches ? 'm o d' : 'a u x'} . p a t h . append ( local_root )`, 76.4, 389, 215, {
        hasEOL: false
      }),
      item('A separate instruction follows the code.', 52, 371, 205)
    ])
    const entry = units.find((unit) => unit.items.includes('1:1'))
    assert.equal(entry?.preserve, matches ? 'code' : undefined)
    assert.equal(entry?.items.includes('1:2'), true)
    assert.equal(entry?.items.includes('1:4'), false)
  }
)

it.each([true, false])(
  'joins a cross-column plotted band list only with all legend labels (%s)',
  (matches) => {
    const units = translationUnits([
      item('Figure 4 is adapted from an earlier survey.', 42, 100, 245),
      item('The markers show data measured in IR- (green', 42, 89, 245, { hasEOL: false }),
      item('IR-band', 502, 378, 37, { fontName: 'plot', size: 8 }),
      item('B-band', 502, 355, 33, { fontName: 'plot', size: 8 }),
      item(matches ? 'UV-band' : 'X-band', 502, 332, 39, { fontName: 'plot', size: 8 }),
      item('Fig. 4. Comparison of the IR, B, and UV channels.', 319, 270, 214, {
        fontName: 'caption',
        size: 9,
        hasEOL: false
      }),
      item('circle), B- (red square) and UV- (blue star) restframe', 319, 239, 245),
      item('bands.', 319, 228, 28, { hasEOL: false }),
      item('5. Summary', 319, 197, 72, { fontName: 'heading' }),
      item('The main observations agree with the earlier analysis.', 319, 179, 245)
    ])
    const paragraph = units.find((unit) => unit.items.includes('1:1'))
    assert.equal(paragraph?.items.includes('1:6'), matches)
    assert.equal(paragraph?.fragments.length, matches ? 2 : 1)
    assert.equal(paragraph?.items.includes('1:5'), false)
  }
)

it.each([true, false])('joins a page-turn word with a matching figure caption (%s)', (matches) => {
  const pages: PdfLayoutPage[] = [
    {
      page: 1,
      width: 612,
      height: 792,
      rotation: 0,
      items: [
        item('The stable run ended with the final reading.', 317, 84, 130),
        item('For steady operation, the rate of back-', 327, 72, 235, { hasEOL: false })
      ]
    },
    {
      page: 2,
      width: 612,
      height: 792,
      rotation: 0,
      items: [
        item(
          `FIG. 4: Results for the rate of the ${matches ? 'background' : 'residual'} readings.`,
          54,
          580,
          245,
          { size: 9, hasEOL: false }
        ),
        item('', 54, 539, 0, { size: 0 }),
        item('ground readings must be stable throughout an entire session.', 54, 539, 245),
        item('The background readings confirmed these settings.', 54, 527, 245)
      ]
    }
  ]
  const units = groupPdfTranslationPages({ pages }).units
  const continued = units.find(({ items }) => items.includes('1:1'))
  assert.ok(continued)
  assert.equal(continued.source.includes('the rate of background readings must be stable'), matches)
  assert.deepEqual(
    continued.fragments.map(({ page }) => page),
    matches ? [1, 2] : [1]
  )
  assert.equal(continued.items.includes('2:2'), matches)
  assert.equal(continued.items.includes('2:0'), false)
})

it.each([true, false])('joins a broken word below an opening column caption (%s)', (matches) => {
  const stamp = item('arXiv:TEST-PREPRINT [sample] 1 Jan 2025', 38, 178, 440, {
    size: 20,
    fontName: 'stamp',
    hasEOL: false
  })
  const caption = { size: 9, fontName: 'caption' }
  const pages: PdfLayoutPage[] = [
    {
      page: 1,
      width: 612,
      height: 792,
      rotation: 0,
      items: [
        item('The upstream channel was installed using a wider guide', 54, 704, 245),
        item('to distribute flow over the container walls evenly.', 54, 692, 211),
        item('The team independently measured the cold-water output', 317, 96, 245),
        item('before fitting new baffles to the exhaust.', 317, 84, 223),
        item('The next experiment was designed with four rectangu-', 327, 70.5, 235, {
          hasEOL: false
        }),
        { ...stamp, transform: [0, 20, -20, 0, 38, 178] }
      ]
    },
    {
      page: 2,
      width: 612,
      height: 792,
      rotation: 0,
      items: [
        item('2', 557, 756, 5, { hasEOL: false }),
        item('Figure 1. A frame positioned under the central guide,', 54, 348, 245, caption),
        item(
          `showing ${matches ? 'rectangular' : 'triangular'} plates fixed in place.`,
          54,
          337,
          185,
          {
            ...caption,
            hasEOL: false
          }
        ),
        item('', 54, 303, 0, { size: 0 }),
        item('lar plates, each aligned to the center of the guide to', 54, 303, 245),
        item('maintain a uniform flow through the central channel.', 54, 291, 245),
        item('The image illustrates the surrounding support.', 54, 279, 210),
        item('The last calculation verified rectangular plate measurements.', 64, 267, 221),
        item('A short description closes the experiment.', 317, 702, 245)
      ]
    }
  ]
  const { units } = groupPdfTranslationPages({ pages })
  const owner = units.find(({ items }) => items.includes('1:4'))
  assert.ok(owner)
  assert.equal(owner.source.includes('four rectangular plates'), matches)
  assert.deepEqual(owner.items, matches ? ['1:4', '2:4', '2:5', '2:6'] : ['1:4'])
  assert.deepEqual(
    owner.fragments.map(({ page }) => page),
    matches ? [1, 2] : [1]
  )
  assert.deepEqual(units.find(({ source }) => source.startsWith('Figure 1.'))?.items, [
    '2:1',
    '2:2'
  ])
  assert.deepEqual(units.find(({ source }) => source.startsWith('arXiv:'))?.items, ['1:5'])
  assert.equal(units.find(({ source }) => source === '2')?.sourceOnly, true)
})

it.each([true, false])(
  'rejoins an author citation across a first-page keyword footer (%s)',
  (matches) => {
    const row = (text: string, y: number, x = 70, width = 460, hasEOL = true): PdfLayoutTextItem =>
      item(text, x, y, width, { size: 12, hasEOL })
    const number = (page: number): PdfLayoutTextItem[] => [
      item('', 297, 72, 0, { size: 0 }),
      item(String(page), 297, 72, 6, { size: 9, fontName: 'folio', hasEOL: false })
    ]
    const surname = matches ? 'Cohen' : 'These results'
    const rows = [
      [
        row('The preceding result applies to finite sets.', 173, 70, 258),
        item('', 82, 136, 0, { size: 0 }),
        row(
          'The distinction between the two constructions was established in the prior discussion',
          136,
          82,
          448
        ),
        row('under these conditions, and the implication also follows from a direct counting', 122),
        row('argument; see the discussion by Rivera, Wu, and', 108, 70, 460, false),
        item('', 82, 84, 0, { size: 0 }),
        item('Key words and phrases.', 82, 84, 100, {
          size: 10,
          fontName: 'keyword',
          hasEOL: false
        }),
        item(' ', 182, 84, 5, { size: 0, hasEOL: false }),
        item('Finite sets, geometric constructions, simple proofs.', 187, 84, 260, {
          size: 10,
          fontName: 'note',
          hasEOL: false
        }),
        ...number(1)
      ],
      [
        row(
          surname + ' [RWC24, Lemma 3.1 and Section 2]. Another part of the argument uses an',
          758
        ),
        row(
          'independent estimate. That proof relies on a construction with an extra assumption',
          744
        ),
        row('while our proof relies only on the previous conditions.', 730, 70, 285),
        row(
          'The following section gives an independent estimate for each construction.',
          716,
          82,
          425
        ),
        ...number(2)
      ]
    ]
    const pages = rows.map((items, i) => ({
      page: i + 1,
      width: 600,
      height: 840,
      rotation: 0,
      items
    }))
    const { units } = groupPdfTranslationPages({ pages })
    const head = units.find((unit) => unit.items.includes('1:2'))
    assert.ok(head)
    assert.equal(head.source.includes('and Cohen [RWC24'), matches)
    assert.deepEqual(
      head.fragments.map(({ page }) => page),
      matches ? [1, 2] : [1]
    )
    assert.equal(
      units.find((unit) => unit.items.includes('1:6'))?.source.startsWith('Key words'),
      true
    )
  }
)

it.each([true, false])(
  'reconnects a cited contrast after an opposite-column caption (%s)',
  (continuous) => {
    const right = 320.944
    const left = 47.821
    const seam = continuous ? 345.414 : 331.414
    const run = (
      str: string,
      x: number,
      y: number,
      width: number,
      size: number,
      horizontal: number,
      fontName: string,
      hasEOL: boolean
    ): PdfLayoutTextItem => {
      const text = item(str, x, y, width, { size, fontName, hasEOL })
      text.transform[0] = horizontal
      return text
    }
    const body = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL = true,
      horizontal = 9.146
    ): PdfLayoutTextItem => run(str, x, y, width, 8.966, horizontal, 'body', hasEOL)
    const caption = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL = false,
      horizontal = 8.13
    ): PdfLayoutTextItem => run(str, x, y, width, 7.97, horizontal, 'body', hasEOL)
    const items = [
      body('The result remains stable. Unlike control', left, 81.594, 250.703),
      body('setups, where peak feedback is typically', left, 70.685, 250.703),
      body('associated with rapid thermal changes', left, 59.776, 249.217, false, 9.038),
      run('Fig. 3.', right, 418.028, 24.707, 8.518, 8.552, 'label', false),
      caption(
        'Comparison of the response to the test pulse',
        348.58,
        418.028,
        189.015,
        false,
        8.002
      ),
      caption('sampling steps', 320.705, 409.062, 64.426),
      run('m', 387.226, 409.062, 6.201, 7.97, 7.97, 'italic', false),
      caption('(solid lines) in the calibrated setting for', 395.519, 409.062, 170.963),
      run('p', 516.321, 400.096, 3.985, 7.97, 7.97, 'italic', false),
      run('=', 523.753, 400.096, 6.46, 8.305, 8.305, 'relation', false),
      caption('0.3. The', 533.547, 400.096, 28.274, true),
      caption('curves are averaged over independent runs.', right, 391.129, 241.032, true),
      caption('The dashed line shows the response', 320.697, 382.163, 241.162, true),
      caption('with', 320.609, 373.197, 16.203, false, 7.97),
      run('p = 1', 370.016, 373.197, 3.23, 8.305, 8.305, 'relation', false),
      caption('.', 391.983, 373.197, 1.993, false, 7.97),
      run('', right, seam, 0, 0, 9.146, 'body', true),
      body('and mechanical effects [', right, seam, 112.931, false),
      body('12', 433.879, seam, 8.966, false, 8.966),
      body('–', 442.846, seam, 4.573, false),
      body('15', 447.419, seam, 8.966, false, 8.966),
      body('], the response arises in a controlled environment where', 456.385, seam, 113.773),
      body('no independent vibration is expected. In repeated', right, seam - 10.909, 249.395),
      body('trials the sensors are stable.', right, seam - 21.818, 249.212),
      body('Temperature changes affect only certain positions.', right, seam - 32.727, 249.212),
      body(
        'The data are therefore consistent with a stable',
        right,
        seam - 43.636,
        250.335,
        true,
        8.787
      ),
      body('signal under these conditions.', 320.693, seam - 54.545, 249.462, true, 8.904)
    ]
    const units = translationUnits(items)
    const contrast = units.find((unit) => unit.items.includes('1:2'))
    assert.ok(contrast)
    assert.equal(
      contrast.source.includes('rapid thermal changes and mechanical effects [12–15]'),
      continuous
    )
    assert.equal(contrast.items.includes('1:17'), continuous)
    assert.equal(contrast.items.includes('1:3'), false)
    assert.equal(units.find((unit) => unit.items.includes('1:8'))?.preserve, 'formula')
  }
)

it.each([true, false])('joins a split word past an independent contact note (%s)', (matching) => {
  const items = [
    item('Other measurements establish a stable response in this system.', 52, 204.5, 246),
    item('Repeated observations reveal a similar result in the control run.', 52, 193, 246),
    item('The independent recordings agree with the expected profile.', 52, 181.5, 246),
    item('These findings apply across the interval tested.', 52, 170, 161),
    item('In this paper, we present a renewed measurement sys-', 62, 158.5, 236, {
      hasEOL: false
    }),
    item('', 53, 120, 0, { size: 0 }),
    item('∗', 53, 120, 4, { size: 6, fontName: 'mark', hasEOL: false }),
    item('reader@example.test', 60, 117, 77, {
      size: 8,
      fontName: 'address',
      hasEOL: false
    }),
    item('', 316, 584, 0, { size: 0 }),
    item('tem based on independent readings of fixed conditions.', matching ? 316 : 321, 584, 246),
    item('We record its output at every point and compare these values.', 316, 572.5, 246),
    item('Several outcomes are stable during the experiment.', 316, 561, 246),
    item('The final reading confirms this result.', 316, 549.5, 167, { hasEOL: false }),
    item('', 316, 244, 0, { size: 0 }),
    item('Figure 1. Overview of the independent calibration stages.', 316, 244, 246, {
      size: 9,
      fontName: 'caption'
    })
  ]
  const units = translationUnits(items)
  const head = units.find((unit) => unit.items.includes('1:4'))
  assert.equal(head?.source.includes('measurement system based on'), matching)
  assert.equal(head?.items.includes('1:9'), matching)
  assert.equal(units.find((unit) => unit.items.includes('1:6'))?.source, '∗ reader@example.test')
  assert.equal(units.find((unit) => unit.items.includes('1:14'))?.source, items[14].str)
})

it.each([true, false])(
  'preserves an unheaded bibliography after a run-in availability statement (%s)',
  (matching) => {
    const lead = [
      item('Earlier findings confirm the response across the range tested.', 320, 667, 246),
      item('A separate control reproduces this response after adjustment.', 320, 655.5, 246),
      item('The final measurements confirm the same result.', 320, 644, 189),
      item('Disclosures - The authors declare no conflicts of interest.', 334, 617, 224),
      item('Data Availability Statement - Observations supporting these findings', 334, 587, 236),
      item('may be obtained from the authors on reasonable request.', 320, 575.5, 225)
    ]
    const items = [
      ...lead,
      ...Array.from({ length: 8 }, (_, i) => {
        const x = i < 4 ? 56 : 320
        const y = 521.5 - (i % 4) * 21
        const number = !matching && i === 7 ? 9 : i + 1
        const body = { size: 9, fontName: 'reference' }
        return [
          item(`[${number}] A. Reader, An independent result`, x, y, 223, body),
          item('Journal of Observations', x + 14, y - 10.5, 99, { ...body, hasEOL: false }),
          item(String(20 + i), x + 117, y - 10.5, 13, {
            size: 9,
            fontName: 'volume',
            hasEOL: false
          }),
          item(', 201 (2024).', x + 131, y - 10.5, 49, body)
        ]
      }).flat()
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }],
      pageCount: 1
    })
    const statement = units.find((unit) => unit.items.includes('1:4'))
    const citations = units.filter((unit) =>
      unit.items.some((key) => Number(key.split(':')[1]) >= lead.length)
    )
    assert.ok(statement?.source.startsWith('Data Availability Statement - '))
    assert.equal(Boolean(statement.sourceOnly), false)
    assert.ok(citations.length)
    assert.equal(
      citations.every((unit) => unit.sourceOnly && unit.preserve === 'reference'),
      matching
    )
  }
)

it.each([2021, 2020])('keeps a dated citation-key wrap within the bibliography (%s)', (date) => {
  const body = { size: 8, fontName: 'reference' }
  const italic = { ...body, fontName: 'reference-italic', hasEOL: false }
  const items = [
    item('We report the new procedure and the results from both trials.', 72, 410, 253),
    item('References', 277, 390, 58, { fontName: 'heading' }),
    item('[Ab19] A. Reader. A prior calibration.', 72, 374, 468, body),
    item('Journal of Calibration, 2019.', 105, 364, 118, body),
    item('[Cd20] B. Reader. A timing method. Journal of Timing, 2020.', 72, 354, 205, body),
    item('[Ef21] C. Reader. Working methods for the calibration protocol', 72, 344, 324, {
      ...body,
      hasEOL: false
    }),
    item('. Report, Northern', 397, 344, 143, body),
    item(`Institute of Measurement, ${date}.`, 105, 334, 112, body),
    item('[Gh22] D. Reader. A comparison of two calibration instruments.', 72, 324, 425, {
      ...body,
      hasEOL: false
    }),
    item('Online preprint', 500, 324, 40, { ...italic, hasEOL: true }),
    item('Electronic proceedings, release 2', 105, 314, 72, italic),
    item(', 2022.', 177, 314, 26, { ...body, hasEOL: false }),
    item('Western Laboratory for Measurement', 84, 296, 144, { ...body, fontName: 'address' }),
    item('Email address:', 84, 286, 50, { ...body, hasEOL: false }),
    item('reader@example.test', 137, 286, 71, body)
  ]
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }],
    pageCount: 1
  })
  const wrap = units.find((unit) => unit.items.includes('1:7'))
  const contact = units.find((unit) => unit.items.includes('1:12'))
  assert.equal(wrap?.source, `Institute of Measurement, ${date}.`)
  assert.equal(wrap?.preserve === 'reference' && Boolean(wrap.sourceOnly), date === 2021)
  assert.notEqual(contact?.preserve, 'reference')
})

it.each([true, false])(
  'joins a repeated compound noun split over a justified body line (%s)',
  (witnessed) => {
    const items = [
      item(
        'The measured sequence illustrates the output of the signal processing method.',
        84,
        483,
        456
      ),
      item(
        'At each step we update the independent value on the left using the same method.',
        72,
        471,
        468
      ),
      item(
        `Our earlier description defines the ${witnessed ? 'phase-tracking map' : 'timing map'} for these readings.`,
        72,
        459,
        468
      ),
      item('Other examples use the same procedure.', 72, 447, 212),
      item('The resulting path describes the image', 84, 435, 306, { hasEOL: false }),
      item('s', 394, 435, 5, { fontName: 'symbol', hasEOL: false }),
      item('(', 399, 435, 4, { hasEOL: false }),
      item('t', 403, 435, 5, { fontName: 'symbol', hasEOL: false }),
      item(') under the phase-tracking', 408, 435, 132),
      item('map.', 72, 423, 22),
      item('Another example appears below.', 84, 411, 182)
    ]
    const units = translationUnits(items)
    const head = units.find((unit) => unit.items.includes('1:4'))
    assert.equal(head?.source.endsWith('phase-tracking map.'), witnessed)
    assert.equal(head?.items.includes('1:9'), witnessed)
    assert.equal(head?.items.includes('1:10'), false)
  }
)

it.each([0, 5])('joins the citation-bearing last row of a native figure caption (%s)', (shift) => {
  const caption = { fontName: 'caption', size: 9 }
  const label = { fontName: 'caption-label', size: 9, hasEOL: false }
  const ending = 'Morgan’s H-index from (Parker 2019).'
  const body = 'The reference samples are recorded on a separate scale.'
  const units = translationUnits([
    item('Figure 2.', 50, 287, 41, label),
    item(' ', 91, 287, 4, { ...label, size: 0 }),
    item('Range of measurements from the calibration trial.', 95, 287, 196, caption),
    ...[
      'Each trial starts at a separate point on the printed scale.',
      'The smallest readings are on the left side of the plot.',
      'The largest readings are marked with an outlined circle.',
      'The panel uses the same scale across both groups.',
      'Each diagram also reports the wind speed at its sensor.',
      'The value changes with the distance to the reference target.',
      'The colors represent the four bands in the displayed scale.',
      'For reference, we use a range of 12 as the control',
      'and report values for the inactive samples separately, indicated',
      'by the marked symbols in parentheses, and we measure the'
    ].map((line, index) => item(line, 50, 276 - 11 * index, 241, caption)),
    item(ending, 50 + shift, 166, 164, { ...caption, hasEOL: false }),
    item('', 59, 139, 0, { size: 0 }),
    item('The reference samples use the same display scale.', 59, 139, 233),
    ...[126, 114, 101, 89].map((y) => item(body, 50, y, 241)),
    item(body, 167, 76, 125),
    item(body, 320, 717, 150, { hasEOL: false }),
    ...[705, 692, 680, 668].map((y) => item(body, 320, y, 241)),
    item(body, 320, 655, 97, { hasEOL: false })
  ])
  const head = units.find((unit) => unit.items.includes('1:0'))
  assert.ok(head)
  assert.equal(head.source.endsWith(ending), shift === 0)
  assert.equal(head.items.includes('1:13'), shift === 0)
  assert.equal(head.items.includes('1:15'), false)
  assert.equal(
    units.some((unit) => unit.source === ending),
    shift !== 0
  )
})

it.each([true, false])('joins the centered continuation on a dated cover (%s)', (centered) => {
  const lead = 'A new method for thermal response'
  const tail = 'measurements'
  const title = { size: 20, fontName: 'title' }
  const byline = { size: 14, fontName: 'byline', hasEOL: false }
  const body = { size: 12, fontName: 'body' }
  const line = { size: 0 }
  const units = translationUnits([
    item(lead, 169, 606, 274, title),
    item(tail, centered ? 246 : 229, 582, 120, { ...title, hasEOL: false }),
    item('', 231, 548, 0, line),
    item('Mira Stone', 246, 548, 120, byline),
    item('', 246, 521, 0, line),
    item('April 12, 2024', 248, 521, 116, { ...byline, fontName: 'body' }),
    item('', 243, 438, 0, line),
    item('Laboratory for Applied Methods,', 243, 438, 147, body),
    item('Example City, Example Region.', 243, 424, 143, body),
    item('email: contact@example.org', 243, 410, 142, { ...body, hasEOL: false }),
    item('', 268, 340, 0, line),
    item('Abstract', 268, 340, 76, { size: 17, fontName: 'byline', hasEOL: false }),
    item('', 110, 312, 0, line),
    item('We compare several probes under controlled laboratory conditions.', 110, 312, 392, body),
    item('Each measurement is repeated at several selected intervals.', 110, 298, 392, body)
  ])
  const owner = units.find((unit) => unit.items.includes('1:0'))
  assert.equal(owner?.source, centered ? lead + ' ' + tail : lead)
  assert.equal(owner?.items.includes('1:1'), centered)
  assert.equal(units.filter((unit) => unit.items.includes('1:1')).length, 1)
  assert.equal(units.find((unit) => unit.items.includes('1:3'))?.source, 'Mira Stone')
})

it.each([0, 8])('joins a centered title before a marked byline (%d)', (offset) => {
  const title = { fontName: 'title' }
  const author = { fontName: 'author', size: 9, hasEOL: false }
  const mark = { ...author, size: 6 }
  const items = [
    item('Draft version March 8, 2025', 60, 733, 125, { size: 8, hasEOL: false }),
    item('', 60, 724, 0, { size: 0 }),
    item('Typeset using LATEX default style in Example', 60, 724, 183, { size: 8, hasEOL: false }),
    item('', 54, 676, 0, { size: 0 }),
    item(
      'An Optical Detector for Active Observations: Calibration Response to Faint',
      54,
      676,
      504,
      title
    ),
    item('Targets during Extended Calibration', 203 + offset, 663.5, 206, {
      ...title,
      hasEOL: false
    }),
    item('', 68, 643.6, 0, { size: 0 }),
    item('Mira Lake', 68, 643.6, 62, author),
    item(' ', 130, 643.6, 11, { ...author, size: 0 }),
    item(',', 141, 643.6, 3, author),
    item('1', 144, 647.4, 4, mark),
    item(' ', 148, 647.4, 4, { ...mark, size: 0 }),
    item('Jon Gray', 152, 643.6, 60, author),
    item(' ', 212, 643.6, 11, { ...author, size: 0 }),
    item(',', 223, 643.6, 3, author),
    item('2, 3', 226, 647.4, 12, mark),
    item('', 230, 632.4, 0, { size: 0 }),
    item('Department of Instrumentation', 230, 632.4, 152, { size: 8 })
  ]
  const units = translationUnits(items)
  const head = units.find((unit) => unit.items.includes('1:4'))
  const tail = units.find((unit) => unit.items.includes('1:5'))
  assert.ok(head && tail)
  assert.equal(head === tail, offset === 0)
  assert.equal(head.items.includes('1:7'), false)
  if (offset === 0) assert.match(head.source, /Faint Targets during Extended Calibration$/u)
})

it.each([0, 6])('joins a compact formula ending in a numbered statement (%d)', (shift) => {
  const body = { size: 11, fontName: 'body' }
  const label = { ...body, fontName: 'label', hasEOL: false }
  const italic = { ...body, fontName: 'italic', hasEOL: false }
  const formula = { ...body, fontName: 'formula', hasEOL: false }
  const items = [
    item('The earlier section establishes the main bound.', 72, 279, 405, body),
    item('Theorem 2.1:', 72, 255, 67, label),
    item('The sum of the two independent measures in this procedure is', 144, 255, 317, italic),
    item('RM', 466, 255, 21, formula),
    item('(', 487, 255, 4, { ...body, hasEOL: false }),
    item('x', 491, 255, 5, formula),
    item('+', 499, 255, 8, { ...body, hasEOL: false }),
    item('', 72 + shift, 241.5, 0, { size: 0 }),
    item('y', 72 + shift, 241.5, 5, formula),
    item(')', 77 + shift, 241.5, 4, { ...body, hasEOL: false }),
    item('.', 81 + shift, 241.5, 3, italic),
    item('', 72, 218, 0, { size: 0 }),
    item('Remark 2.2:', 72, 218, 64, label),
    item('The same estimate also follows from a direct argument.', 141, 218, 320, body)
  ]
  const units = translationUnits(items)
  const head = units.find((unit) => unit.items.includes('1:1'))
  const tail = units.find((unit) => unit.items.includes('1:8'))
  assert.ok(head && tail)
  assert.equal(head === tail, shift === 0)
  assert.equal(head.items.includes('1:12'), false)
  if (shift === 0) assert.match(head.source, /RM\(x \+ y\)\.$/u)
})

it.each(['ASPRV', 'ASPRX'])(
  'keeps the wrapped definition of a styled initialism (%s)',
  (repeat) => {
    const row = { hasEOL: false }
    const styled = (text: string, x: number): PdfLayoutTextItem => ({
      ...item(text, x, 148.6, 26, { ...row, fontName: 'identifier' }),
      fontFamily: 'monospace'
    })
    const units = translationUnits([
      item('The standard tool retrieves a full report for each test.', 61, 194, 460),
      item(
        'We developed another system for this test, the Adaptive Signal Processing Routine',
        61,
        162.3,
        500
      ),
      item('for Verification (', 51, 148.6, 56, row),
      styled('ASPRV', 107),
      item(') system.', 133, 148.6, 28, row),
      styled(repeat, 169.2),
      item(
        'is a new process that uses the entire report to verify each signal',
        199.8,
        148.6,
        361.2
      ),
      item('against the recorded measurements available in each test.', 51, 134.9, 410)
    ])
    const owner = units.find((unit) => unit.items.includes('1:1'))
    const matched = repeat === 'ASPRV'
    assert.ok(owner)
    assert.equal(
      owner.source.includes('Routine for Verification (ASPRV) system. ASPRV is a new process'),
      matched
    )
    assert.equal(owner.items.includes('1:3'), matched)
    assert.equal(new Set(units.flatMap((unit) => unit.items)).size, 8)
  }
)

it.each([0, 18])(
  'joins a wrapped proof after a native formula only on its text rail (%s)',
  (offset) => {
    const rows = [
      ['deduced', 58.7, 147.63, 32.49, 10.91, 'body', false],
      ['Q', 95.09, 147.63, 6.38, 10.91, 'math', false],
      ['(', 102.98, 147.63, 4.33, 10.91, 'delimiter', false],
      ['x', 107.31, 147.63, 4.92, 10.91, 'math', false],
      [')', 112.54, 147.63, 4.33, 10.91, 'delimiter', false],
      ['≥', 120.33, 147.63, 8.49, 10.91, 'operator', false],
      ['12+', 133.47, 151.95, 15.06, 7.97, 'script', false],
      ['√', 148.52, 158.57, 7.06, 7.97, 'radical', false],
      ['19', 155.58, 151.95, 8.47, 7.97, 'script', true],
      ['27', 144.52, 143.87, 8.47, 7.97, 'script', false],
      ['x', 165.24, 147.63, 4.92, 10.91, 'math', false],
      ['2', 170.47, 151.59, 4.23, 7.97, 'script', false],
      [
        'by comparing the totals across the subsets and applying a',
        179.1,
        147.63,
        327.49,
        10.91,
        'body',
        true
      ],
      ['standard lemma to the remaining sets.', 58.7, 134.09, 199.25, 10.91, 'body', false]
    ] as const
    const units = translationUnits(
      rows.map(([text, x, y, width, size, fontName, hasEOL], index) =>
        item(text, x + (index === rows.length - 1 ? offset : 0), y, width, {
          size,
          fontName,
          hasEOL
        })
      )
    )
    const proof = units.find((unit) => unit.items.includes('1:12'))
    assert.equal(proof?.items.includes('1:13'), offset === 0)
    const formula = units.find((unit) => unit.items.includes('1:1'))
    assert.equal(formula?.sourceOnly, true)
    assert.equal(formula?.preserve, 'formula')
    assert.equal(units.flatMap((unit) => unit.items).length, rows.length)
  }
)

it.each([0, 4])('joins a hyphenated measurement across a native line wrap (gap=%d)', (gap) => {
  const body = { hasEOL: false }
  const math = { hasEOL: false, fontName: 'symbol' }
  const power = { ...math, size: 7 }
  const units = translationUnits([
    item('The measurements are averaged during the quiet interval.', 54, 320, 245),
    item('The settings were selected to minimize drift. We set', 54, 308, 189, body),
    item('β', 248, 308, 5, math),
    item('= 2.5', 259, 308, 40),
    item('and', 54, 296, 16, body),
    item('η', 74, 296, 5, math),
    item('= 10', 85, 296, 22, body),
    item('−', 107, 300, 6, power),
    item('4', 113, 300, 4, power),
    item(', corresponding to a narrow 40-', 118, 296, 181, body),
    item('', 299, 296, 0, { size: 0 }),
    item('μ', 54, 284, 6, math),
    item('m aperture opening used for the calibration run.', 60 + gap, 284, 239 - gap),
    item('The reference measurements gave a consistent result.', 54, 272, 245)
  ])
  const owner = units.find((unit) => unit.items.includes('1:11'))!
  if (gap === 0) {
    assert.match(owner.source, /narrow 40-μm aperture opening/u)
    assert.equal(owner.sourceOnly, undefined)
    assert.deepEqual(owner.items, ['1:9', '1:11', '1:12', '1:13'])
  } else {
    assert.equal(owner.sourceOnly, true)
    assert.deepEqual(owner.items, ['1:11'])
  }
  const expression = units.find((unit) => unit.items.includes('1:5'))
  assert.equal(expression?.sourceOnly, true)
  assert.deepEqual(expression?.items, ['1:4', '1:5', '1:6', '1:7', '1:8'])
})

it.each([0, 16])(
  'keeps a wrapped parity condition between native formulas on its text rail (%s)',
  (offset) => {
    const rows = [
      ['Consider the complementary case', 71.94, 443.87, 137.74, 9.96, 'body', false],
      ['Q', 213.78, 451.35, 9.41, 9.96, 'product', false],
      ['j', 223.19, 440.89, 2.82, 6.97, 'small-math', false],
      ['sin(3', 228.17, 443.87, 22.19, 9.96, 'body', false],
      ['ψ', 250.36, 443.87, 4.68, 9.96, 'math', false],
      ['j', 255.04, 442.38, 2.82, 6.97, 'small-math', false],
      [')', 258.35, 443.87, 3.87, 9.96, 'body', false],
      ['>', 266.28, 443.87, 7.75, 9.96, 'math', false],
      ['+', 278.09, 443.87, 7.75, 9.96, 'operator', false],
      ['2', 287.03, 447.8, 3.97, 6.97, 'script', true],
      ['3', 287.03, 440.44, 3.97, 6.97, 'script', false],
      ['.', 292.19, 443.87, 2.77, 9.96, 'body', false],
      [
        'By the positivity of this product, there is an even',
        301.71,
        443.87,
        223.29,
        9.96,
        'body',
        true
      ],
      ['number of indices', 57, 430.48, 77.14, 9.96, 'body', false],
      ['j', 137.52, 430.48, 3.43, 9.96, 'math', false],
      ['such that', 144.34, 430.48, 40.79, 9.96, 'body', false],
      ['ψ', 188.5, 430.48, 4.68, 9.96, 'math', false],
      ['j', 193.18, 428.99, 2.82, 6.97, 'small-math', false],
      ['>', 199.37, 430.48, 7.75, 9.96, 'math', false],
      ['α', 211.18, 434.41, 4.66, 6.97, 'small-math', false],
      ['5', 211.65, 427.05, 3.97, 6.97, 'script', false]
    ] as const
    const units = translationUnits(
      rows.map(([text, x, y, width, size, fontName, hasEOL], index) =>
        item(text, x + (index >= 13 ? offset : 0), y, width, { size, fontName, hasEOL })
      )
    )
    const count = units.find((unit) => unit.items.includes('1:12'))
    assert.equal(count?.source.includes('an even number of indices'), offset === 0)
    assert.equal(count?.items.includes('1:15'), offset === 0)
    for (const key of ['1:11', '1:16']) {
      const formula = units.find((unit) => unit.items.includes(key))
      assert.equal(formula?.sourceOnly, true)
      assert.equal(formula?.preserve, 'formula')
    }
    assert.equal(units.flatMap((unit) => unit.items).length, rows.length)
  }
)

it.each([0, 4])('joins a cited name between its native formulas (row offset %s)', (offset) => {
  const rows = [
    ['be rewritten in the following form, where', 47.82, 251.11, 126.39, 8.97, 'body', false],
    ['D', 176.52, 251.11, 6.14, 8.97, 'math', false],
    ['−', 183.05, 254.79, 5.65, 7.27, 'operator', false],
    ['1', 188.78, 254.79, 3.49, 6.97, 'body', false],
    ['α', 182.82, 247.8, 3.78, 6.97, 'symbol', false],
    ['is rewritten using North-', 195.01, 251.11, 103.52, 8.97, 'body', true],
    ['land identity [7]:', 47.82, 238.39, 72.39, 8.97, 'body', false],
    ['D', 55.34, 214.79, 6.14, 8.97, 'math', false],
    ['−', 61.86, 218.49, 5.65, 7.27, 'operator', false],
    ['1', 67.6, 218.49, 3.49, 6.97, 'body', false],
    ['α', 61.64, 211.49, 3.78, 6.97, 'symbol', false],
    ['RZ', 72.15, 214.79, 11.91, 8.97, 'math', false],
    ['e', 87.37, 214.79, 3.98, 8.97, 'math', false],
    ['=', 97.06, 214.79, 7.27, 9.34, 'relation', false]
  ] as const
  const units = translationUnits(
    rows.map(([str, x, y, width, size, fontName, hasEOL], index) =>
      item(str, x, y - (index === 6 ? offset : 0), width, { size, fontName, hasEOL })
    )
  )
  const clause = units.find((unit) => unit.items.includes('1:5'))
  assert.equal(clause?.source.includes('Northland identity [7]:'), offset === 0)
  assert.equal(clause?.items.includes('1:6'), offset === 0)
  assert.equal(units.find((unit) => unit.items.includes('1:7'))?.preserve, 'formula')
})

it.each([0, 16])(
  'joins the phrase introducing a native display only on its text rail (%s)',
  (offset) => {
    const rows = [
      ['Let', 96.85, 395.87, 15.59, 10.91, 'body', false],
      ['(', 115.91, 395.87, 4.16, 10.91, 'delimiter', false],
      ['p, q', 120.06, 395.87, 16.39, 10.91, 'variable', false],
      [')', 136.83, 395.87, 4.16, 10.91, 'delimiter', false],
      [
        'be chosen from the set. There is a unique normalized rational triple',
        144.45,
        395.87,
        321.99,
        10.91,
        'body',
        false
      ],
      ['(', 469.91, 395.87, 4.16, 10.91, 'delimiter', false],
      ['x, y, z', 474.07, 395.87, 24.86, 10.91, 'variable', false],
      [')', 498.94, 395.87, 4.16, 10.91, 'delimiter', false],
      ['such', 506.56, 395.87, 20.54, 10.91, 'body', true],
      ['that', 84.9, 382.92, 20, 10.91, 'body', false],
      ['(', 262.52, 369.97, 4.24, 10.91, 'delimiter', false],
      ['p, q', 266.76, 369.97, 16.39, 10.91, 'variable', false],
      [') = (', 283.52, 369.97, 23.04, 10.91, 'delimiter', false],
      ['x/z, y/z', 306.56, 369.97, 35.65, 10.91, 'variable', false],
      [')', 342.21, 369.97, 4.24, 10.91, 'delimiter', false],
      ['.', 346.46, 369.97, 3.03, 10.91, 'variable', false]
    ] as const
    const units = translationUnits(
      rows.map(([text, x, y, width, size, fontName, hasEOL], index) =>
        item(text, x + (index === 9 ? offset : 0), y, width, { size, fontName, hasEOL })
      )
    )
    const stem = units.find((unit) => unit.items.includes('1:8'))
    assert.equal(stem?.items.includes('1:9'), offset === 0)
    assert.equal(stem?.source.endsWith('such that'), offset === 0)
    const display = units.find((unit) => unit.items.includes('1:10'))
    assert.equal(display?.sourceOnly, true)
    assert.equal(display?.preserve, 'formula')
    assert.equal(units.flatMap((unit) => unit.items).length, rows.length)
  }
)

it.each([0, 4])(
  'joins a terminal word before a new paragraph across centered folios (%s)',
  (shift) => {
    const pages: PdfLayoutPage[] = [
      [
        item('The archived samples establish a separate comparison group.', 54, 525, 243),
        item('The second series started on a separate schedule after the', 325, 106.5, 233),
        item('initial measurements. Every trial followed the same rule', 315, 95, 243),
        item('under the agreed interpretation of the instrument map.', 315, 83.5, 243),
        item('The measurement procedure applied only to the sam-', 315, 72, 243),
        item('1', 303.5, 42, 5, { hasEOL: false })
      ],
      [
        item('ples with an approved handling label.', 54, 710, 137),
        item(
          'The samples were then measured under standard conditions.',
          64 + shift,
          697.8,
          233 - shift
        ),
        item('All operators recorded each attempt before the next trial.', 54, 686.3, 243),
        item('2', 303.5, 42, 5, { hasEOL: false })
      ]
    ].map((items, index) => ({ page: index + 1, width: 612, height: 792, rotation: 0, items }))
    const { units } = groupPdfTranslationPages({ pages })
    const paragraph = units.find((unit) => unit.items.includes('1:4'))
    assert.equal(
      paragraph?.source.endsWith('samples with an approved handling label.'),
      shift === 0
    )
    assert.equal(paragraph?.fragments.length, shift ? 1 : 2)
    assert.equal(units.find((unit) => unit.items.includes('2:1'))?.items.includes('1:4'), false)
    for (const key of ['1:5', '2:3']) {
      assert.equal(units.find((unit) => unit.items.includes(key))?.sourceOnly, true)
    }
  }
)

it.each([0, 4])('retains encoded script glyphs in paired displays (%s)', (shift) => {
  const math = { fontName: 'math', size: 9, hasEOL: false }
  const script = { ...math, size: 6.4 }
  const label = { size: 9, hasEOL: false }
  const blank = { size: 0 }
  const units = translationUnits([
    item('The two estimates are derived with the same procedure:', 317, 522, 235, label),
    item('', 338, 493, 0, blank),
    item('𝑧', 338, 493, 8, math),
    item('௥௣', 346, 491.3, 15, script),
    item('≈', 364, 493, 7, math),
    item('௫బ', 380, 498.3, 9, script),
    item('', 380, 488.2, 0, blank),
    item('௜మ', 380, 488.2, 9, script),
    item('(2.a)', 533, 493, 18, label),
    item('', 338, 468, 0, blank),
    item('𝑧', 338, 468, 8, math),
    item('௥௖', 346, 466.3, 15, script),
    item('≈ 2𝑛', 364, 468, 18, math),
    item('௫బ', 388, 473.3, 9, script),
    item('', 388, 463.2, 0, blank),
    item('௡మ', 388, 463.2, 9, script),
    item('(2.b)', 533 + shift, 468, 18, label),
    item('', 317, 439, 0, blank),
    item('These estimates give the values needed for the next calculation.', 317, 439, 240, label)
  ])
  for (const key of ['1:3', '1:7', '1:11', '1:15']) {
    const owner = units.find((unit) => unit.items.includes(key))
    assert.ok(owner)
    assert.equal(owner.sourceOnly === true, shift === 0)
  }
  assert.equal(units.find((unit) => unit.items.includes('1:18'))?.sourceOnly, undefined)
})

it.each([0, 4])(
  'keeps a parenthetical figure reference with its paragraph across pages (%s)',
  (shift) => {
    const text = { size: 11, hasEOL: false }
    const folio = { size: 12, fontName: 'folio', hasEOL: false }
    const blank = (x: number, y: number): PdfLayoutTextItem => item('', x, y, 0, { size: 0 })
    const left = [
      item('1', 532, 53, 6, folio),
      item(
        'Fig. 2: (a) Sampling frame, (b) Support panel, and (c) Data logger.',
        85,
        148,
        427,
        text
      ),
      blank(93, 110),
      item('In the next trial the frame was set against the outer wall. We', 93, 110, 445, text),
      blank(57, 91),
      item(
        'recorded five measurements at the same height along the outer wall.',
        57,
        91,
        481,
        text
      ),
      blank(57, 72),
      item(
        'The observer marked the positions where the cable was attached (Refer to',
        57,
        72,
        481,
        text
      )
    ]
    const right = [
      item('2', 532, 53, 6, folio),
      blank(57, 775),
      item('Fig. 2a).', 57 + shift, 775, 37, text),
      item(' ', 94, 775, 4, { size: 0, hasEOL: false }),
      item(
        'We used several identical sensors to review the consistency of the recordings',
        98,
        775,
        440,
        text
      ),
      blank(57, 756),
      item(
        'across the complete observation sequence before the instruments were removed',
        57,
        756,
        481,
        text
      ),
      blank(57, 737),
      item(
        'from the panel and secured for later inspection under the same operating',
        57,
        737,
        481,
        text
      ),
      blank(57, 718),
      item('conditions.', 57, 718, 57, text),
      blank(93, 699),
      item(
        'Separate observations were made after the support was placed in storage.',
        93,
        699,
        445,
        text
      )
    ]
    const pages: PdfLayoutPage[] = [left, right].map((items, i) => ({
      page: i + 1,
      width: 595,
      height: 842,
      rotation: 0,
      items
    }))
    const { units } = groupPdfTranslationPages({ pages })
    const paragraph = units.find((unit) => unit.items.includes('1:3'))
    assert.equal(paragraph?.source.includes('We recorded five measurements'), shift === 0)
    assert.equal(paragraph?.source.includes('(Refer to Fig. 2a).'), shift === 0)
    assert.equal(paragraph?.fragments.length, shift ? 1 : 3)
    assert.equal(
      units.find((unit) => unit.items.includes('1:1'))?.source.startsWith('Fig. 2:'),
      true
    )
    assert.equal(units.find((unit) => unit.items.includes('1:0'))?.sourceOnly, true)
  }
)

it.each([true, false])(
  'retains a bibliography with a merged heading and raised ordinals across columns (%s)',
  (consecutive) => {
    const body = { size: 8, hasEOL: false }
    const ordinal = { size: 5, fontName: 'ordinal', hasEOL: false }
    const rowBreak = { size: 0 }
    const entry = (
      n: number,
      x: number,
      y: number,
      author: string,
      end: string
    ): PdfLayoutTextItem[] => [
      item('', x, y + 2.5, 0, rowBreak),
      item(String(n), x, y + 2.5, 2.5, ordinal),
      item(author, x + 2.5, y, 240, body),
      item('', x, y - 9.5, 0, rowBreak),
      item(end, x, y - 9.5, 182, body)
    ]
    const { units } = groupPdfTranslationPages({
      pageCount: 1,
      pages: [
        {
          page: 1,
          width: 612,
          height: 792,
          rotation: 0,
          items: [
            item('The measurements are available through the research archive.', 50, 235, 241),
            item('The comparison methods are summarized in the preceding section.', 50, 223, 245),
            item('', 50, 195.5, 0, rowBreak),
            item('REFERENCES', 50, 195.5, 59, { size: 9, fontName: 'heading', hasEOL: false }),
            ...entry(
              1,
              50,
              183,
              'A. Rowan, C. Pines, and B. Alder, “Methods for calibrating',
              'pressure sensors,” Meas. J. 12, 36 (2001).'
            ),
            ...entry(
              2,
              50,
              155,
              'M. Grove, K. Aspen, and P. Moss, “Comparing electrical',
              'signals,” Instrum. J. 6, 21 (2002).'
            ),
            ...entry(
              3,
              50,
              127,
              'L. Hazel, F. Bloom, and J. Fern, “Repeated tests of small',
              'receivers,” Sound J. 8, 48 (2003).'
            ),
            ...entry(
              4,
              50,
              99,
              'D. Reed, T. Cedar, and S. Pine, “System measurements for',
              'lab and classroom use:'
            ),
            item('', 318, 738, 0, rowBreak),
            item('Approaches and results,” Educ. J. 7, 35 (2004).', 318, 738, 202, body),
            ...entry(
              5,
              318,
              718,
              'S. Alder, R. Flint, and D. Thorn, “Setup notes for students',
              'and instructors,” Lab J. 9, 65 (2005).'
            ),
            ...entry(
              consecutive ? 6 : 8,
              318,
              690,
              'P. Beech, A. Birch, and J. Stone, “Estimates of ambient',
              'temperature,” Field J. 4, 83 (2006).'
            )
          ]
        }
      ]
    })
    const first = units.find((unit) => unit.source.startsWith('REFERENCES 1'))
    const carried = units.find((unit) => unit.source.startsWith('Approaches and results'))
    assert.ok(first && carried)
    assert.equal(first.preserve === 'reference', consecutive)
    assert.equal(carried.preserve === 'reference', consecutive)
    assert.equal(units[0].sourceOnly, undefined)
  }
)

it.each([true, false])(
  'separates a centered Roman section after a native introduction (%s)',
  (cue) => {
    const open = { hasEOL: false }
    const units = translationUnits([
      item('The prior procedure cannot estimate the residual response.', 49, 477, 250),
      item('The remaining assumptions are checked for each input type.', 49, 465, 250),
      item(
        cue
          ? 'We explain the improved measurement in the next section.'
          : 'We explain the improved measurement in the next sections',
        49,
        453,
        241
      ),
      item('IV. S', 73, 436, 26, open),
      item('EPARATE CALIBRATION FOR FIELD TESTS', 99.5, 436, 175.5, { size: 8, ...open }),
      item('', 59, 421, 0, { size: 0 }),
      item('The instrument was adjusted to test the same conditions', 59, 421, 240),
      item('before taking readings from the input to check the amplifier.', 49, 409, 250),
      item('Several measurements showed the same response in each trial.', 49, 397, 248)
    ])
    const heading = units.find((unit) => unit.items.includes('1:3'))
    const body = units.find((unit) => unit.items.includes('1:6'))
    assert.ok(heading && body)
    assert.equal(heading !== body, cue)
    assert.equal(heading.items.includes('1:6'), !cue)
    assert.equal(body.source.startsWith('The instrument'), cue)
  }
)

it.each([0, 4])('rejoins widely justified footer words with a page-turn sentence (%s)', (shift) => {
  const head = 'Several calibration issues remain. The current arrangement uses reflective control'
  const words = [
    ['panels,', 54],
    ['local', 31],
    ['sensors,', 49],
    ['limited', 42],
    ['viewing', 48],
    ['range', 34],
    ['and', 18],
    ['variable', 55],
    ['lighting', 49]
  ] as const
  const open = { size: 12, hasEOL: false }
  const marker = item('', 72, 75, 0, { size: 0 })
  let x = 72
  const row = words.flatMap(([text, width], index) => {
    const word = item(text, x, 75 - (index === 3 ? shift : 0), width, open)
    x += width + 11
    return index === words.length - 1
      ? [word]
      : [word, { ...item(' ', x - 11, 75, 1, open), height: 0 }]
  })
  const pages = [
    [
      item('Earlier measurements followed a separate calibration procedure.', 72, 128, 468, open),
      item('', 108, 91, 0, { size: 0 }),
      item(head, 108, 91, 432, open),
      marker,
      ...row
    ],
    [
      item(
        'conditions. The setup also requires regular inspection of the hardware to',
        72,
        709,
        468,
        open
      ),
      item('', 72, 693, 0, { size: 0 }),
      item('maintain consistent responses across operating environments.', 72, 693, 321, open),
      item('', 108, 665, 0, { size: 0 }),
      item('The following section describes additional checks.', 108, 665, 300, open)
    ]
  ].map((items, index): PdfLayoutPage => ({
    page: index + 1,
    width: 612,
    height: 792,
    rotation: 0,
    items
  }))
  const layout = groupPdfTranslationPages({ pages })
  const owner = layout.units.find((unit) => unit.items.includes('1:2'))
  assert.ok(owner)
  assert.equal(
    owner.source.includes('limited viewing range and variable lighting conditions.'),
    shift === 0
  )
  assert.deepEqual(
    owner.fragments.map(({ page }) => page),
    shift ? [1] : [1, 2]
  )
  assert.equal(owner.items.includes('2:4'), false)
  assert.equal(
    layout.pages[0].blocks.find(({ id }) => id === owner.fragments[0].id)?.items.length,
    shift ? 1 : 10
  )
})

it.each([0, 4])('rejoins a display lead from below an opening figure (%s)', (shift) => {
  const lead = 'The change in volume caused by the pressure-dependent'
  const resume = 'response coefficient ratio r can be calculated as'
  const pages = [
    [
      item('The initial estimates are based on repeat observations.', 54, 320, 245),
      item('The procedure was repeated after a calibration check.', 317, 82, 245),
      item(lead, 317, 70, 245, { hasEOL: false })
    ],
    [
      item('2', 557, 756, 5),
      item('0.5', 109, 588, 12, { fontName: 'axis', size: 7 }),
      item('FIG. 2. Estimates from the first observation interval.', 54, 457, 245, { size: 9 }),
      item('Only verified results are shown.', 54, 447, 134, { size: 9, hasEOL: false }),
      item('', 54, 413, 0, { size: 0 }),
      item(resume, 54, 413, 219),
      item('P = A + B', 104, 387, 57),
      item('(2)', 286 + shift, 387, 13)
    ]
  ].map((items, i): PdfLayoutPage => ({ page: i + 1, width: 612, height: 792, rotation: 0, items }))
  const units = groupPdfTranslationPages({ pages }).units
  const head = units.find((unit) => unit.items.includes('1:2'))
  assert.ok(head)
  assert.equal(head.source.endsWith(lead + ' ' + resume), shift === 0)
  assert.deepEqual(
    head.fragments.map(({ page }) => page),
    shift ? [1] : [1, 2]
  )
  assert.equal(head.items.includes('2:2'), false)
  assert.equal(head.items.includes('2:7'), false)
})

it.each([0, 4])('keeps a cited closing noun with its display introduction (%s)', (shift) => {
  const lead = 'The calibration was modeled using the relation reported in earlier'
  const tail = 'studies [11–14],'
  const units = translationUnits([
    item('We compared all observations with the reference data.', 317, 630, 245),
    item(lead, 317, 616, 245),
    item(tail, 317 + shift, 604, 63, { hasEOL: false }),
    item('', 357, 583, 0, { size: 0 }),
    item('q = x + y', 357, 583, 55, { fontName: 'formula', hasEOL: false }),
    item('(1)', 549, 583, 13),
    item('The later checks are evaluated independently.', 317, 554, 230)
  ])
  const head = units.find((unit) => unit.items.includes('1:1'))
  assert.ok(head)
  assert.equal(head.source.endsWith(lead + ' ' + tail), shift === 0)
  assert.equal(head.items.includes('1:2'), shift === 0)
  assert.equal(head.items.includes('1:4'), false)
  assert.equal(head.items.includes('1:5'), false)
})
