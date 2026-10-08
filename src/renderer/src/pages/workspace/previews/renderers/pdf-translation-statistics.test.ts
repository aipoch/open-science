import assert from 'node:assert/strict'
import { it as test } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from './pdf-translation-layout'

test.each([
  'comparative ranges',
  'confidence interval',
  'standalone equation',
  'open probability',
  'operand explanation',
  'unrelated previous row',
  'different column',
  'different baseline',
  'different return font',
  'unknown glyph',
  'interposed native owner',
  'unproved wide gap'
])('wrapped comparative statistics require complete native prose proof: %s', (variant) => {
  const positive = ['comparative ranges', 'confidence interval'].includes(variant)
  const lead =
    variant === 'confidence interval'
      ? '12.5) mg, mean difference, −1 (95% confidence interval CI, −4 to 1)'
      : variant === 'unrelated previous row'
        ? 'This preceding sentence describes an unrelated completed outcome.'
        : 'The patients had shorter time to ambulation [20'
  const prefix = variant === 'confidence interval' ? 'mg,' : '(17–24) h vs. 21 (19–35.5) h,'
  const rows: PdfLayoutTextItem[] = [
    { ...item(lead, 40, 100, 300, true), fontName: 'body' },
    ...(variant === 'interposed native owner'
      ? [{ ...item('Independent native owner', 440, 105, 100, true), fontName: 'body' }]
      : []),
    ...(variant === 'standalone equation'
      ? []
      : [{ ...item(prefix, 40, 112, 140), fontName: 'body' }]),
    { ...item(' ', 180, 112, 0), fontName: 'body' },
    { ...item('p', variant === 'unproved wide gap' ? 190 : 185.5, 112, 5), fontName: 'italic' },
    { ...item('=', 191.5, 112, 6), fontName: 'body' },
    ...(variant === 'unknown glyph'
      ? [{ ...item('\u0015', 197.5, 112, 5), fontName: 'symbol' }]
      : []),
    {
      ...item(
        variant === 'open probability'
          ? '0.021 and flatus was earlier.'
          : variant === 'operand explanation'
            ? '0.021] where x is an operand.'
            : '0.021] and flatus was earlier.',
        variant === 'different column' ? 440 : 198.5,
        variant === 'different baseline' ? 116 : 112,
        141.5,
        true
      ),
      fontName: variant === 'different return font' ? 'foreign' : 'body'
    }
  ]
  const unchanged = structuredClone(rows)
  const result = groupPdfTranslationPages({
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        items: rows
      }
    ]
  })
  assert.equal(
    result.units.some(
      (unit) =>
        !unit.sourceOnly &&
        unit.items.includes('1:0') &&
        unit.items.includes(`1:${rows.length - 1}`)
    ),
    positive,
    JSON.stringify(result.units)
  )
  assert.equal(
    new Set(result.units.flatMap((unit) => unit.items)).size,
    rows.filter((row) => row.str.trim()).length
  )
  assert.deepEqual(rows, unchanged)
})

test('two adjacent comparative ranges retain row order and all native owners', () => {
  const rows = [
    {
      ...item('The patients had shorter time to ambulation [20', 54, 100, 286, true),
      fontName: 'body'
    },
    { ...item('(17–24) h vs. 21 (19–35.5) h,', 40, 112, 140), fontName: 'body' },
    { ...item('p', 182, 112, 5), fontName: 'italic' },
    { ...item('=', 188, 112, 6), fontName: 'body' },
    { ...item('0.021] and flatus [34 (24–47) h vs. 48', 195, 112, 145, true), fontName: 'body' },
    { ...item('(39.5–62) h,', 40, 124, 80), fontName: 'body' },
    { ...item('p', 122, 124, 5), fontName: 'italic' },
    { ...item('=', 128, 124, 6), fontName: 'body' },
    { ...item('0.001] than the control group.', 135, 124, 145, true), fontName: 'body' }
  ]
  const result = groupPdfTranslationPages({
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        items: rows
      }
    ]
  })
  assert.equal(result.units.length, 1, JSON.stringify(result.units))
  assert.ok(!result.units[0].sourceOnly)
  assert.deepEqual(
    result.units[0].items,
    rows.map((_, index) => `1:${index}`)
  )
  assert.match(result.units[0].source, /0\.021\] and flatus .*0\.001\] than/u)
})

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  hasEOL = false
): PdfLayoutTextItem => ({
  str,
  width,
  height: 10,
  dir: 'ltr',
  hasEOL,
  transform: [10, 0, 0, 10, x, 800 - y]
})

