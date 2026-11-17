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
