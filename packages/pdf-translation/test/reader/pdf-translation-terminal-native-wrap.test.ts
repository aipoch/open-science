import assert from 'node:assert/strict'
import { it } from 'vitest'
import {
  groupPdfTranslationPages,
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