const extract = (
  suffix: string,
  x = 86,
  y = 112,
  lead = '(SD',
  interposed = false
): ReturnType<typeof groupPdfTranslationPages>['units'] =>
  groupPdfTranslationPages({
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        items: [
          item('We estimated the mean age at 40 years', 40, 100, 300, true),
          item(lead, 40, 112, 27),
          item('=', 71, 112, 10),
          ...(interposed ? [item('Independent native content.', 400, 200, 170, true)] : []),
          item(suffix, x, y, 300, true)
        ]
      }
    ]
  }).units

for (const label of ['SD', 'SE']) {
  test(`a closed ${label} statistic stays with its native adjacent prose`, () => {
    const units = extract(
      '8.5), while the remaining participants were younger.',
      86,
      112,
      `(${label}`
    )
    assert.ok(
      units.some(
        (unit) =>
          !unit.sourceOnly &&
          /We estimated/u.test(unit.source) &&
          new RegExp(`\\(${label}\\s*=\\s*8\\.5\\), while`, 'u').test(unit.source)
      ),
      JSON.stringify(units)
    )
  })
}

test.each([
  { name: 'a different column', suffix: '8.5), while the next column reports outcomes.', x: 220 },
  {
    name: 'a shifted native baseline',
    suffix: '8.5), while the remaining participants were younger.',
    y: 113
  },
  { name: 'an unclosed expression', suffix: '8.5, while the remaining participants were younger.' },
  { name: 'a named variable', lead: '(AB', suffix: '8.5), while the calculation continues.' },
  { name: 'a formula definition', suffix: '8.5) where SD denotes the variable in this equation.' },
  {
    name: 'intervening native content',
    suffix: '8.5), while the remaining participants were younger.',
    interposed: true
  },
  { name: 'a symbolic operand', suffix: 'x), while the calculation continues.' }
])('$name retains its formula boundary', ({ suffix, x, y, lead, interposed }) => {
  const units = extract(suffix, x, y, lead, interposed)
  assert.ok(
    !units.some((unit) => !unit.sourceOnly && /\((?:SD|SE|AB)\s*=\s*(?:8\.5|x)/u.test(unit.source)),
    JSON.stringify(units)
  )
})

const wrappedStatistic = (
  introduction: string,
  prefix: [string, string][],
  suffix: string,
  options: {
    x?: number
    y?: number
    interposed?: boolean
    tailFont?: string
    interposedBeforeTail?: boolean
    suffixBeforeOperator?: boolean
    tailY?: number
  } = {}
): ReturnType<typeof groupPdfTranslationPages>['units'] => {
  let x = options.x ?? 40
  const runs = prefix.map(([str, fontName]) => {
    const part = { ...item(str, x, options.y ?? 112, 8), fontName }
    x += 9
    return part
  })
  const tail = {
    ...item(suffix, x, options.tailY ?? options.y ?? 112, 290, true),
    fontName: options.tailFont ?? 'body'
  }
  const lineRuns = options.suffixBeforeOperator
    ? [...runs.slice(0, -1), tail, ...runs.slice(-1)]
    : [
        ...runs,
        ...(options.interposedBeforeTail
          ? [
              {
                ...item('Independent content remains in another column.', 390, 200, 170, true),
                fontName: 'body'
              }
            ]
          : []),
        tail
      ]
  return groupPdfTranslationPages({
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        items: [
          { ...item(introduction, 40, 100, 310, true), fontName: 'body' },
          ...(options.interposed
            ? [
                {
                  ...item('Independent content remains in another column.', 390, 200, 170, true),
                  fontName: 'body'
                }
              ]
            : []),
          ...lineRuns
        ]
      }
    ]
  }).units
}

test('a complete power calculation stays in its introducing native sentence', () => {
  const units = wrappedStatistic(
    'The sample calculation used a power of',
    [
      ['1', 'body'],
      ['−', 'math'],
      ['β', 'greek'],
      ['=', 'math']
    ],
    '0.85, and allowed for participant withdrawal.'
  )
  assert.ok(
    units.some(
      (unit) => !unit.sourceOnly && /power of 1\s*−\s*β\s*=\s*0.85, and/u.test(unit.source)
    ),
    JSON.stringify(units)
  )
})

test.each([
  { name: 'a different column', x: 220 },
  { name: 'a distant baseline', y: 130 },
  { name: 'interposed native text', interposed: true },
  { name: 'native content between the equals sign and value', interposedBeforeTail: true },
  { name: 'a value serialized before its equals sign', suffixBeforeOperator: true },
  { name: 'a different body font', tailFont: 'foreign' },
  { name: 'a symbolic probability', suffix: 'x, and allowed for participant withdrawal.' },
  {
    name: 'a probability outside its range',
    suffix: '1.85, and allowed for participant withdrawal.'
  },
  { name: 'a standalone equation', introduction: 'The following equation defines the variables.' }
])('$name preserves the power expression boundary', ({ introduction, suffix, ...options }) => {
  const units = wrappedStatistic(
    introduction ?? 'The sample calculation used a power of',
    [
      ['1', 'body'],
      ['−', 'math'],
      ['β', 'greek'],
      ['=', 'math']
    ],
    suffix ?? '0.85, and allowed for participant withdrawal.',
    options
  )
  assert.ok(
    !units.some((unit) => !unit.sourceOnly && /1\s*−\s*β\s*=/u.test(unit.source)),
    JSON.stringify(units)
  )
})

test('an uppercase P value closes its confidence interval across a native wrap', () => {
  const units = wrappedStatistic(
    'The estimates at rest [(mean difference, 1.38; 95% CI, −2.21 to 4.98,',
    [
      ['P', 'italic'],
      ['=', 'body']
    ],
    '0.447), (mean difference, 1.22; the second outcome was similar).'
  )
  assert.ok(
    units.some(
      (unit) => !unit.sourceOnly && /95% CI.*P\s*=\s*0.447\), \(mean difference/u.test(unit.source)
    ),
    JSON.stringify(units)
  )
})

test.each([
  {
    name: 'a closed preceding expression',
    introduction: 'The estimates at rest (95% CI, −2.21 to 4.98).'
  },
  {
    name: 'a standalone P definition',
    introduction: 'The following equation describes the analysis.'
  },
  { name: 'a symbolic P operand', suffix: 'x), while another estimate is reported.' },
  { name: 'a different column', x: 220 },
  { name: 'an intervening native object', interposed: true },
  { name: 'a different body font', tailFont: 'foreign' }
])('$name keeps the P expression separate', ({ introduction, suffix, ...options }) => {
  const units = wrappedStatistic(
    introduction ?? 'The estimates at rest (95% CI, −2.21 to 4.98,',
    [
      ['P', 'italic'],
      ['=', 'body']
    ],
    suffix ?? '0.447), while another estimate is reported.',
    options
  )
  assert.ok(
    !units.some((unit) => !unit.sourceOnly && /^.*P\s*=/u.test(unit.source)),
    JSON.stringify(units)
  )
})

test('a numeric dose and literal unit keep the complete native parenthesis together', () => {
  const units = wrappedStatistic(
    'Participants received the conventional intravenous opioid',
    [['pump (2.5', 'body']],
    'μg/kg sufentanil and saline), followed by standard monitoring.'
  )
  assert.ok(
    units.some(
      (unit) => !unit.sourceOnly && /pump \(2.5\s*μg\/kg.*\), followed/u.test(unit.source)
    ),
    JSON.stringify(units)
  )
})

test.each([
  { name: 'a named function', lead: 'log (2.5' },
  { name: 'a symbolic unit', suffix: 'x sufentanil and saline), followed by monitoring.' },
  { name: 'an unclosed dose', suffix: 'μg/kg sufentanil and saline, followed by monitoring.' },
  {
    name: 'an equation inside the parenthesis',
    suffix: 'μg/kg where x = y), followed by monitoring.'
  },
  { name: 'a different font', tailFont: 'foreign' }
])('$name preserves the dose boundary', ({ lead, suffix, ...options }) => {
  const units = wrappedStatistic(
    'Participants received the conventional intravenous opioid',
    [[lead ?? 'pump (2.5', 'body']],
    suffix ?? 'μg/kg sufentanil and saline), followed by monitoring.',
    options
  )
  assert.ok(
    !units.some((unit) => !unit.sourceOnly && /(?:pump|log) \(2.5/u.test(unit.source)),
    JSON.stringify(units)
  )
})

test.each(['atropine (0.01', 'Dexamethasone (5'])(
  'a closed literal dose keeps its native unit with %s',
  (lead) => {
    const suffix = lead.startsWith('atropine')
      ? 'mg/kg) were administered to all participants.'
      : 'mg) and palonosetron were administered to all participants.'
    const units = wrappedStatistic(
      'Once the surgery was complete, all anesthetics were ceased.',
      [[lead, 'body']],
      suffix
    )
    assert.ok(
      units.some((unit) => !unit.sourceOnly && unit.source.includes(lead)),
      JSON.stringify(units)
    )
  }
)

const numericCitation = (
  options: { prefix?: string; suffix?: string; x?: number; y?: number; interposed?: boolean } = {}
): ReturnType<typeof groupPdfTranslationPages>['units'] => {
  const body = (
    str: string,
    x: number,
    y: number,
    width: number,
    end = false
  ): PdfLayoutTextItem => ({
    ...item(str, x, y, width, end),
    fontName: 'body'
  })
  return groupPdfTranslationPages({
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        items: [
          body('Our calculation was predicated on recovery scores, using data', 40, 100, 400, true),
          body(options.prefix ?? 'from Bu et al.‘s study [', 40, 112, 90),
          body('13', 130, 112, 10),
          ...(options.interposed ? [body('Independent content.', 450, 200, 100, true)] : []),
          body(
            options.suffix ?? '], which validated the instrument in a surgical population.',
            options.x ?? 140,
            options.y ?? 112,
            300,
            true
          )
        ]
      }
    ]
  }).units
}

test('a short-word author citation keeps its closed bracket and complete native prose', () => {
  const units = numericCitation()
  assert.ok(
    units.some(
      (u) => !u.sourceOnly && /using data from Bu et al.‘s study \[13\], which/u.test(u.source)
    ),
    JSON.stringify(units)
  )
})

test.each([
  { name: 'an unclosed numeric citation', suffix: ', which validated the instrument.' },
  { name: 'a different citation column', x: 250 },
  { name: 'a shifted citation baseline', y: 113 },
  { name: 'an intervening citation native owner', interposed: true },
  { name: 'a function index', prefix: 'softmax [' },
  { name: 'a symbolic index definition', suffix: '] where x = y in the expression.' },
  { name: 'symbolic short words', prefix: 'A B C [' }
])('$name retains its symbolic/citation boundary', (options) => {
  const units = numericCitation(options)
  assert.ok(
    !units.some(
      (u) =>
        !u.sourceOnly && /(?:study|softmax|C) \[13/u.test(u.source) && /which|where/u.test(u.source)
    ),
    JSON.stringify(units)
  )
})

const closedReference = (
  kind: 'acronym' | 'figure' | 'supplement' | 'authors',
  options: {
    open?: boolean
    function?: boolean
    y?: number
    x?: number
    foreign?: boolean
    interposed?: boolean
  } = {}
): ReturnType<typeof groupPdfTranslationPages>['units'] => {
  const runs: [string, string][] =
    kind === 'acronym'
      ? [
          [`${options.function ? 'log' : 'receptor'} (HR)-`, 'body'],
          ['positive subgroup, with a lower risk.', 'body']
        ]
      : kind === 'figure' || kind === 'supplement'
        ? [
            [`${options.function ? 'log' : 'cancer'} (`, 'body'],
            [kind === 'supplement' ? 'Table 3 and S1 Fig' : 'Figure 3B', 'link'],
            [
              options.open
                ? ', with improved outcomes.'
                : '). In terms of status, outcomes improved.',
              'body'
            ]
          ]
        : [
            ['(', 'body'],
            ['Ma et al., 2023', 'link'],
            [';', 'body'],
            ['Wu et al., 2022', 'link'],
            [
              options.open
                ? '. Additionally, outcomes improved.'
                : '). Additionally, outcomes improved.',
              'body'
            ]
          ]
  let x = 40
  const parts = runs.map(([text, fontName], index) => {
    const width = text.length * 4
    const part = {
      ...item(
        text,
        options.x && index === runs.length - 1 ? options.x : x,
        options.y && index === runs.length - 1 ? options.y : 112,
        width,
        index === runs.length - 1
      ),
      fontName: options.foreign && index === runs.length - 1 ? 'foreign' : fontName
    }
    x += width
    return part
  })
  if (options.interposed)
    parts.splice(parts.length - 1, 0, {
      ...item('Independent content.', 450, 200, 120, true),
      fontName: 'body'
    })
  return groupPdfTranslationPages({
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        items: [
          {
            ...item(
              'The study reported improved results for participants with',
              40,
              100,
              400,
              true
            ),
            fontName: 'body'
          },
          ...parts
        ]
      }
    ]
  }).units
}

test.each(['acronym', 'figure', 'authors'] as const)(
  'a closed %s reference remains complete across native font objects',
  (kind) => {
    const units = closedReference(kind)
    assert.ok(
      units.some(
        (u) =>
          !u.sourceOnly &&
          /The study/u.test(u.source) &&
          (kind === 'acronym'
            ? /receptor \(HR\)-positive/u
            : kind === 'figure'
              ? /cancer \(Figure 3B\)\./u
              : /\(Ma et al., 2023;\s*Wu et al., 2022\)\./u
          ).test(u.source)
      ),
      JSON.stringify(units)
    )
  }
)

test.each([
  { kind: 'figure' as const, open: true },
  { kind: 'authors' as const, open: true },
  { kind: 'acronym' as const, function: true },
  { kind: 'figure' as const, function: true },
  { kind: 'figure' as const, y: 113 },
  { kind: 'authors' as const, y: 113 },
  { kind: 'figure' as const, x: 400 },
  { kind: 'acronym' as const, x: 400 },
  { kind: 'figure' as const, foreign: true },
  { kind: 'authors' as const, foreign: true },
  { kind: 'figure' as const, interposed: true },
  { kind: 'acronym' as const, interposed: true }
])('incomplete or unowned references retain their boundary: %j', ({ kind, ...options }) => {
  const units = closedReference(kind, options)
  assert.ok(
    !units.some(
      (u) =>
        !u.sourceOnly &&
        (kind === 'acronym'
          ? /(?:receptor|log) \(HR\)-\s*positive/u
          : kind === 'figure'
            ? /(?:cancer|log) \(Figure 3B/u
            : /\(Ma et al., 2023;\s*Wu et al., 2022\)/u
        ).test(u.source)
    ),
    JSON.stringify(units)
  )
})

test('a wrapped confidence interval endpoint stays with its complete P value and prose', () => {
  const units = wrappedStatistic(
    'The estimates were higher (RD 17.9%, 95% CI 5.0% to',
    [
      ['30.8%; p', 'body'],
      ['=', 'body']
    ],
    '0.010) and the other estimate remained stable.'
  )
  assert.ok(
    units.some((u) => !u.sourceOnly && /CI 5.0% to 30.8%; p\s*=\s*0.010\) and/u.test(u.source)),
    JSON.stringify(units)
  )
})

test.each([
  { name: 'an open numeric endpoint', suffix: '0.010 and the other estimate remained stable.' },
  { name: 'a symbolic probability', suffix: 'x) and the other estimate remained stable.' },
  {
    name: 'a closed preceding CI',
    introduction: 'The estimates were higher (95% CI 5.0% to 30.8%).'
  },
  { name: 'a standalone formula', introduction: 'The following equation defines the variables.' },
  { name: 'a separate column', x: 220 },
  { name: 'a shifted baseline', tailY: 113 },
  { name: 'an intervening owner', interposedBeforeTail: true },
  { name: 'a foreign body font', tailFont: 'foreign' }
])(
  '$name does not supply a wrapped confidence interval',
  ({ introduction, suffix, ...options }) => {
    const units = wrappedStatistic(
      introduction ?? 'The estimates were higher (RD 17.9%, 95% CI 5.0% to',
      [
        ['30.8%; p', 'body'],
        ['=', 'body']
      ],
      suffix ?? '0.010) and the other estimate remained stable.',
      options
    )
    assert.ok(
      !units.some((u) => !u.sourceOnly && /30.8%; p\s*=\s*(?:0.010|x)/u.test(u.source)),
      JSON.stringify(units)
    )
  }
)

test('a closed supplementary reference keeps its complete native prose', () => {
  const units = closedReference('supplement')
  assert.ok(
    units.some((u) => !u.sourceOnly && /cancer \(Table 3 and S1 Fig\)\. In terms/u.test(u.source)),
    JSON.stringify(units)
  )
})
test.each([
  { open: true },
  { function: true },
  { y: 113 },
  { x: 400 },
  { foreign: true },
  { interposed: true }
])('supplementary reference closure needs native prose proof: %j', (options) => {
  const units = closedReference('supplement', options)
  assert.ok(
    !units.some((u) => !u.sourceOnly && /(?:cancer|log) \(Table 3 and S1 Fig/u.test(u.source)),
    JSON.stringify(units)
  )
})
