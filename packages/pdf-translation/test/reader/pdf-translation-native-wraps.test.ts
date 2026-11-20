import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  font = 10.9091,
  fontName = 'body',
  hasEOL = true
): PdfLayoutTextItem => ({
  str,
  width,
  height: font,
  dir: 'ltr',
  fontName,
  hasEOL,
  transform: [font, 0, 0, font, x, 800 - y]
})
const extract = (items: PdfLayoutTextItem[]): ReturnType<typeof groupPdfTranslationPages> =>
  groupPdfTranslationPages({ pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }] })
const sources = (items: PdfLayoutTextItem[]): string[] =>
  extract(items).units.map((unit) => unit.source)

it.each([false, true])('joins the measurement with its panel caption (shifted=%s)', (shifted) => {
  const items = [
    item('Figure 2.', 50, 391, 40, 9, 'label', false),
    item('(Top Left) Filtered observations across the field. (Top', 95, 391, 455, 9, 'caption'),
    item(
      'Center) A map of the same area. (Top Right) Objects located within',
      50,
      402,
      500,
      9,
      'caption'
    ),
    item('3', shifted ? 52 : 50, 413, 4.5, 9, 'caption', false),
    item('r', 54.5, 413, 4.5, 9, 'math', false),
    item('m', 59, 414, 4, 6, 'script', false),
    item('≈', 67, 413, 7, 9, 'symbol', false),
    item('2.5', 77, 413, 11.5, 9, 'caption', false),
    item('′', 88.5, 409, 2, 6, 'script', false),
    item(
      'of the center (left) and in a matching control area (right). We mark one point with a',
      94,
      413,
      417,
      9,
      'caption',
      false
    ),
    item('⋆', 514, 413, 6, 12, 'symbol', false),
    item('due to', 524, 413, 26, 9, 'caption'),
    item(
      'its influence on the fit. (Bottom Left) Residual plot for the selected observations.',
      50,
      424,
      500,
      9,
      'caption'
    ),
    item(
      '(Bottom Center) Results from a second pass. (Bottom Right) Distribution of all values.',
      50,
      435,
      500,
      9,
      'caption'
    ),
    item('ACKNOWLEDGMENTS', 230, 465, 140, 10, 'section')
  ].map((run) => ({ ...run, fontVertical: false, fontAscent: 0.89, fontDescent: -0.216 }))
  const { units } = extract(items)
  const caption = units.find((unit) => unit.items.includes('1:0'))
  expect(caption?.source.includes('located within 3rm ≈ 2.5′')).toBe(!shifted)
  expect(caption?.source.includes('due to its influence')).toBe(!shifted)
  expect(caption?.items).toEqual(items.slice(0, shifted ? 3 : 14).map((_, index) => `1:${index}`))
  expect(units.find((unit) => unit.items.includes('1:14'))?.source).toBe('ACKNOWLEDGMENTS')
})

it.each(['overprint', 'separate letter', 'ordinary next row'])(
  'isolates the component rights notice only with a closed abstract and code row (%s)',
  (proof) => {
    const items = [
      item('A repeat experiment measures the response recorded by each sensor.', 101, 187, 406, 8),
      item(
        'The processed samples are compared with a stable reference recording.',
        101,
        196.5,
        408,
        8
      ),
      item(
        'The method also estimates the load applied to individual test specimens.',
        101,
        206,
        409,
        8
      ),
      item('The final results agree.', 101, 215.5, 53, 8, 'body', false),
      item('c', proof === 'separate letter' ? 173 : 164.3, 215.25, 4, 8, 'body', false),
      item('©', 162, 215.5, 8.4, 8, 'symbol', false),
      item('2020 Regional Research Society', 176, 215.5, 120, 8, 'body', false),
      item(
        proof === 'ordinary next row' ? 'Items listed:' : 'XYZ codes:',
        114,
        226,
        46,
        8,
        'label',
        false
      ),
      item('140.3200, 160.4400, 200.1200', 166, 226, 106, 8, 'body', false),
      item('The next section describes the separate measurements.', 54, 240, 239, 10, 'section')
    ].map((run) => ({ ...run, fontVertical: false, fontAscent: 0.75, fontDescent: -0.205 }))
    const { units } = extract(items)
    const abstract = units.find((unit) => unit.items.includes('1:0'))
    const isolated = proof === 'overprint'
    expect(abstract?.items).toEqual(['1:0', '1:1', '1:2', '1:3'])
    if (isolated) {
      expect(abstract?.sourceOnly).toBeUndefined()
      for (const index of [4, 5, 6]) {
        const notice = units.find((unit) => unit.items.includes(`1:${index}`))
        expect(notice?.items).toEqual([`1:${index}`])
        expect(notice?.sourceOnly).toBe(true)
      }
    } else {
      const untouched = units.find((unit) => unit.items.includes('1:6'))
      expect(untouched?.items).toEqual(['1:5', '1:4', '1:6'])
    }
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      items.map((_, index) => `1:${index}`).sort()
    )
  }
)

it.each(['𝑠', '𝑦', '𝟘', '𝝅'])(
  'keeps a native script packet with its mathematical alphabet base %s',
  (base) => {
    const runs = [
        item(
          'A complete ordinary description defines a native quantity ',
          50,
          100,
          210,
          10,
          'body',
          false
        ),
        item(base, 262, 100, 6, 10, 'math'),
        item('(', 268.5, 96.5, 2, 7, 'script', false),
        item('𝑖', 270.6, 96.5, 2.5, 7, 'script', false),
        item(')', 273.2, 96.5, 2, 7, 'script'),
        item('𝑚𝑜𝑑𝑒', 268.4, 103, 17, 7, 'script'),
        item('}', 286, 100, 4, 10, 'math'),
        item(
          'An independent neighboring column has its own complete description.',
          340,
          96.7,
          220,
          10
        ),
        item('A separate complete ordinary paragraph begins below.', 50, 130, 240, 10)
      ],
      result = extract(runs),
      parent = result.units.find((unit) => unit.items.includes('1:1'))!
    for (const index of [2, 3, 4, 5, 6]) expect(parent.items).toContain(`1:${index}`)
    expect(parent.items).not.toContain('1:7')
    expect(parent.source).toContain(base)
    expect(parent.source).toContain('𝑚𝑜𝑑𝑒')
    expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
      runs.map((_, index) => `1:${index}`).sort()
    )
    expect(result.pages[0].blocks.flatMap((block) => block.originalStrings).sort()).toEqual(
      runs.map((run) => run.str).sort()
    )
  }
)

it.each([false, true])('restores only an adjacent raised parenthesis (%s)', (detached) => {
  const runs = [
    item('The response (using the estimated value of', 40, 342, 160, 9, 'body', false),
    item('σ', 202, 342, 5.4, 9, 'math', false),
    item('(', 207.6, 337.1, 2.8, 7.3, 'punctuation', false),
    item('4', 210.5, 337.1, 3.5, 7, 'body', false),
    item(')', detached ? 215.6 : 214.1, 337.1, 2.8, 7.3, 'punctuation', false),
    { ...item('', 207.5, 345.2, 0, 7), height: 0 },
    item('234', 207.5, 345.2, 10.5, 7, 'body', false),
    item('=', 221, 342, 7.3, 9.35, 'punctuation', false),
    item('An independent right column lists another observation.', 310, 342.6, 240, 9)
  ].map((run) => ({ ...run, fontVertical: false, fontAscent: 0.75, fontDescent: -0.18 }))
  const { units } = extract(runs)
  const body = units.find((unit) => unit.items.includes('1:0'))!
  expect(body.source).toContain(detached ? 'σ(4234' : 'σ(4)234')
  expect(body.items).toEqual(
    detached
      ? ['1:0', '1:1', '1:2', '1:3', '1:6', '1:7']
      : ['1:0', '1:1', '1:2', '1:3', '1:4', '1:6', '1:7']
  )
  expect(units.filter((unit) => unit.items.includes('1:4'))).toHaveLength(1)
  expect(units.find((unit) => unit.items.includes('1:8'))?.items).toEqual(['1:8'])
})

it.each([false, true])('rejoins a native wrapped word with an inline index (%s)', (overlap) => {
  const metrics = {
    body: [0.715, -0.282],
    symbol: [0.482, -0.276],
    punctuation: [0.694, -0.194],
    index: [0.722, -0.261],
    sum: [0, 0]
  }
  const run = (
    text: string,
    x: number,
    baseline: number,
    width: number,
    size = 9,
    font: keyof typeof metrics = 'body',
    hasEOL = false
  ): PdfLayoutTextItem => ({
    ...item(text, x, 800 - baseline, width, size, font, hasEOL),
    height: text ? size : 0,
    fontAscent: metrics[font][0],
    fontDescent: metrics[font][1],
    fontVertical: false
  })
  const items = [
    run(
      'This calculation uses independent readings from the later trials',
      46,
      290,
      243,
      8,
      'body',
      true
    ),
    run(
      'the reference value is derived from the final sensor calcu-',
      46,
      164,
      250,
      9,
      'body',
      true
    ),
    run('lation [', 46, 150, 40),
    run('12', 86, 150, 9),
    run('] compares the reference with the independent signal', 95, 150, 176),
    run('φ', 276.4, 150, 5.3, 9, 'symbol'),
    run('(', 281.9, 154.9, 2.8, 7.3, 'punctuation'),
    run('j', 284.9, 154.9, 5.4, 7, 'index'),
    run(')', 290.5, 154.9, 2.8, 7.3, 'punctuation'),
    run('', 281.9, 148.3, 0, 7, 'index', true),
    run('k', 281.9, 148.3, 3.9, 7, 'index'),
    run(',', 294, 150, 2, 9, 'body', true),
    run('after each cycle, the recorded values were compared independently.', 45.6, 139.1, 220),
    run('∑', overlap ? 89 : 383, overlap ? 166 : 535, 7, 9, 'sum')
  ]
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
  })
  const owner = (index: number): (typeof units)[number] | undefined =>
    units.find((unit) => unit.items.includes(`1:${index}`))
  const head = owner(1)
  const tail = owner(2)
  expect(tail?.source).toContain('φ(j)k')
  expect(owner(8)).toBe(tail)
  expect(units.flatMap((unit) => unit.items).sort()).toEqual(
    items.flatMap((part, index) => (part.str ? [`1:${index}`] : [])).sort()
  )
  if (overlap) {
    expect(head).not.toBe(tail)
  } else {
    expect(head).toBe(tail)
    expect(head?.source).toContain('sensor calculation [12]')
    expect(head?.fragments).toHaveLength(2)
    expect(owner(13)).not.toBe(head)
  }
})

it.each<[string, boolean]>([
  ['y', true],
  ['η', true],
  ['2', true],
  [')', true],
  [']', true],
  ['𝑠', true],
  ['𝑦', true],
  ['𝟘', true],
  ['𝝅', true],
  [String.fromCodePoint(0x1d455), false],
  [String.fromCodePoint(0x1d6c1), false],
  [String.fromCodePoint(0x1d6db), false],
  ['🙂', false]
])('keeps native script ownership bounded by the base %s (attached=%s)', (base, attached) => {
  const runs = [
      item(base, 50, 100, 6, 10, 'math'),
      item('i', 56.5, 96.5, 4, 7, 'script'),
      item('An independent neighboring row has its own complete description.', 65, 95, 220, 10)
    ],
    result = extract(runs),
    parent = result.units.find((unit) => unit.items.includes('1:0'))!
  expect(parent.items.includes('1:1')).toBe(attached)
  if (attached) expect(parent.items).not.toContain('1:2')
  expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
    runs.map((_, index) => `1:${index}`).sort()
  )
  expect(result.pages[0].blocks.flatMap((block) => block.originalStrings).sort()).toEqual(
    runs.map((run) => run.str).sort()
  )
})

it.each(['μ', '𝑖'])(
  'keeps the native %s script with its adjacent base before a closer column',
  (script) => {
    const runs = [
        item(
          'A complete ordinary description defines the native vector ',
          50,
          100,
          210,
          10,
          'body',
          false
        ),
        item('η', 262, 100, 6, 10, 'math', false),
        item(script, 268.5, 96.5, 4, 7, 'script'),
        item(
          'An independent neighboring column has its own ordinary description.',
          340,
          96.7,
          220,
          10
        ),
        item('A separate complete ordinary paragraph begins below.', 50, 130, 240, 10)
      ],
      result = extract(runs),
      parent = result.units.find((unit) => unit.items.includes('1:1'))!
    expect(parent.items).toContain('1:2')
    expect(parent.source).toContain(`η${script}`)
    expect(parent.sourceOnly).not.toBe(true)
    expect(parent.items).not.toContain('1:3')
    expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
      runs.map((_, index) => `1:${index}`).sort()
    )
  }
)

it.each(['full-size', 'flat-baseline', 'distant-baseline', 'other-column'])(
  'does not attach a Greek label without native script geometry: %s',
  (fault) => {
    const runs = [
        item(
          'A complete ordinary description defines the native vector ',
          50,
          100,
          210,
          10,
          'body',
          false
        ),
        item('η', 262, 100, 6, 10, 'math', false),
        item(
          'μ',
          fault === 'other-column' ? 500 : 268.5,
          fault === 'flat-baseline' ? 100 : fault === 'distant-baseline' ? 70 : 96.5,
          4,
          fault === 'full-size' ? 10 : 7,
          'script'
        ),
        item(
          'An independent neighboring column has its own ordinary description.',
          340,
          96.7,
          140,
          10
        )
      ],
      result = extract(runs),
      parent = result.units.find((unit) => unit.items.includes('1:1'))!
    // Ordinary Greek text can share its body row without mathematical protection.
    if (fault === 'flat-baseline' || fault === 'full-size') {
      expect(parent.sourceOnly).not.toBe(true)
      expect(parent.preserve).toBeUndefined()
    } else expect(parent.items).not.toContain('1:2')
    expect(new Set(result.units.flatMap((unit) => unit.items)).size).toBe(runs.length)
  }
)

it.each([
  'valid',
  'wrapped-title',
  'body-font',
  'mismatched-counter',
  'same-level',
  'foreign-item',
  'indent',
  'tight-gap',
  'different-font'
] as const)('separates only a native root heading and its direct child: %s', (fault) => {
  const runs = [
    item(
      fault === 'wrapped-title' ? 'A complete wrapped heading' : '3 Main Section',
      50,
      100,
      160,
      12,
      fault === 'body-font' ? 'body' : 'heading'
    ),
    item(
      fault === 'wrapped-title'
        ? 'continues on its second native line'
        : fault === 'mismatched-counter'
          ? '4.1 Subsection'
          : fault === 'same-level'
            ? '4 Next Section'
            : '3.1 Subsection',
      fault === 'indent' ? 80 : 50,
      fault === 'tight-gap' ? 110 : 119,
      170,
      12,
      fault === 'different-font' ? 'other-heading' : fault === 'body-font' ? 'body' : 'heading'
    ),
    item(
      'A complete ordinary body paragraph establishes the main native font with enough independent words and remains separate.',
      50,
      150,
      450,
      10,
      'body'
    )
  ]
  if (fault === 'foreign-item')
    runs.splice(
      1,
      0,
      item('An unrelated object stays in another column.', 350, 110, 180, 10, 'body')
    )
  const result = extract(runs),
    parent = result.units.find((unit) => unit.items.includes('1:0'))!
  if (fault === 'valid' || fault === 'indent') {
    expect(parent.source).toBe('3 Main Section')
    expect(result.units.some((unit) => unit.source === '3.1 Subsection')).toBe(true)
  } else {
    // These do not establish independent native heading rows.
    expect(parent.source).toBe(`${runs[0].str} ${runs[fault === 'foreign-item' ? 2 : 1].str}`)
  }
  expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
    runs.map((_, index) => `1:${index}`).sort()
  )
})

it.each(['matching rows', 'different inset', 'body type', 'intervening item'] as const)(
  'joins the hanging continuation of an independent numbered child heading (%s)',
  (shape) => {
    const title = 'Which calibration choice works most'
    const tail = 'reliably for each group?'
    const runs = [
      item('4 Main Results', 50, 100, 103, 11, 'title'),
      item('4.1', 50, 116, 14, 11, 'title', false),
      item(title, 75, 116, 182, 11, 'title'),
      item(
        tail,
        shape === 'different inset' ? 93 : 75,
        129,
        121,
        shape === 'body type' ? 9 : 11,
        shape === 'body type' ? 'body' : 'title'
      ),
      item(
        'The next paragraph describes how the samples were independently measured.',
        50,
        144,
        350,
        9
      ),
      item('It continues with ordinary text in the body font.', 50, 155, 240, 9)
    ]
    if (shape === 'intervening item')
      runs.splice(3, 0, item('A distinct note in the other column.', 437, 122, 145, 9))

    const result = extract(runs)
    expect(result.units.find((unit) => unit.items.includes('1:0'))?.source).toBe('4 Main Results')
    const child = result.units.find((unit) => unit.items.includes('1:1'))
    expect(child?.source).toBe(shape === 'matching rows' ? `4.1 ${title} ${tail}` : `4.1 ${title}`)
    expect(child?.items).toEqual(shape === 'matching rows' ? ['1:1', '1:2', '1:3'] : ['1:1', '1:2'])
    expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
      runs.map((_, index) => `1:${index}`).sort()
    )
  }
)

// A combined bullet/count run and individually
// justified word runs end in un-, followed by a same-font 0.81em hanging wrap.
const justifiedBullet = (): PdfLayoutTextItem[] => [
  item('• 10%', 320.294, 100, 28.800024, 10.9091, 'body', false),
  item('of', 356, 100, 9, 10.9091, 'body', false),
  item('the', 376, 100, 14, 10.9091, 'body', false),
  item('time:', 399, 100, 25, 10.9091, 'body', false),
  item('Keep', 434, 100, 23, 10.9091, 'body', false),
  item('the', 467, 100, 14, 10.9091, 'body', false),
  item('word', 486, 100, 20, 10.9091, 'body', false),
  item('un-', 511.0068862, 100, 14.5418303),
  item('changed, e.g., my dog is hairy.', 329.094, 113.549, 196.4),
  item('Separate paragraph with its own complete sentence.', 329.094, 139, 220)
]

it('preserves a broken word across the native justified hanging wrap', () => {
  const runs = justifiedBullet(),
    result = extract(runs)
  expect(result.units[0].source).toBe(
    '• 10% of the time: Keep the word un-changed, e.g., my dog is hairy.'
  )
  expect(result.units[1].source).toBe('Separate paragraph with its own complete sentence.')
  expect(result.units[0].items).toHaveLength(9)
  const owned = result.units.flatMap((unit) => unit.items)
  expect(new Set(owned).size).toBe(runs.length)
  expect(owned).toHaveLength(runs.length)
})

// BMJ p4 native105/107..109: 8pt separate dash and 10pt body, 12pt
// hanging indent, 12.13pt baselines. The marker is not the body font size.
it('preserves the entire hyphenated clinical bullet and its ordinary final line', () => {
  const runs = [
    item('–', 56, 100, 4, 8, 'body', false),
    item('Lifestyle risk assessment diet and management in-', 68, 100, 220.38, 10),
    item('cluding smoking status, alcohol consumption and', 68, 112.13, 220.4, 10),
    item('comorbidities.', 68, 124.26, 62.6, 10),
    item('–', 56, 136.39, 4, 8, 'body', false),
    item('A new independent clinical bullet starts here.', 68, 136.39, 220, 10)
  ]
  expect(sources(runs)).toEqual([
    '– Lifestyle risk assessment diet and management in-cluding smoking status, alcohol consumption and comorbidities.',
    '– A new independent clinical bullet starts here.'
  ])
})

it.each([
  {
    name: 'a different native font',
    change: (run: PdfLayoutTextItem) => ({ ...run, fontName: 'caption' })
  },
  {
    name: 'a different type size',
    change: (run: PdfLayoutTextItem) => ({
      ...run,
      height: 12,
      transform: [12, 0, 0, 12, 329.094, 686.451]
    })
  },
  {
    name: 'a neighboring column',
    change: (run: PdfLayoutTextItem) => ({
      ...run,
      transform: [10.9091, 0, 0, 10.9091, 40, 686.451]
    })
  },
  {
    name: 'a wide new indentation',
    change: (run: PdfLayoutTextItem) => ({
      ...run,
      transform: [10.9091, 0, 0, 10.9091, 352, 686.451]
    })
  },
  {
    name: 'a large vertical gap',
    change: (run: PdfLayoutTextItem) => ({
      ...run,
      transform: [10.9091, 0, 0, 10.9091, 329.094, 677]
    })
  },
  {
    name: 'a new styled label',
    change: (run: PdfLayoutTextItem) => ({
      ...run,
      str: 'Independent label begins here.',
      fontName: 'heading'
    })
  },
  {
    name: 'a new numbered list',
    change: (run: PdfLayoutTextItem) => ({ ...run, str: '2. A separate numbered record.' })
  },
  {
    name: 'a true symbolic operand',
    change: (run: PdfLayoutTextItem) => ({ ...run, str: 'x = y + z' })
  }
])('does not join a hanging neighbor with $name', ({ change }) => {
  const runs = justifiedBullet()
  runs[8] = change(runs[8])
  expect(
    sources(runs).some((source) => source.includes('word un-') && source.includes(runs[8].str))
  ).toBe(false)
})

it('native serialization cannot leap over unrelated ink', () => {
  const runs = justifiedBullet()
  runs.splice(8, 0, item('Unrelated caption.', 40, 250, 120))
  expect(sources(runs).some((source) => source.includes('un-changed'))).toBe(false)
})

it('a complete line still ends before an ordinary newly indented paragraph', () => {
  const runs = justifiedBullet()
  runs[7] = { ...runs[7], str: 'word.' }
  expect(sources(runs).some((source) => source.includes('word. changed'))).toBe(false)
})

it('a minus sign is not a broken prose word', () => {
  const runs = [
    item('The expression is evaluated as x −', 320, 100, 200),
    item('y + z', 329, 113.55, 80)
  ]
  expect(sources(runs).some((source) => source.includes('x − y'))).toBe(false)
})

// MobileNet p7: a left prose column and right benchmark share visual baselines.
// The final sentence and separately drawn "We" still form one complete native
// line. The independent table has two descriptors and three numerical values.
const mixedColumn = (sharedNativeRow = false): PdfLayoutTextItem[] => {
  const body = [
    item('A complete preceding body line has this same justified span.', 50, 100, 236, 9.9626),
    item('Systems use unknown training procedures for this task. In', 50, 112, 230, 9.9626),
    item('a face attribute classification task, we demonstrate a syner-', 50, 124, 236, 9.9626),
    item('gistic relationship between compact models and distillation,', 50, 136, 236, 9.9626),
    item(
      'a knowledge transfer technique for deep networks.',
      50,
      148,
      213.867,
      9.9626,
      'body',
      false
    ),
    item('We', 273.334, 148, 13.031, 9.9626),
    item('seek to reduce a large classifier with many learned parameters.', 50, 160, 236, 9.9626)
  ]
  const values = (y: number): PdfLayoutTextItem[] => [
    item('SSD 300', 320.489, y, 32.866, 9.17017, 'body', false),
    item('Inception V2', 369.32, y, 48.134, 9.17017, 'body', false),
    item('22.0%', 424.534, y, 23.687, 9.17017, 'body', false),
    item('3.8', 468.11, y, 11.463, 9.17017, 'body', false),
    item('13.7', 511.751, y, 16.048, 9.17017)
  ]
  if (sharedNativeRow) {
    body[5].hasEOL = false
    body.splice(6, 0, ...values(148))
  }
  return [...body, ...values(125.7896), ...values(136.7937), ...values(147.7978)]
}

it('does not let a complete neighboring prose row become a benchmark table column', () => {
  const runs = mixedColumn(),
    result = extract(runs)
  const paragraph = result.units.find((unit) =>
    unit.source.includes('a face attribute classification')
  )
  expect(paragraph?.source).toContain('syner-gistic relationship')
  expect(paragraph?.source).toContain('deep networks. We seek')
  expect(paragraph?.source).not.toContain('SSD')
  expect(
    result.pages[0].blocks
      .filter((block) => block.tableCell)
      .some((block) => block.source.includes('a face attribute'))
  ).toBe(false)
  expect(
    result.pages[0].blocks.some((block) => block.tableCell && block.source.includes('SSD'))
  ).toBe(true)
  const owned = result.units.flatMap((unit) => unit.items)
  expect(new Set(owned).size).toBe(runs.length)
  expect(owned).toHaveLength(runs.length)
})

it('a true native table keeps its descriptive cells and independent score ownership', () => {
  const runs = [
    item('Description', 50, 100, 60, 10, 'body', false),
    item('First score', 350, 100, 50, 10, 'body', false),
    item('Second score', 430, 100, 65, 10),
    ...[112, 124, 136].flatMap((y, index) => [
      item(`A native model ${index}`, 50, y, 150, 10, 'body', false),
      item('21.8', 365, y, 20, 10, 'body', false),
      item('5.71', 450, y, 20, 10)
    ])
  ]
  const result = extract(runs)
  expect(
    result.pages[0].blocks.filter((block) => block.tableCell && block.source.startsWith('A native'))
  ).toHaveLength(3)
  expect(result.pages[0].blocks.filter((block) => block.source === '21.8')).toHaveLength(3)
  expect(result.pages[0].blocks.filter((block) => block.source === '5.71')).toHaveLength(3)
  expect(result.units.flatMap((unit) => unit.items)).toHaveLength(runs.length)
})

const shortInlineWrap = (): PdfLayoutTextItem[] => [
  item('The independent comparison establishes the complete result for', 52, 100, 348, 10),
  item('the selected objects and all of their unchanged properties', 40, 112, 360, 10),
  item('in M[', 40, 124, 20, 10, 'body', false),
  item('H', 60, 124, 7, 10, 'math', false),
  item('].', 67, 124, 5, 10),
  item('This independent paragraph begins with its own indentation.', 52, 144, 340, 10)
]
it('joins a short native prose ending around a same-baseline styled letter', () => {
  const result = extract(shortInlineWrap())
  expect(result.units[0].source).toContain('unchanged properties in M[H].')
  expect(result.units[1].source).toBe('This independent paragraph begins with its own indentation.')
  expect(result.units.flatMap((unit) => unit.items)).toHaveLength(6)
})
it.each(['gap', 'indent', 'script', 'font-size', 'intervening-source', 'unclosed-literal'])(
  'keeps a short inline neighbor separate with %s',
  (kind) => {
    const runs = shortInlineWrap()
    if (kind === 'gap') for (const run of runs.slice(2, 5)) run.transform[5] -= 14
    if (kind === 'indent') for (const run of runs.slice(2, 5)) run.transform[4] += 20
    if (kind === 'script') runs[3].transform[5] += 4
    if (kind === 'unclosed-literal') runs[4].str = ').'
    if (kind === 'font-size') {
      runs[3].height = 7
      runs[3].transform[0] = runs[3].transform[3] = 7
    }
    if (kind === 'intervening-source')
      runs.splice(2, 0, item('An independent label.', 440, 100, 120, 10))
    expect(sources(runs).some((text) => text.includes('properties in M[H].'))).toBe(false)
  }
)
const changedBodyLeading = (): PdfLayoutTextItem[] => [
  ...Array.from({ length: 8 }, (_, n) =>
    item(
      n === 7
        ? 'The preceding discussion ends as a complete paragraph.'
        : 'The earlier discussion uses a closer ordinary line spacing for the',
      40,
      80 + n * 12,
      350,
      10
    )
  ),
  item('Discussion', 40, 208, 50, 10),
  item('Different possibilities establish a complete range of ordinary', 40, 220, 330, 10),
  item('approaches that can be combined with independently checked', 40, 243, 350, 10),
  item('measurements and their wider implications for the remaining', 40, 266, 335, 10),
  item('systems under consideration during the complete comparison.', 40, 289, 340, 10),
  item('A distinct paragraph begins with its own indentation.', 52, 323, 325, 10)
]
it('learns a repeated local body pitch without absorbing the preceding heading', () => {
  const result = sources(changedBodyLeading())
  expect(result).toContain('Discussion')
  expect(result).toContain(
    'Different possibilities establish a complete range of ordinary approaches that can be combined with independently checked measurements and their wider implications for the remaining systems under consideration during the complete comparison.'
  )
  expect(result.at(-1)).toBe('A distinct paragraph begins with its own indentation.')
})
it('does not infer expanded body leading from an isolated paragraph gap', () => {
  const runs = changedBodyLeading()
  runs[11].transform[5] -= 10
  const result = sources(runs)
  expect(result.some((text) => text.includes('checked measurements'))).toBe(false)
})
const parenthesizedListWrap = (): PdfLayoutTextItem[] => [
  item('(1) For every selected', 40, 100, 100, 10, 'body', false),
  item('X', 144, 100, 6, 10, 'math', false),
  item('the complete neighborhood is connected to', 154, 100, 230, 10),
  item('every vertex in', 56, 114, 65, 10, 'body', false),
  item('D', 125, 114, 7, 10, 'math', false),
  item('.', 132, 114, 3, 10),
  item('(2) Every subsequent component has its own complete property.', 40, 140, 345, 10)
]
it('keeps a short native continuation inside its parenthesized numbered record', () => {
  expect(sources(parenthesizedListWrap())).toEqual([
    '(1) For every selected X the complete neighborhood is connected to every vertex in D.',
    '(2) Every subsequent component has its own complete property.'
  ])
})
it.each(['peer', 'indent', 'gap', 'intervening-source'])(
  'does not join an unproved numbered hanging tail with %s',
  (kind) => {
    const runs = parenthesizedListWrap()
    if (kind === 'peer') runs.pop()
    if (kind === 'indent') for (const run of runs.slice(3, 6)) run.transform[4] += 15
    if (kind === 'gap') for (const run of runs.slice(3, 6)) run.transform[5] -= 15
    if (kind === 'intervening-source')
      runs.splice(3, 0, item('Independent label.', 440, 105, 100, 10))
    expect(sources(runs).some((text) => text.includes('connected to every vertex'))).toBe(false)
  }
)

it.each(['valid', 'body-font', 'mismatched-counter', 'foreign-item'] as const)(
  'ends reference mode only at a complete native root/child appendix: %s',
  (fault) => {
    const headingFont = fault === 'body-font' ? 'body' : 'heading',
      heading = [
        item('A Appendix', 50, 100, 95, 12, headingFont),
        item(
          fault === 'mismatched-counter' ? 'B.1 Ethics Statement' : 'A.1 Ethics Statement',
          50,
          119,
          170,
          12,
          headingFont
        )
      ],
      body = [
        item(
          'Our complete ordinary paragraph establishes the independent study design',
          50,
          148,
          235,
          10
        ),
        item(
          'with repeated measurements and public examples for every reported result',
          50,
          160,
          235,
          10
        ),
        item(
          'and explains the complete procedure without citing another publication.',
          50,
          172,
          235,
          10
        )
      ]
    if (fault === 'foreign-item')
      heading.splice(1, 0, item('Independent right-column text.', 350, 110, 190, 10))
    const pages = [
        {
          page: 1,
          width: 600,
          height: 800,
          rotation: 0,
          items: [
            item('References', 50, 100, 90, 12, 'heading'),
            item(
              '[1] First Author. A complete published study with independent measurements (2020).',
              50,
              130,
              235,
              10
            ),
            item(
              '[2] Second Author. Another complete published study and its results (2021).',
              50,
              150,
              235,
              10
            )
          ]
        },
        {
          page: 2,
          width: 600,
          height: 800,
          rotation: 0,
          items: [...heading, ...body, item('E = mc2', 50, 210, 80, 10)]
        }
      ],
      result = groupPdfTranslationPages({ pages }),
      prose = result.units.find((u) => u.source.startsWith('Our complete ordinary paragraph'))!
    expect(prose.sourceOnly === true).toBe(fault !== 'valid')
    if (fault === 'valid') {
      const title = result.units.find((u) => u.source === 'A Appendix')!
      expect(title.referenceBoundary).toBe(true)
      expect(title.sourceOnly).not.toBe(true)
      expect(result.units.find((u) => u.source === 'E = mc2')!.sourceOnly).toBe(true)
    }
    expect(new Set(result.units.flatMap((u) => u.items)).size).toBe(
      pages.reduce((n, p) => n + p.items.length, 0)
    )
  }
)

it.each(['font', 'column', 'intervening-source'])(
  'does not infer a local body pitch through %s',
  (kind) => {
    const runs = changedBodyLeading()
    if (kind === 'font') runs[11].fontName = 'caption'
    if (kind === 'column') runs[11].transform[4] += 100
    if (kind === 'intervening-source')
      runs.splice(11, 0, item('Independent ink.', 440, 250, 90, 10))
    expect(sources(runs).some((text) => text.includes('checked measurements'))).toBe(false)
  }
)

const prefixedPages = (fault?: string): Parameters<typeof groupPdfTranslationPages>[0] => ({
  pages: Array.from({ length: 7 }, (_, n) => {
    const page = n + 7,
      label = `p-${page}`,
      width = label.length * 5
    const body = item(
      'This complete ordinary paragraph occupies a separate body region.',
      40,
      100,
      350,
      10
    )
    const footer = item(label, (page % 2 ? 290 : 330) - width, 740, width, 10)
    for (const run of [body, footer]) {
      run.fontAscent = 0.8
      run.fontDescent = -0.2
      run.fontVertical = false
    }
    if (fault === 'label' && n === 2) footer.str = 'p-72'
    if (fault === 'rail') footer.transform[5] += n
    if (fault === 'lane') footer.transform[4] += n
    if (fault === 'gutter') body.transform[5] = 70
    if (fault === 'font') footer.fontAscent = 0.7 + n / 100
    return { page, width: 600, height: 800, rotation: 0, items: [body, footer] }
  })
})
it('preserves a right-aligned prefixed pagination rail through changing digit widths', () => {
  const result = groupPdfTranslationPages(prefixedPages())
  const folios = result.units.filter((unit) => /^p-\d+$/u.test(unit.source))
  expect(folios).toHaveLength(7)
  expect(folios.every((unit) => unit.sourceOnly && unit.preserve === 'literal')).toBe(true)
})
it.each(['label', 'rail', 'lane', 'gutter', 'font'])(
  'does not infer prefixed folios from an incomplete %s proof',
  (fault) => {
    const result = groupPdfTranslationPages(prefixedPages(fault))
    expect(
      result.units.some((unit) => /^p-\d+$/u.test(unit.source) && unit.preserve === 'literal')
    ).toBe(false)
  }
)
it('calibrates centered prefixed folios even when a separate margin stamp is drawn afterward', () => {
  const raw = prefixedPages()
  for (const page of raw.pages) {
    const footer = page.items[1]
    footer.transform[4] = (page.page % 2 ? 285 : 315) - footer.width / 2
    const stamp = item('A separate document stamp', 15, 200, 130, 10, 'stamp')
    stamp.fontAscent = 0.8
    stamp.fontDescent = -0.2
    stamp.fontVertical = false
    stamp.transform = [0, 10, -10, 0, 15, 200]
    page.items.push(stamp)
  }
  const folios = groupPdfTranslationPages(raw).units.filter((unit) => /^p-\d+$/u.test(unit.source))
  expect(folios).toHaveLength(raw.pages.length)
  expect(folios.every((unit) => unit.preserve === 'literal')).toBe(true)
})
const paginatedBody = (fault?: string): Parameters<typeof groupPdfTranslationPages>[0] => ({
  pages: Array.from({ length: 8 }, (_, n) => {
    const page = n + 1
    const header = item(page % 2 ? 'An independent overview' : 'A. Researcher', 40, 80, 110, 10)
    const body = item(
      page % 2
        ? 'The complete controlled comparison accounts for all independently recorded sample observations while preserving the'
        : 'remaining independently measured quantities and their original relationships throughout the entire controlled scientific comparison.',
      40,
      page % 2 ? 700 : 114,
      350,
      10
    )
    const footer = item(`p-${page}`, 280, 740, 20, 10)
    for (const run of [header, body, footer]) {
      run.fontAscent = 0.8
      run.fontDescent = -0.2
      run.fontVertical = false
    }
    if (fault === 'pagination') footer.str = 'unrelated'
    if (fault === 'header-position') header.transform[5] -= n
    if (fault === 'gutter' && !(page % 2)) body.transform[5] = 800 - 96
    return { page, width: 600, height: 800, rotation: 0, items: [header, body, footer] }
  })
})
it('keeps a cross-page sentence together through calibrated alternating running headers', () => {
  const result = groupPdfTranslationPages(paginatedBody())
  const paragraphs = result.units.filter((unit) => unit.source.startsWith('The complete'))
  expect(paragraphs).toHaveLength(4)
  expect(paragraphs.every((unit) => unit.source.includes('the remaining independently'))).toBe(true)
  expect(paragraphs.every((unit) => unit.fragments.length === 2)).toBe(true)
  expect(
    result.units
      .filter((unit) => /overview|Researcher/u.test(unit.source))
      .every((unit) => unit.sourceOnly)
  ).toBe(true)
})
it.each(['pagination', 'header-position', 'gutter'])(
  'keeps an unproved page-start label in the flow with %s evidence',
  (fault) => {
    const result = groupPdfTranslationPages(paginatedBody(fault))
    expect(result.units.some((unit) => unit.source.includes('the remaining independently'))).toBe(
      false
    )
  }
)
const shortOutgoingPages = (fault?: string): Parameters<typeof groupPdfTranslationPages>[0] => {
  const raw = paginatedBody()
  for (const page of raw.pages) {
    if (!(page.page % 2)) {
      if (fault === 'incoming-font') page.items[1].fontName = 'other'
      continue
    }
    page.items[1].str = 'This ordinary paragraph introduces the independent measurements and their'
    const context = [
      item(
        'The preceding complete paragraph describes the ordinary controlled comparison',
        40,
        620,
        350,
        10
      ),
      item(
        'and the independently recorded observations with their measured properties',
        40,
        632,
        350,
        10
      ),
      item('in a closed sentence.', 40, 644, 160, 10)
    ]
    for (const run of context) {
      run.fontAscent = 0.8
      run.fontDescent = -0.2
      run.fontVertical = false
      if (fault === 'witnesses') run.width = 160
    }
    page.items.splice(1, 0, ...context)
    if (fault === 'intervening-source')
      page.items.splice(-1, 0, { ...context[2], str: 'Unowned extra text.' })
  }
  return raw
}
it('admits a short final native body row only with complete calibrated page continuation evidence', () => {
  const paragraphs = groupPdfTranslationPages(shortOutgoingPages()).units.filter((unit) =>
    unit.source.startsWith('This ordinary')
  )
  expect(paragraphs).toHaveLength(4)
  expect(paragraphs.every((unit) => unit.source.includes('their remaining independently'))).toBe(
    true
  )
  expect(paragraphs.every((unit) => unit.fragments.length === 2)).toBe(true)
})
it.each(['incoming-font', 'witnesses', 'intervening-source'])(
  'does not promote a short page-ending row with incomplete %s evidence',
  (fault) => {
    expect(
      groupPdfTranslationPages(shortOutgoingPages(fault)).units.some((unit) =>
        unit.source.includes('their remaining independently')
      )
    ).toBe(false)
  }
)

const expectNativeOwnership = (
  result: ReturnType<typeof extract>,
  runs: PdfLayoutTextItem[]
): void => {
  const actual = result.units.flatMap((unit) =>
    unit.items.map((key, index) => [key, unit.originalStrings[index]])
  )
  expect(actual.toSorted((a, b) => a[0].localeCompare(b[0]))).toEqual(
    runs
      .flatMap((run, index) => (run.str.trim() ? [[`1:${index}`, run.str]] : []))
      .toSorted((a, b) => a[0].localeCompare(b[0]))
  )
  expect(new Set(actual.map(([key]) => key)).size).toBe(actual.length)
}

const numericOpening = (): PdfLayoutTextItem[] => [
  item('3', 49, 500, 14.4, 28.8, 'initial', false),
  item('D reconstruction recovers the complete geometry from', 64.8, 486.8, 235, 10),
  item('several measurements obtained by a calibrated monoc-', 64.8, 498.8, 235, 10),
  item('ular camera with a fixed position and known parameters.', 49, 510.8, 251, 10),
  item('Independent paragraph retains its own ordinary sentence.', 59, 542, 241, 10)
]
it.each(['complete', 'foreign-row', 'wrong-margin', 'native-interruption'])(
  'a two-row numeric initial keeps only its proved native word continuation: %s',
  (fault) => {
    const runs = numericOpening()
    if (fault === 'foreign-row') runs[2].fontName = 'foreign'
    if (fault === 'wrong-margin') runs[3].transform[4] = 64.8
    if (fault === 'native-interruption') runs.splice(1, 0, item('Separate note.', 400, 300, 90))
    const result = extract(runs),
      owner = result.units.find((unit) => unit.items.includes('1:0'))!
    if (fault === 'complete' || fault === 'wrong-margin')
      expect(owner.items.includes('1:3')).toBe(fault === 'complete')
    else if (fault === 'foreign-row') expect(owner.items.includes('1:3')).toBe(false)
    else expect(owner.source.startsWith('3D reconstruction')).toBe(false)
    if (fault === 'complete') {
      expect(owner.source).toMatch(/^3D reconstruction/u)
      expect(owner.source).toMatch(/monoc-?ular camera/u)
      expect(owner.source).not.toContain('Independent paragraph')
    }
    expectNativeOwnership(result, runs)
  }
)

it.each([
  'complete',
  'single-word',
  'single-word-off-center',
  'body-sized',
  'foreign-font',
  'off-center',
  'native-interruption',
  'terminal'
])(
  'a modestly enlarged first native title retains only its centered lowercase wrap: %s',
  (fault) => {
    const singleWord = fault.startsWith('single-word')
    const runs = [
      item(
        'General physical behavior in unusually sensitive, highly coupled',
        50,
        62,
        500,
        12,
        'title'
      ),
      singleWord
        ? item('systems', 279, 76, 42, 12, 'title', false)
        : item('systems under controlled interactions', 150, 76, 300, 12, 'title'),
      item('Independent Author', 220, 103, 160, 10, 'author'),
      ...[160, 172, 184, 196].map((y) =>
        item('Ordinary body text establishes the measured native font size.', 50, y, 240, 10)
      )
    ]
    for (const run of runs.slice(0, 2)) run.fontVertical = false
    if (fault === 'body-sized')
      for (const run of runs.slice(0, 2)) {
        run.height = 10
        run.transform[0] = 10
        run.transform[3] = 10
      }
    if (fault === 'foreign-font') runs[1].fontName = 'foreign'
    if (fault.endsWith('off-center')) runs[1].transform[4] += 20
    if (fault === 'terminal') runs[0].str += '.'
    if (fault === 'native-interruption') runs.splice(1, 0, item('Separate note.', 400, 300, 90))
    const result = extract(runs),
      owner = result.units.find((unit) => unit.items.includes('1:0'))!
    expect(owner.items.includes(fault === 'native-interruption' ? '1:2' : '1:1')).toBe(
      fault === 'complete' || fault === 'single-word'
    )
    expect(owner.source).not.toContain('Independent Author')
    expectNativeOwnership(result, runs)
  }
)

it.each(['complete', 'different figure', 'unrelated front matter', 'intervening prose'])(
  'joins a page-spanning figure reference below its matching floating caption: %s',
  (fault) => {
    const left = [
      item('Sample report on controlled conditions', 72, 74, 270, 12, 'header'),
      item('1', 510, 74, 6, 12),
      item('This paragraph describes the measurements used in our analysis.', 95, 736, 421, 12),
      item(
        'The plotted values compare the repeated observations, as shown in',
        72,
        752,
        444,
        12,
        'body',
        false
      )
    ]
    const right = [
      item(
        fault === 'unrelated front matter' ? 'Independent supplement' : left[0].str,
        72,
        74,
        270,
        12,
        'header'
      ),
      item('2', 510, 74, 6, 12),
      item(
        `Figure ${fault === 'different figure' ? '4' : '3'}. Average values for all sampled conditions.`,
        144,
        494,
        338,
        10,
        'caption'
      ),
      item('Fig. 3. The resulting profiles show the same clear difference.', 72, 532, 444, 12),
      item('We repeated our observation for the entire set of samples.', 72, 548, 444, 12),
      item('Several variables remained constant throughout the comparison.', 72, 564, 444, 12),
      item('The profiles remained stable across all measured conditions.', 72, 580, 444, 12)
    ]
    if (fault === 'intervening prose')
      right.splice(2, 0, item('A separate analysis is described here.', 72, 240, 300, 12))
    for (const part of [...left, ...right]) part.fontVertical = false
    const { units } = groupPdfTranslationPages({
      pages: [left, right].map((items, index) => ({
        page: index + 1,
        width: 612,
        height: 800,
        rotation: 0,
        items
      }))
    })
    const owner = units.find(
      (unit) =>
        unit.source.includes('the plotted values') || unit.source.includes('The plotted values')
    )!
    expect(owner.fragments.map((f) => f.page)).toEqual(fault === 'complete' ? [1, 2] : [1])
    expect(owner.source.includes('as shown in Fig. 3.')).toBe(fault === 'complete')
    expect(units.some((unit) => /^Figure \d\. Average values/u.test(unit.source))).toBe(true)
  }
)

it.each([
  'complete',
  'terminal',
  'native-interruption',
  'narrow-caption',
  'unlabelled',
  'few-rows',
  'narrow-tail',
  'foreign-font',
  'distant-caption'
])(
  'a spanning float bounds a short lower-column continuation without skipping native text: %s',
  (fault) => {
    const tail = item(
        'expression follows from the calculation of these quantities',
        320,
        485,
        200,
        10
      ),
      before = item(
        'These detailed observations show the behavior of the complete system',
        50,
        485,
        240,
        10
      ),
      left = [
        before,
        ...Array.from({ length: 20 }, (_, n) =>
          item(
            'under changing experimental conditions and establish a reliable',
            50,
            497 + n * 12,
            240
          )
        ),
        item('parameter independent', 50, 737, 240)
      ],
      runs = [
        item(
          'Figure 1. The complete comparison spans both measured text columns.',
          50,
          420,
          500,
          9
        ),
        ...left,
        tail,
        item('An independent following paragraph establishes the second text lane', 330, 560, 230),
        item('with sufficient native body text and a complete sentence.', 320, 572, 240)
      ]
    if (fault === 'terminal') left.at(-1)!.str += '.'
    if (fault === 'native-interruption')
      runs.splice(runs.indexOf(tail), 0, item('Unaccounted independent body text.', 320, 450, 230))
    if (fault === 'narrow-caption') runs[0].width = 240
    if (fault === 'unlabelled') runs[0].str = runs[0].str.replace('Figure 1.', 'Ordinary context.')
    if (fault === 'few-rows') for (const row of left.slice(0, -2)) row.width = 220
    if (fault === 'narrow-tail') tail.width = 140
    if (fault === 'foreign-font') tail.fontName = 'foreign'
    if (fault === 'distant-caption') runs[0].transform[5] += 40
    const result = extract(runs),
      owner = result.units.find((unit) => unit.items.includes(`1:${runs.indexOf(before)}`))!
    expect(owner.items.includes(`1:${runs.indexOf(tail)}`)).toBe(fault === 'complete')
    expect(owner.source).not.toContain('Figure 1.')
    expectNativeOwnership(result, runs)
  }
)

it.each(['complete', 'ordinary-metrics', 'narrow-glyph', 'missing-metrics', 'oversized-glyph'])(
  'legacy radical letters require extension-font geometry: %s',
  (fault) => {
    const radical = {
        ...item(
          's',
          250,
          100,
          fault === 'narrow-glyph' ? 4 : fault === 'oversized-glyph' ? 18 : 10,
          10,
          'extension',
          false
        ),
        ...(fault === 'missing-metrics'
          ? {}
          : {
              fontAscent: fault === 'ordinary-metrics' ? 0.7 : 0.04,
              fontDescent: fault === 'ordinary-metrics' ? -0.2 : -0.6
            })
      },
      runs = [
        radical,
        item('Independent ordinary body remains separately translatable.', 50, 180, 250)
      ]
    const result = extract(runs),
      owner = result.units.find((unit) => unit.items.includes('1:0'))!
    expect(!!owner.sourceOnly).toBe(fault === 'complete')
    if (fault === 'complete') expect(owner.preserve).toBe('formula')
    expectNativeOwnership(result, runs)
  }
)

it.each([
  'complete',
  'missing-rule',
  'wide-rule',
  'unproved-font',
  'ordinary-index',
  'changed-variable',
  'missing-accent',
  'foreign-ink',
  'merged-prose-run'
])('protects only a closed native indexed normalization fraction: %s', (fault) => {
  const put = (
      text: string,
      x: number,
      y: number,
      width: number,
      font = 10,
      name = 'body'
    ): PdfLayoutTextItem => ({
      ...item(text, x, 800 - y, width, font, name, false),
      fontAscent: 0.7,
      fontDescent: -0.2,
      fontVertical: false
    }),
    runs = [
      put(
        'The surrounding paragraph remains ordinary prose in its own native region.',
        100,
        370,
        350
      ),
      put('a', 210, 332, 6, 10, 'variable'),
      put('ij', 216, 330.5, 7, 7, 'script'),
      put('=', 226, 332, 8),
      put('a', 270, 339, 6, 10, 'variable'),
      put('ij', 276, 337.5, 7, 7, 'script'),
      put('−', 286, 339, 8, 10, 'symbol'),
      put('¯', 297.5, 339, 5),
      put('a', 297, 339, 6, 10, 'variable'),
      put('j', 303, 337.5, 4, 7, 'script'),
      put('max(', 244, 324, 24),
      put('a', 268, 324, 6, 10, 'variable'),
      put('j', 274, 322.5, 4, 7, 'script'),
      put(')', 279, 324, 4),
      put('−', 286, 324, 8, 10, 'symbol'),
      put('min(', 296, 324, 22),
      put('a', 318, 324, 6, 10, 'variable'),
      put('j', 324, 322.5, 4, 7, 'script'),
      put(')', 329, 324, 4),
      put('An independent following paragraph retains its complete original source.', 100, 285, 350)
    ],
    evidence = {
      complete: true as const,
      rules: [{ left: 244, right: 333, baseline: 334.5, halfHeight: 0.2, operators: [1] }],
      fonts: Object.fromEntries(
        ['body', 'variable', 'script', 'symbol'].map((name) => [
          name,
          {
            ascent: 0.7,
            descent: -0.2,
            vertical: false as const,
            nativeMetrics: true as const
          }
        ])
      )
    }
  if (fault === 'missing-rule') evidence.rules = []
  if (fault === 'wide-rule') evidence.rules[0].right += 10
  if (fault === 'unproved-font') delete evidence.fonts.script
  if (fault === 'ordinary-index') runs[5].transform[5] = runs[4].transform[5]
  if (fault === 'changed-variable') runs[8].str = 'b'
  if (fault === 'missing-accent') runs[7].str = '-'
  if (fault === 'foreign-ink') runs.push(put('Independent text', 260, 330, 60))
  if (fault === 'merged-prose-run') runs[4].str += ' ordinary prose'
  runs[0].hasEOL = true
  runs.at(-1)!.hasEOL = true
  const before = structuredClone(runs),
    result = groupPdfTranslationPages({
      pages: [
        {
          page: 1,
          width: 600,
          height: 800,
          rotation: 0,
          items: runs,
          nativeDisplayMathEvidence: evidence
        }
      ]
    }),
    numerator = result.units.find((u) => u.items.includes('1:4'))!,
    left = result.units.find((u) => u.items.includes('1:1'))!
  // Both existing ambiguous owners are protected; source ownership never changes.
  expect(!!numerator.sourceOnly).toBe(fault === 'complete')
  expect(!!left.sourceOnly).toBe(fault === 'complete')
  if (fault === 'complete') {
    expect(numerator.preserve).toBe('formula')
    expect(left.preserve).toBe('formula')
  }
  expectNativeOwnership(result, runs)
  expect(runs).toEqual(before)
})

it.each([
  'complete',
  'finished',
  'no-display',
  'distant-display',
  'different-font',
  'different-edge',
  'native-interruption'
])(
  'a short colon lead remains with its sentence only before a proved native display: %s',
  (fault) => {
    const tail = item('as:', 50, 112, 14, 10),
      runs = [
        item('The complete objective of the following calculation is defined', 50, 100, 240, 10),
        tail,
        item('y = x + z', 85, 135, 180, 10, 'math'),
        item('An independent paragraph remains separate from this equation.', 60, 170, 230, 10)
      ]
    if (fault === 'finished') runs[0].str += '.'
    if (fault === 'no-display') runs[2].str = 'Independent label'
    if (fault === 'distant-display') runs[2].transform[5] -= 40
    if (fault === 'different-font') tail.fontName = 'foreign'
    if (fault === 'different-edge') tail.transform[4] += 20
    if (fault === 'native-interruption')
      runs.splice(1, 0, item('Independent label.', 400, 400, 100))
    const result = extract(runs),
      owner = result.units.find((u) => u.items.includes('1:0'))!
    expect(owner.items.includes(`1:${runs.indexOf(tail)}`)).toBe(fault === 'complete')
    expect(owner.source).not.toContain('y = x')
    expectNativeOwnership(result, runs)
  }
)

it.each([
  'complete',
  'finished',
  'missing-width-witness',
  'different-width',
  'no-display',
  'different-font',
  'native-interruption',
  'earlier-right-body'
])('a short top-column equation lead uses independent native column witnesses: %s', (fault) => {
  const left = Array.from({ length: 42 }, (_, n) =>
      item(
        n === 41
          ? 'The final source is described by an'
          : 'The complete scientific context remains in the first measured column',
        50,
        230 + n * 12,
        240,
        10
      )
    ),
    tail = item('anisotropic fluid with an independent stress tensor', 320, 230, 180, 10),
    runs = [
      ...left,
      tail,
      item('a = b + c', 350, 257, 170, 10, 'math'),
      item('The complete next paragraph establishes the second measured column', 320, 320, 240, 10),
      item(
        'and supplies independent native evidence for its original column width.',
        320,
        332,
        240,
        10
      )
    ]
  if (fault === 'finished') left.at(-1)!.str += '.'
  if (fault === 'missing-width-witness') runs.pop()
  if (fault === 'different-width') runs.at(-1)!.width -= 25
  if (fault === 'no-display') runs[43].str = 'Independent label'
  if (fault === 'different-font') tail.fontName = 'foreign'
  if (fault === 'native-interruption')
    runs.splice(42, 0, item('Unaccounted native text.', 400, 100, 120))
  if (fault === 'earlier-right-body')
    runs.unshift(item('A preceding ordinary body row in this column.', 320, 210, 240, 10))
  const result = extract(runs),
    owner = result.units.find((u) => u.items.includes(`1:${runs.indexOf(left[0])}`))!
  expect(owner.items.includes(`1:${runs.indexOf(tail)}`)).toBe(fault === 'complete')
  expect(owner.source).not.toContain('a = b')
  expectNativeOwnership(result, runs)
})

it.each(['complete', 'wrong-row', 'wrong-edge', 'wrong-size', 'native-interruption'])(
  'a raised radical uses only its adjacent native increment operand: %s',
  (fault) => {
    const radical = {
        ...item('√', 230, 103.4, 8.3, 10, 'operator', false),
        fontAscent: 0.75,
        fontDescent: -0.194
      },
      delta = item('∆', 238.301, 112, 8.3, 10, 'variable', false),
      runs = [
        item('The surrounding fluid has a well defined angular velocity.', 50, 100, 230, 10),
        item('The values are bounded by q = (a +', 50, 112, 175, 10, 'body', false),
        radical,
        delta,
        item('), which determines the complete result.', 250, 112, 180, 10)
      ]
    if (fault === 'wrong-row') delta.transform[5] -= 25
    if (fault === 'wrong-edge') delta.transform[4] += 20
    if (fault === 'wrong-size') delta.transform[3] = delta.transform[0] = delta.height = 7
    if (fault === 'native-interruption') runs.splice(3, 0, item('Unrelated text.', 400, 300, 100))
    const result = extract(runs)
    expect(result.units.some((u) => u.source.includes('√∆'))).toBe(fault === 'complete')
    expectNativeOwnership(result, runs)
  }
)

it.each([
  'complete',
  'no-sequence',
  'wrong-column',
  'unproved-font',
  'foreign-ink',
  'body-word',
  'detached-index',
  'unruled-stack',
  'lowered-number'
])('protects complete right-aligned Roman display owners with native index proof: %s', (fault) => {
  const put = (
      str: string,
      x: number,
      y: number,
      width: number,
      height = 10,
      name = 'body'
    ): PdfLayoutTextItem => ({
      ...item(str, x, 800 - y, width, height, name, false),
      fontAscent: 0.7,
      fontDescent: -0.2,
      fontVertical: false
    }),
    runs = [
      put('The preceding explanation is ordinary prose and remains translatable.', 50, 700, 350)
    ]
  for (let n = 1; n <= 3; n++) {
    const y = 650 - n * 50
    runs.push(
      put('L', 180, y, 6),
      put(
        n === 3 ? 'phase' : 'j',
        fault === 'detached-index' && n === 3 ? 220 : 186,
        y - 1.5,
        n === 3 ? 15 : 4,
        fault === 'body-word' && n === 3 ? 10 : 7,
        'script'
      ),
      put('=', 210, y, 8),
      put('log', 225, y, 15),
      put('x', 245, y, 6)
    )
    if (fault === 'unruled-stack' && n === 3) runs.at(-1)!.transform[5] += 7
    const label = put(
      fault === 'lowered-number'
        ? `(${n})`
        : fault === 'no-sequence' && n === 2
          ? '(vii)'
          : `(${'i'.repeat(n)})`,
      540 - (8 + n * 4) + (fault === 'wrong-column' && n === 2 ? 20 : 0),
      fault === 'lowered-number' ? y - 12 : y,
      8 + n * 4
    )
    label.hasEOL = true
    runs.push(label)
  }
  if (fault === 'foreign-ink') runs.push(put('External ordinary prose', 200, 500, 100))
  runs.push(
    put('The following explanation retains its original independent ownership.', 50, 440, 350)
  )
  const evidence = {
    complete: true as const,
    rules: [],
    fonts: Object.fromEntries(
      ['body', 'script'].map((name) => [
        name,
        { ascent: 0.7, descent: -0.2, vertical: false as const, nativeMetrics: true as const }
      ])
    )
  }
  if (fault === 'unproved-font') delete evidence.fonts.script
  const result = groupPdfTranslationPages({
      pages: [
        {
          page: 1,
          width: 600,
          height: 800,
          rotation: 0,
          items: runs,
          nativeDisplayMathEvidence: evidence
        }
      ]
    }),
    target = result.units.find((u) => u.originalStrings.includes('phase'))!
  expect(target).toBeDefined()
  expect(target.sourceOnly === true).toBe(['complete', 'lowered-number'].includes(fault))
  if (['complete', 'lowered-number'].includes(fault)) expect(target.preserve).toBe('formula')
  expect(result.units.find((u) => u.source.startsWith('The following'))?.sourceOnly).not.toBe(true)
  expectNativeOwnership(result, runs)
})

const sameRowDefinition = (): PdfLayoutTextItem[] =>
  [
    item('where', 50, 300, 26, 10, 'body', false),
    item('α', 81, 300, 5, 10, 'math', false),
    item(',', 86, 300, 3, 10, 'body', false),
    item('x', 94, 300, 5, 10, 'math', false),
    item('r', 99, 301.5, 4, 7, 'script', false),
    item(',', 103.5, 300, 3, 10, 'body', false),
    item('x', 111, 300, 5, 10, 'math', false),
    item('1', 116, 301.5, 4, 7, 'script', false),
    item('and', 125, 300, 16, 10, 'body', false),
    item('x', 146, 300, 5, 10, 'math', false),
    item('2', 151, 301.5, 4, 7, 'script', false),
    item('are the constant parameters used', 160, 300, 135, 10),
    item('The next native body row establishes this same column.', 50, 312, 245, 10)
  ].map((run) => ({
    ...run,
    fontAscent: run.fontName === 'body' ? 0.891 : 0.694,
    fontDescent: run.fontName === 'body' ? -0.216 : -0.194
  }))
it('keeps a native definition and its inline lowered variables in one complete paragraph', () => {
  const runs = sameRowDefinition(),
    result = extract(runs)
  expect(result.units).toHaveLength(1)
  expect(result.units[0].source).toContain('where α, xr, x1 and x2 are the constant parameters')
  expect(result.units[0].sourceOnly).not.toBe(true)
  expect(result.units.flatMap((u) => u.items)).toHaveLength(runs.length)
  expect(new Set(result.units.flatMap((u) => u.items)).size).toBe(runs.length)
})
it.each(['separate-column', 'relation'])(
  'does not use an incomplete native definition row with %s',
  (change) => {
    const runs = sameRowDefinition()
    if (change === 'separate-column') runs[11] = item(runs[11].str, 330, 300, 200, 10)
    if (change === 'relation') runs[8].str = '='
    expect(sources(runs)).not.toHaveLength(1)
  }
)

const indexedDefinition = (): PdfLayoutTextItem[] =>
  [
    item('A short independent sentence finishes here.', 49, 465, 166, 9),
    item('where', 49, 490, 22, 9, 'body', false),
    item('Q', 74.4, 490, 5.9, 9, 'math', false),
    item('AB', 80.3, 491, 12.5, 6, 'script', false),
    item('(', 94, 490, 3.6, 9, 'operator', false),
    item('m', 97.6, 490, 4.9, 9, 'math', false),
    item('|', 102.5, 490, 2.6, 9, 'separator', false),
    item('v', 105.1, 490, 4.5, 9, 'math', false),
    item('j', 109.6, 491, 2.7, 6, 'script', false),
    item(')', 112.7, 490, 3.6, 9, 'operator', false),
    item('is the adjusted response likelihood for a chosen', 119.7, 490, 180.3, 9),
    item('sample sequence and the previously measured baseline value.', 49, 501, 251, 9),
    item('A separate complete statement begins below.', 49, 530, 170, 9)
  ].map((run) => ({
    ...run,
    fontVertical: false,
    fontFamily: run.fontName === 'body' ? 'serif' : 'sans-serif',
    fontAscent: run.fontName === 'body' ? 0.688 : 0.714,
    fontDescent: -0.218
  }))

it('keeps an indexed function definition in one body area with all native runs', () => {
  const items = indexedDefinition(),
    { units } = extract(items),
    owner = units.find((unit) => unit.items.includes('1:1'))!
  expect(owner.source).toBe(
    'where QAB (m|vj) is the adjusted response likelihood for a chosen sample sequence and the previously measured baseline value.'
  )
  expect(owner.sourceOnly).toBeUndefined()
  expect(owner.fragments).toHaveLength(1)
  expect(owner.items).toEqual(items.slice(1, -1).map((_, index) => `1:${index + 1}`))
  expect(units.flatMap((unit) => unit.items)).toEqual(items.map((_, index) => `1:${index}`))
})

it.each(['column-gap', 'detached-index', 'spaced-label', 'relation'])(
  'keeps an unproven indexed function definition separate with %s',
  (change) => {
    const items = indexedDefinition()
    if (change === 'column-gap') items[10].transform[4] += 12
    if (change === 'detached-index') items[8].transform[4] += 2
    if (change === 'spaced-label') items[3].str = 'A B'
    if (change === 'relation') items[6].str = '='
    const { units } = extract(items),
      owner = units.find((unit) => unit.items.includes('1:1'))!
    expect(owner.items).not.toContain('1:10')
  }
)

const sectionBeforeRunIn = (): PdfLayoutTextItem[] => [
  ...[
    'These ordinary measurements establish the repeated native body leading.',
    'An independent source sentence supplies the same ordinary body type.',
    'The next complete observation preserves that native spacing and type.',
    'The final complete observation ends before the separate native section.'
  ].map((text, index) => item(text, 50, 190 + index * 20, 250, 10)),
  item('3.2. Quality Study', 50, 300, 100, 11, 'heading'),
  item('Visual quality.', 50, 317, 65, 10, 'heading', false),
  item('We compare the measured results using', 122, 317, 178, 10),
  item('the same complete native paragraph across its next ordinary row.', 50, 329, 250, 10),
  item('Another independent paragraph begins after separate spacing.', 50, 355, 250, 10)
]
it('separates a numbered section from its smaller run-in body label', () => {
  const runs = sectionBeforeRunIn(),
    result = extract(runs),
    heading = result.units.find((unit) => unit.items.includes('1:4'))!,
    body = result.units.find((unit) => unit.items.includes('1:5'))!
  expect(heading.source).toBe('3.2. Quality Study')
  expect(body.source).toContain('Visual quality. We compare')
  expect(body.source).toContain('next ordinary row.')
  expect(body.items).not.toContain('1:4')
  expect(heading.sourceOnly).not.toBe(true)
  expect(body.sourceOnly).not.toBe(true)
  expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
    runs.map((_, index) => `1:${index}`).sort()
  )
})
it('keeps a wrapped numbered title in one heading before its run-in body', () => {
  const runs = sectionBeforeRunIn()
  runs[4].str = '3.2. Quality Study of Native Mea-'
  runs[4].width = 220
  runs.splice(5, 0, item('surements', 73, 312, 60, 11, 'heading'))
  for (const run of runs.slice(6)) run.transform[5] -= 12
  const result = extract(runs),
    heading = result.units.find((unit) => unit.items.includes('1:4'))!
  // A title continuation has no same-row return to body type.
  expect(heading.items).toContain('1:5')
  expect(heading.items).not.toContain('1:6')
  expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
    runs.map((_, index) => `1:${index}`).sort()
  )
})
it.each(['same-size', 'no-body-return', 'foreign-font', 'intervening-source'])(
  'does not impose a section boundary without complete native role evidence: %s',
  (change) => {
    const runs = sectionBeforeRunIn()
    if (change === 'same-size') {
      runs[4].height = 10
      runs[4].transform[0] = runs[4].transform[3] = 10
    }
    if (change === 'no-body-return') runs[6].fontName = 'heading'
    if (change === 'foreign-font') runs[5].fontName = 'other'
    if (change === 'intervening-source') runs.splice(5, 0, item('Foreign source', 400, 309, 80, 10))
    const result = extract(runs),
      heading = result.units.find((unit) => unit.items.includes('1:4'))!
    expect(heading.items).toContain(change === 'intervening-source' ? '1:6' : '1:5')
    if (change === 'intervening-source') expect(heading.items).not.toContain('1:5')
    expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
      runs.map((_, index) => `1:${index}`).sort()
    )
  }
)
it('keeps an independently aligned run-in paragraph in its neighboring column', () => {
  const runs = sectionBeforeRunIn()
  for (const index of [5, 6, 7]) runs[index].transform[4] += 280
  const result = extract(runs),
    heading = result.units.find((unit) => unit.items.includes('1:4'))!
  expect(heading.items).toEqual(['1:4'])
  expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
    runs.map((_, index) => `1:${index}`).sort()
  )
})

const runInWord = (): PdfLayoutTextItem[] => [
  item('2.3.1.', 50, 300, 20, 10, 'heading', false),
  item('Safe operations.', 80, 300, 128, 10, 'heading', false),
  item('The ordinary un-', 212, 300, 88, 10, 'body'),
  item('changed words continue with the same complete body paragraph', 50, 312, 250, 10),
  item('and the third native row also belongs to this body sentence.', 50, 324, 250, 10),
  item('An independent paragraph starts with separate native spacing.', 50, 350, 250, 10)
]
it('keeps a body word wrapped after a mixed-style run-in heading and continues the whole paragraph', () => {
  const runs = runInWord(),
    result = extract(runs)
  expect(result.units[0].source).toContain('un-changed words')
  expect(result.units[0].source).toContain('third native row')
  expect(result.units[1].source).toBe(runs[5].str)
  expect(result.units.flatMap((u) => u.items)).toHaveLength(runs.length)
})
it('joins a one-word run-in heading to body text with an inline styled phrase', () => {
  const runs = runInWord()
  runs[1].str = 'Methods.'
  runs.splice(
    3,
    1,
    item('changed words continue with', 50, 312, 115, 10, 'body', false),
    item('Control Group', 169, 312, 55, 10, 'emphasis', false),
    item('in the same text.', 228, 312, 72, 10)
  )
  const result = extract(runs)
  const owner = result.units.find((u) => u.items.includes('1:0'))
  expect(owner?.source).toContain('un-changed words continue with Control Group')
  expect(owner?.items).toContain('1:5')
  expect(result.units.at(-1)?.source).toBe(runs.at(-1)?.str)
})

it.each(['foreign-font', 'other-column', 'intervening-source'])(
  'retains a numbered heading boundary without a proved body word: %s',
  (change) => {
    const runs = runInWord()
    if (change === 'foreign-font') runs[3].fontName = 'other'
    if (change === 'other-column') runs[3].transform[4] = 330
    if (change === 'intervening-source') runs.splice(3, 0, item('foreign', 400, 305, 30, 10))
    expect(extract(runs).units.find((u) => u.items.includes('1:0'))?.items).not.toContain(
      '1:' + (change === 'intervening-source' ? 4 : 3)
    )
  }
)
const centeredSection = (): PdfLayoutTextItem[] => [
  item('SUPPLEMENTAL INFORMATION FOR THE MEASURED RADIAL', 60, 80, 480, 9, 'heading'),
  item('PROFILE', 270, 90.5, 60, 9, 'heading'),
  item(
    'This separate ordinary paragraph establishes the native body font and size for this page.',
    50,
    125,
    500,
    10
  ),
  item(
    'Its next native row remains inside the ordinary paragraph and outside the centered heading.',
    50,
    137,
    500,
    10
  )
]
it('keeps the narrow centered last word of a complete small-cap section heading', () => {
  const result = extract(centeredSection())
  expect(result.units[0].source).toBe('SUPPLEMENTAL INFORMATION FOR THE MEASURED RADIAL PROFILE')
  expect(result.units[1].source).toContain('This separate ordinary paragraph')
})
it.each(['miscentered', 'font-change', 'body-font', 'foreign-source'])(
  'does not extend a centered section heading with %s',
  (change) => {
    const runs = centeredSection()
    if (change === 'miscentered') runs[1].transform[4] += 20
    if (change === 'font-change') runs[1].fontName = 'other'
    if (change === 'body-font')
      for (const run of runs.slice(0, 2)) {
        run.height = 10
        run.transform[0] = run.transform[3] = 10
      }
    if (change === 'foreign-source') runs.splice(1, 0, item('separate note', 50, 85, 70, 9))
    expect(sources(runs)).not.toContain('SUPPLEMENTAL INFORMATION FOR THE MEASURED RADIAL PROFILE')
  }
)
const wrappedAuthor = (): PdfLayoutTextItem[] => [
  item(
    'We use a complete ordinary description introduced by Harper',
    50,
    300,
    240,
    10,
    'body',
    false
  ),
  item('et', 293, 300, 7, 10, 'emphasis'),
  item('al.', 50, 312, 10, 10, 'emphasis', false),
  item('[', 62, 312, 3, 10, 'body', false),
  item('4', 65, 312, 5, 10, 'body', false),
  item(']. In this setting the model is periodically updated', 70, 312, 230, 10),
  item('using another complete native body row in this same column.', 50, 324, 250, 10)
]
it('keeps a styled author abbreviation wrapped before a complete numeric citation in prose', () => {
  const runs = wrappedAuthor(),
    result = extract(runs)
  expect(result.units).toHaveLength(1)
  expect(result.units[0].source).toContain('Harper et al. [4]. In this setting')
  expect(result.units[0].sourceOnly).not.toBe(true)
  expect(new Set(result.units.flatMap((u) => u.items)).size).toBe(runs.length)
})
it.each(['open-citation', 'wrong-font', 'other-column', 'foreign-item', 'array-context'])(
  'does not exempt an unproved wrapped citation prefix: %s',
  (change) => {
    const runs = wrappedAuthor()
    if (change === 'open-citation')
      runs[5].str = 'In this setting the model is periodically updated'
    if (change === 'wrong-font') runs[2].fontName = 'other'
    if (change === 'other-column') runs[2].transform[4] = 330
    if (change === 'foreign-item') runs.splice(2, 0, item('z = 2', 400, 306, 50, 10))
    if (change === 'array-context') runs[0].str = 'A = B + C − Harper'
    expect(extract(runs).units).not.toHaveLength(1)
  }
)

it.each(['raised-primes', 'overlapping-spacing-hat', 'native-eol-mid-row'])(
  'retains complete definition ownership with native script syntax: %s',
  (syntax) => {
    const runs = sameRowDefinition()
    if (syntax === 'raised-primes')
      for (const at of [4, 7, 10]) {
        runs[at].str = '′'
        runs[at].transform[5] = 503.6
      }
    if (syntax === 'overlapping-spacing-hat')
      runs.splice(9, 0, item('ˆ', 146.9, 300, 4.5, 10, 'accent', false))
    if (syntax === 'native-eol-mid-row') runs[10].hasEOL = true
    const result = extract(runs)
    expect(result.units).toHaveLength(1)
    expect(result.units[0].source).toContain('are the constant parameters')
    expect(result.units[0].source).toContain('next native body row')
    expect(result.units.flatMap((u) => u.items)).toHaveLength(runs.length)
    expect(new Set(result.units.flatMap((u) => u.items)).size).toBe(runs.length)
  }
)

const spacedExample = (abbreviation = 'e.g'): PdfLayoutTextItem[] => [
  item('Our complete ordinary comparison establishes the result for', 50, 100, 236, 10),
  item('the independently observed systems and their shared behavior', 50, 112, 236, 10),
  item('under the same controlled conditions, which also shows that', 50, 124, 236, 10),
  item('the selected data can improve the current model-based', 50, 136, 236, 10),
  item('method (', 50, 148, 37.44, 10, 'body', false),
  item(abbreviation, 87.44, 148, 11.75, 10, 'italic', false),
  item('., SampleModel).', 99.19, 148, 60, 10, 'body', false),
  { ...item(' ', 159.19, 148, 8.4, 10, 'body', false), height: 0 },
  item('We also show several independent', 167.59, 148, 118.41, 10),
  item('observations with consistent native body geometry and', 50, 160, 236, 10),
  item('complete ordinary conclusions for the controlled study.', 50, 172, 236, 10),
  item('An independent neighboring column keeps its own text.', 350, 148, 210, 10)
]
it.each(['e.g', 'i.e'])(
  'keeps a styled %s example with its body across a native sentence space',
  (abbreviation) => {
    const runs = spacedExample(abbreviation),
      result = extract(runs),
      owner = result.units.find((unit) => unit.items.includes('1:0'))!
    expect(owner.source).toContain(
      `model-based method (${abbreviation}., SampleModel). We also show`
    )
    expect(owner.source).toContain('complete ordinary conclusions')
    expect(owner.sourceOnly).not.toBe(true)
    expect(owner.items).not.toContain('1:11')
    expect(owner.items).toHaveLength(10)
    expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
      runs.flatMap((run, index) => (run.str.trim() ? [`1:${index}`] : [])).sort()
    )
  }
)
it.each([
  'missing-space',
  'space-width',
  'space-baseline',
  'space-font',
  'foreign-glyph',
  'unclosed',
  'operator',
  'line-end'
])('does not treat an unproved %s after a styled example as ordinary body continuity', (fault) => {
  const runs = spacedExample()
  if (fault === 'missing-space') runs[7].str = ''
  if (fault === 'space-width') runs[7].width = 4.2
  if (fault === 'space-baseline') runs[7].transform[5] += 2
  if (fault === 'space-font') runs[7].fontName = 'italic'
  if (fault === 'foreign-glyph') runs[7] = { ...runs[7], str: 'X', height: 10 }
  if (fault === 'unclosed') runs[6].str = '., SampleModel.'
  if (fault === 'operator') runs[4].str = 'sin ('
  if (fault === 'line-end') runs[7].hasEOL = true
  const result = extract(runs),
    owner = result.units.find((unit) => unit.items.includes('1:0'))!
  expect(owner.items.includes('1:4') && owner.items.includes('1:10')).toBe(false)
  expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
    runs.flatMap((run, index) => (run.str.trim() ? [`1:${index}`] : [])).sort()
  )
})

it.each(['column', 'page', 'intervening heading'] as const)(
  'keeps native numbered run-in prose together across %s only when the body rows are adjacent',
  (boundary) => {
    const column = boundary === 'column',
      blocked = boundary === 'intervening heading',
      outgoingX = column ? 50 : 310,
      incomingX = column ? 310 : 50,
      horizontal: typeof item = (...args) => ({ ...item(...args), fontVertical: false }),
      outgoing = [
        horizontal('1) Calibration:', outgoingX + 10, 708, 65, 9, 'label', false),
        horizontal('The sensor record establishes a baseline', outgoingX + 79, 708, 161, 10),
        horizontal(
          'for the new field observations under comparable conditions.',
          outgoingX,
          720,
          240,
          10
        ),
        horizontal(
          'Every recorded signal is first grouped by its original mode',
          outgoingX,
          732,
          240,
          10
        ),
        horizontal('and then assigned to the corresponding experimental', outgoingX, 744, 240, 10)
      ],
      incoming = [
        ...(column ? [] : [horizontal('2', 50, 25, 4, 7, 'folio')]),
        ...(blocked
          ? [horizontal('An intervening native heading', 50, 50, 170, 9, 'heading')]
          : []),
        horizontal(
          'group. We independently record all observations and carry',
          incomingX,
          66,
          240,
          10
        ),
        horizontal('out the final comparisons after checking every source.', incomingX, 78, 230, 10)
      ],
      pages = (column ? [[...outgoing, ...incoming]] : [outgoing, incoming]).map((items, i) => ({
        page: i + 1,
        width: 600,
        height: 800,
        rotation: 0,
        items
      })),
      result = groupPdfTranslationPages({ pages, pageCount: pages.length }),
      owner = result.units.find((unit) => unit.items.includes('1:0'))
    expect(owner?.fragments.map((fragment) => fragment.page)).toEqual(
      blocked ? [1] : [1, column ? 1 : 2]
    )
    expect(owner?.source.includes('experimental group.')).toBe(!blocked)
    expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
      pages.flatMap(({ page, items }) => items.map((_, i) => `${page}:${i}`)).sort()
    )
  }
)

it('keeps native prose outside a neighboring measured table', () => {
  const runs = [
    item('the separate observations all support the final analysis.', 70.87, 108.92, 220.18, 10.91),
    item('The field team collected the relevant comparison data', 70.35, 122.47, 218.78, 10.91),
    item(
      'under equivalent operating conditions before proceeding to',
      70.87,
      136.02,
      218.27,
      10.91
    ),
    item('inspect the final set of measurements.', 70.87, 149.57, 174.73, 10.91),
    item('Calibration data', 382.35, 107.17, 65.86, 8.97, 'table'),
    item('First trial', 307.22, 122.61, 42.09, 8.97, 'table', false),
    item('59.0', 446.36, 122.61, 15.69, 8.97, 'table', false),
    item('1.8', 478.5, 122.61, 11.21, 8.97, 'table'),
    item('44.2', 446.36, 152.5, 15.69, 8.97, 'table', false),
    item('23.1', 474.02, 152.5, 15.69, 8.97, 'table', false)
  ]
  const blocks = extract(runs).pages[0].blocks
  expect(blocks.find((block) => block.items.includes('1:0'))?.tableCell).toBeUndefined()
  expect(blocks.find((block) => block.items.includes('1:6'))?.tableCell).toBe(true)
})

it.each(['caption', 'indented', 'ordinary prose'] as const)(
  'joins a native inline-parameter tail only with an aligned caption: %s',
  (context) => {
    const x = context === 'indented' ? 52 : 42
    const runs = [
      item(
        context === 'ordinary prose' ? 'Context:' : 'Fig. 1.',
        42,
        676,
        25,
        8.52,
        'label',
        false
      ),
      item('Comparison of the calibrated response across fixed trials and', 69.5, 676, 222, 8.97),
      item('the calibrated readings across all categories,', 42, 687, 243, 8.97),
      item('for', x, 698, 11.42, 8.97, 'body', false),
      item('pr', x + 13.78, 698, 8.37, 8.97, 'variable', false),
      item('=', x + 24.86, 698, 7.27, 9.34, 'math', false),
      item('12 and different choices of marker', x + 34.72, 698, 124.5, 8.97, 'body', false),
      item('z', x + 161.57, 698, 4.99, 8.97, 'variable', false),
      item('.', x + 166.67, 698, 2.24, 8.97),
      item('The next ordinary paragraph starts separately.', 54, 721, 190, 8.97)
    ]
    const layout = extract(runs)
    const owner = (index: number): (typeof layout.units)[number] | undefined =>
      layout.units.find((unit) => unit.items.includes(`1:${index}`))
    expect(owner(0)).toBeDefined()
    expect(owner(0) === owner(3)).toBe(context === 'caption')
    expect(owner(0) === owner(6)).toBe(context === 'caption')
    expect(owner(0)).not.toBe(owner(9))
    expect(layout.units.flatMap((unit) => unit.items).sort()).toEqual(
      runs.map((_, index) => `1:${index}`).sort()
    )
  }
)

it.each([false, true])('requires open native body wraps beside a table (closed: %s)', (closed) => {
  const items = [
    item('Count', 266, 478, 28, 8.355),
    item('0', 122, 492, 4, 8.355, 'body', false),
    item('14', 169, 492, 8, 8.355, 'body', false),
    item('43 276', 191, 492, 21, 8.355, 'body', false),
    item('8', 173, 513, 4, 8.355, 'body', false),
    item('2 003', 195, 513, 17, 8.355, 'body', false),
    item('Finally, the field team also considered the preliminary', 378, 442, 182, 9),
    item('measurements collected under the same operating conditions', 318, 453, 240, 9),
    item(
      'before the last inspection, including the full laboratory logs' + (closed ? '.' : ''),
      318,
      464,
      240,
      9
    ),
    item('and independent inspection reports.', 318, 475, 122, 9),
    item('These observations cover', 328, 490, 84, 9, 'body', false),
    item('several operating modes', 476, 490, 82, 9)
  ]
  const result = groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 800, rotation: 0, items }]
  })
  const tail = result.units.find((unit) => unit.items.includes('1:9'))!
  expect(tail.items.includes('1:8')).toBe(!closed)
  expect(result.pages[0].blocks.find((block) => block.items.includes('1:9'))?.tableCell).toBe(
    closed ? true : undefined
  )
  expect(result.pages[0].blocks.find((block) => block.items.includes('1:2'))?.tableCell).toBe(true)
})

it.each(['complete', 'finished-sentence', 'ordinary-font', 'displaced-code', 'open-parenthesis'])(
  'keeps a wrapped prose row with its own parenthesized identifier only when closed: %s',
  (variant) => {
    const runs = [
      item(
        variant === 'finished-sentence'
          ? 'The comparison uses a baseline with a separate reconstruction.'
          : 'The comparison uses a baseline with a separate reconstruction',
        72,
        200,
        257,
        10
      ),
      item('and enhancement (', 72, 212, 80, 10, 'body', false),
      {
        ...item('Q7', 152, variant === 'displaced-code' ? 209 : 212, 11, 10, 'identifier', false),
        fontFamily: variant === 'ordinary-font' ? 'serif' : 'monospace'
      },
      item(
        variant === 'open-parenthesis'
          ? ' supports a comparison across the observed conditions'
          : ') supports a comparison across the observed conditions',
        163,
        212,
        166,
        10
      ),
      item('for each independent sample.', 72, 224, 150, 10)
    ].map((run) => ({ ...run, fontVertical: false }))
    const result = extract(runs)
    const identifier = result.units.find((unit) => unit.items.includes('1:2'))!
    if (variant === 'complete') {
      expect(identifier.sourceOnly).not.toBe(true)
      expect(identifier.source).toContain('and enhancement (Q7) supports a comparison')
      expect(identifier.items).toEqual(expect.arrayContaining(['1:1', '1:2', '1:3']))
    } else {
      expect(identifier.items).not.toContain('1:3')
    }
    expectNativeOwnership(result, runs)
  }
)

it.each(['siblings', 'no EOL', 'same size', 'not sequential'])(
  'keeps repeated small-cap section headings apart from the body (%s)',
  (proof) => {
    const section = (number: string, y: number, ending: string): PdfLayoutTextItem[] => [
      item(number, 108.25, y, 13, 10, 'body', false),
      item('C', 132, y, 6, 10, 'body', false),
      item(ending, 138.5, y, 24, proof === 'same size' ? 10 : 8, 'body', false),
      item('S', 168, y, 6, 10, 'body', false),
      item('ETUP', 174.5, y, 19, proof === 'same size' ? 10 : 8, 'body', false),
      { ...item('', 108, y + 11.5, 0, 10, 'body', proof !== 'no EOL'), height: 0 },
      item(
        'This ordinary paragraph describes the completed technical setup.',
        108,
        y + 11.5,
        395,
        10
      ),
      item('The continuation of this ordinary paragraph ends here.', 108, y + 22.5, 390, 10)
    ]
    const runs = [
      item('A complete line introduces background on the measurement process.', 108, 65, 396, 10),
      item('The next sentence describes the operating conditions.', 108, 76, 390, 10),
      ...section('2.1', 105.5, 'URRENT'),
      ...section(proof === 'not sequential' ? '2.3' : '2.2', 157.5, 'ONTROL')
    ]
    const { units } = extract(runs)
    for (const [heading, body] of [
      [3, 8],
      [11, 16]
    ]) {
      const owner = units.find((unit) => unit.items.includes(`1:${heading}`))
      expect(owner?.items.includes(`1:${body}`)).toBe(proof !== 'siblings')
    }
    if (proof === 'siblings') {
      expect(units[1].source).toBe('2.1 CURRENT SETUP')
      expect(units[3].source).toBe('2.2 CONTROL SETUP')
    }
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      runs.flatMap((run, index) => (run.str ? [`1:${index}`] : [])).sort()
    )
  }
)

it.each(['wrapped', 'body face', 'missing word', 'different indent'])(
  'joins the final hyphenated word of a bundled section heading (%s)',
  (proof) => {
    const runs = [
      item('An earlier paragraph explains the original calibration setup.', 310, 96, 236, 10),
      item('Its last sentence closes the preceding topic.', 310, 108, 236, 10),
      item('2. Comparison of the public docu-', 310, 130, 236, 12, 'title'),
      item('ments', proof === 'different indent' ? 340 : 328, 144, 32, 12, 'title'),
      item(
        'The following paragraph provides context for the newly introduced topic.',
        322,
        164,
        224,
        proof === 'body face' ? 12 : 10,
        proof === 'body face' ? 'title' : 'body'
      ),
      item(
        proof === 'missing word'
          ? 'The samples are evaluated for consistency and performance.'
          : 'The documents are evaluated for consistency and performance.',
        310,
        176,
        236,
        10
      )
    ].map((run) => ({ ...run, fontAscent: 0.75, fontDescent: -0.25, fontVertical: false }))
    const result = extract(runs)
    expect(result.units.find((unit) => unit.items.includes('1:2'))).toMatchObject(
      proof === 'wrapped'
        ? { source: '2. Comparison of the public documents', items: ['1:2', '1:3'] }
        : { source: '2. Comparison of the public docu-', items: ['1:2'] }
    )
    expectNativeOwnership(result, runs)
  }
)

it.each(['wrapped', 'other marker', 'different edge', 'large gap'])(
  'keeps each complete bundled bullet with its hanging continuation (%s)',
  (proof) => {
    const runs = [
      item('An early paragraph records lessons about content identification.', 50, 80, 236, 10),
      item('Its last sentence closes the preceding topic.', 50, 92, 236, 10),
      item('• The deferred process requires recording all the con-', 61, 115, 225, 10),
      item('tent.', 70, 127, 18, 10),
      item(
        (proof === 'other marker' ? '– ' : '• ') +
          'The recurring process also relies on locating each of',
        61,
        proof === 'large gap' ? 153 : 148,
        proof === 'different edge' ? 209 : 225,
        10
      ),
      item('the marked locations.', 70, proof === 'large gap' ? 165 : 160, 83, 10),
      item('A later independent paragraph provides the design context.', 62, 183, 224, 10)
    ].map((run) => ({ ...run, fontAscent: 0.75, fontDescent: -0.25, fontVertical: false }))
    const result = extract(runs)
    expect(result.units.find((unit) => unit.items.includes('1:2'))).toMatchObject(
      proof === 'wrapped'
        ? {
            source: '• The deferred process requires recording all the content.',
            items: ['1:2', '1:3']
          }
        : { items: ['1:2'] }
    )
    expect(result.units.find((unit) => unit.items.includes('1:4'))?.items).toEqual(
      proof === 'wrapped' ? ['1:4', '1:5'] : ['1:4']
    )
    expectNativeOwnership(result, runs)
  }
)

it.each(['wrapped', 'missing word', 'other label'])(
  'keeps a witnessed keyword with its native hanging continuation (%s)',
  (proof) => {
    const runs = [
      item('This paragraph introduces the methods for the following assessment.', 50, 80, 490, 10),
      item(
        proof === 'missing word'
          ? 'The measuring devices helped calibrate the ordinary apparatus.'
          : 'The detectors helped calibrate the ordinary apparatus.',
        50,
        92,
        287,
        10
      ),
      item(proof === 'other label' ? 'Methods:' : 'Keywords:', 86, 120, 44, 10, 'italic', false),
      item('samples: calibration — evaluation: instrument response — detec-', 134, 120, 390, 10),
      item('tors: general', 134, 132.5, 55, 10, 'body', false),
      item('An independent paragraph follows with a larger gap.', 50, 170, 490, 10)
    ].map((run) => ({ ...run, fontAscent: 0.75, fontDescent: -0.25, fontVertical: false }))
    const result = extract(runs)
    const owner = result.units.find((unit) => unit.items.includes('1:3'))
    expect(owner?.items.includes('1:4')).toBe(proof === 'wrapped')
    if (proof === 'wrapped') expect(owner?.source).toContain('detectors: general')
    expectNativeOwnership(result, runs)
  }
)

it.each(['complete', 'missing destination', 'misaligned destination', 'different cover'])(
  'preserves the native row of each supplementary contents entry (%s)',
  (caseName) => {
    const entries = [
      ['A', 'Initial Measurements', '2'],
      ['A.1', 'Coordinate Calibration', '2'],
      ['A.2', 'Independent Validation', '3'],
      ['B', 'Summary Results', '3'],
      ['B.1', 'Additional Experiments', '4'],
      ['C', 'Selection Procedure', '4']
    ]
    const runs = [
      item(
        caseName === 'different cover' ? 'Additional Experiments' : 'Supplementary Materials',
        210,
        95,
        180,
        17
      ),
      item('Contents', 281, 134, 38, 9, 'center'),
      item('Contents', 65, 150, 35, 9, 'body', false),
      item('1', 550, 150, 4, 9),
      ...entries.flatMap(([label, title, dest], index) => {
        const y = 161 + index * 11
        return [
          item(label, 65, y, 13, 9, 'body', false),
          item(title, label.length > 1 ? 101 : 90, y, 142, 9, 'body', false),
          ...(caseName === 'missing destination' && index === 3
            ? []
            : [
                item(
                  dest,
                  caseName === 'misaligned destination' && index === 4 ? 505 : 550,
                  y,
                  4,
                  9
                )
              ])
        ]
      }),
      item('1', 298, 725, 4, 6)
    ].map((run) => ({ ...run, fontAscent: 1.1, fontDescent: -0.25, fontVertical: false }))
    const result = extract(runs)
    const entryOwners = result.units.filter((unit) =>
      entries.some(([, title]) => unit.source.includes(title))
    )
    const independent = entryOwners.filter((unit) => unit.items.length === 2)
    if (caseName === 'complete') {
      expect(entryOwners.map((unit) => unit.source)).toEqual(
        entries.map(([label, title]) => `${label} ${title}`)
      )
      expect(independent).toHaveLength(entries.length)
      expect(entryOwners.some((unit) => unit.sourceOnly)).toBe(false)
    } else {
      expect(independent.length).toBeLessThan(entries.length)
    }
    expectNativeOwnership(result, runs)
  }
)

it.each([
  {
    title: 'Designing the Controls for Data Manage-',
    tail: 'ment',
    witness: 'Our management of the records combines two sources and a reference.',
    fault: 'none'
  },
  {
    title: 'Calibrating the Response of the Local Resis-',
    tail: 'tance',
    witness: 'This resistant coating allows the sensor to operate through repeated trials.',
    fault: 'none'
  },
  {
    title: 'Designing the Controls for Data Manage-',
    tail: 'ment',
    witness: 'Our management of the records combines two sources and a reference.',
    fault: 'displaced'
  },
  {
    title: 'Calibrating the Response of the Local Resis-',
    tail: 'tance',
    witness: 'The collected records were grouped by source and test date.',
    fault: 'unwitnessed'
  }
])('restores a flush numbered heading word ($fault, $tail)', ({ title, tail, witness, fault }) => {
  const runs = [
    item(witness, 60, 90, 228, 9),
    item('The previous paragraph gives a complete independent observation.', 60, 100, 228, 9),
    item('4.2.', 60, 130, 13.4, 9, 'heading', false),
    item(' ', 73.4, 130, 5.6, 9, 'heading', false),
    item(title, 79, 130, 209, 9, 'heading'),
    item(tail, fault === 'displaced' ? 72 : 60, 140.4, 20, 9, 'heading', false),
    item('', 60, 156.4, 0, 9),
    item(
      'These trials demonstrate that the initial calibration remains stable.',
      60,
      156.4,
      228,
      9
    ),
    item('Each value was recorded after a complete measurement interval.', 60, 166.8, 228, 9),
    item('The apparatus was then returned to the original configuration.', 60, 177.2, 228, 9)
  ].map((run) => ({
    ...run,
    height: run.str.trim() ? 9 : 0,
    fontAscent: 0.7,
    fontDescent: -0.2,
    fontVertical: false
  }))
  const result = groupPdfTranslationPages({
    pages: [{ page: 1, width: 596, height: 842, rotation: 0, items: runs }]
  })
  const owner = (index: number): (typeof result.units)[number] | undefined =>
    result.units.find((unit) => unit.items.includes(`1:${index}`))
  const heading = owner(4)
  if (fault === 'none') {
    expect(heading).toBe(owner(5))
    expect(heading?.source).toBe('4.2. ' + title.slice(0, -1) + tail)
    expect(heading?.fragments).toHaveLength(2)
  } else {
    expect(heading).not.toBe(owner(5))
  }
  expect(owner(7)).not.toBe(heading)
  expect(owner(7)?.kind).toBe('prose-candidate')
  expectNativeOwnership(result, runs)
})

it.each(['wrapped', 'no conjunction', 'no body transition', 'different indent'])(
  'joins the longer native continuation of a numbered heading (%s)',
  (condition) => {
    const runs = [
      item(
        'An earlier paragraph introduces the test apparatus and its purpose.',
        135,
        130,
        345,
        10
      ),
      item(
        'The remainder of the preceding section closes on an independent line.',
        135,
        142,
        345,
        10
      ),
      item('4', 135, 175, 7, 12, 'heading', false),
      item(' ', 142, 175, 13, 12, 'heading', false),
      item(
        condition === 'no conjunction'
          ? 'Second trial: measurement of the laboratory device'
          : 'Second trial: measurement of the laboratory device and',
        155,
        175,
        320,
        12,
        'heading'
      ),
      item(
        'energy transfer by a thin ceramic plate',
        condition === 'different indent' ? 170 : 155,
        189,
        182,
        12,
        'heading',
        false
      ),
      item('', 135, 213, 0, 10),
      item(
        'The following body paragraph describes a fresh series of measurements.',
        135,
        213,
        345,
        condition === 'no body transition' ? 12 : 10,
        condition === 'no body transition' ? 'heading' : 'body'
      ),
      item(
        'It continues in the normal document type with separate explanations.',
        135,
        225,
        345,
        10
      )
    ].map((run) => ({ ...run, fontAscent: 0.75, fontDescent: -0.25, fontVertical: false }))
    const result = extract(runs)
    const owner = result.units.find((unit) => unit.items.includes('1:4'))
    expect(owner?.items.includes('1:5')).toBe(condition === 'wrapped')
    expect(owner?.items.includes('1:7')).toBe(false)
    expectNativeOwnership(result, runs)
  }
)

it.each(['joined', 'different column', 'missing phrase witness'])(
  'requires original row and prose evidence to join a wrapped index term (%s)',
  (shape) => {
    const runs = [
      item('An independent abstract describes the research context.', 50, 225, 250, 9, 'metadata'),
      item('Index', 60, 241, 24, 9, 'slanted', false),
      item('Terms', 89, 241, 26, 9, 'slanted', false),
      item('—', 115, 241, 9, 9, 'metadata', false),
      item('samples,', 124, 241, 33, 9, 'metadata', false),
      item('calibration,', 163, 241, 47, 9, 'metadata', false),
      item('assessment,', 216, 241, 47, 9, 'metadata', false),
      item('Field', 269, 241, 31, 9, 'metadata'),
      item('Survey', shape === 'different column' ? 310 : 50, 251, 32, 9, 'metadata'),
      item('I. INTRODUCTION', 140, 278, 83, 10, 'heading'),
      item(
        shape === 'missing phrase witness'
          ? 'The independent evaluation measures how well the model predicts each response.'
          : 'A field survey measures how well the model predicts each response.',
        50,
        304,
        247
      ),
      item('This independent body line follows in a full-width row.', 50, 316, 250)
    ].map((run) => ({ ...run, fontAscent: 0.75, fontDescent: -0.25, fontVertical: false }))
    const result = extract(runs)
    const owner = result.units.find((unit) => unit.items.includes('1:1'))!
    expect(owner.items.includes('1:8')).toBe(shape === 'joined')
    if (shape === 'joined') {
      expect(owner.source).toBe('Index Terms—samples, calibration, assessment, Field Survey')
    }
    expectNativeOwnership(result, runs)
  }
)

it.each(['complete', 'wrong ordinal', 'occupied margin'])(
  'protects alternating native inner headers only with both folio lanes (%s)',
  (mode) => {
    const pages = Array.from({ length: 4 }, (_, index) => {
      const page = index + 2,
        left = page % 2 === 0,
        label = left ? 'Example Research Team' : 'Review of Independent Samples',
        width = left ? 88 : 120,
        header = item(label, 270 - width / 2, 84, width, 9, 'running', false),
        folio = item(
          mode === 'wrong ordinal' && page === 3 ? '8' : String(page),
          left ? 70 : 465,
          84,
          5,
          9,
          'running',
          false
        ),
        ordinary = item(
          'An independent observation continues below this upper margin.',
          70,
          mode === 'occupied margin' && page === 3 ? 95 : 112,
          355,
          10
        )
      const items = [...(left ? [folio, header] : [header, folio]), ordinary].map((run) => ({
        ...run,
        fontAscent: 0.8,
        fontDescent: -0.2,
        fontVertical: false
      }))
      return { page, width: 600, height: 800, rotation: 0, items }
    })
    const result = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 800, rotation: 0, items: [] }, ...pages],
      pageCount: 5
    })
    for (const page of pages) {
      const header = result.units.find((unit) =>
        unit.items.includes(`${page.page}:${page.page % 2 ? 0 : 1}`)
      )
      const ordinary = result.units.find((unit) => unit.items.includes(`${page.page}:2`))
      expect(header?.sourceOnly === true).toBe(mode === 'complete')
      expect(ordinary?.sourceOnly).toBeUndefined()
    }
  }
)

it.each(['independent title', 'open preceding prose', 'different section'])(
  'splits a dotted title from formula-adjacent prose only with sibling evidence: %s',
  (mode) => {
    const run = (
      text: string,
      x: number,
      baseline: number,
      width: number,
      font = 10,
      face = 'body',
      end = true
    ): PdfLayoutTextItem => ({
      ...item(text, x, 800 - baseline, width, font, face, end),
      fontVertical: false,
      fontAscent: 0.8,
      fontDescent: -0.2
    })
    const title =
      mode === 'different section'
        ? '5.3. Interpreting remaining signals'
        : '4.3. Interpreting remaining signals'
    const items = [
      run('Equipment remains available for every trial performed here.', 310, 468, 236),
      run('Some explicit observations belong to the prior paragraph.', 310, 456, 236),
      run('The preceding adjustment completes this note.', 310, 444, 200, 10, 'body', false),
      run('4.2. Refined signal estimates', 310, 426, 134, 11, 'heading', false),
      run('The independent run starts with another complete body row.', 322, 408, 224),
      run('Each experiment has a controlled alignment at each step.', 310, 396, 236),
      run('with an array of alternative readings, and ', 322, 286, 160, 10, 'body', false),
      run('a', 482, 286, 4, 10, 'math', false),
      run(' calculates the comparison independently', 488, 286, 58),
      run('by weighting each independent sample against', 310, 274, 209, 10, 'body', false),
      run('r', 523, 274, 4, 10, 'math', false),
      run('n', 528, 279, 4, 7, 'script', false),
      run('ij', 528, 271, 9, 7, 'script', false),
      run(mode === 'open preceding prose' ? ',' : '.', 538, 274, 2.5, 10, 'body', false),
      run(title, 310, 256, 175, 11, 'heading', false),
      run('The next paragraph records the errors remaining after', 322, 238, 224),
      run('the second test with an independent native control frame.', 310, 226, 236)
    ]
    const layout = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }],
      pageCount: 1
    })
    const owner = layout.units.find((unit) => unit.items.includes('1:14'))
    expect(owner?.items.includes('1:13')).toBe(mode !== 'independent title')
    if (mode === 'independent title') {
      expect(owner?.source).toBe(title)
      expect(owner?.items).toEqual(['1:14'])
      expect(owner?.sourceOnly).toBeUndefined()
      expect(layout.units.find((unit) => unit.items.includes('1:13'))?.source).toMatch(/rnij\.$/u)
    }
  }
)

it.each(['complete', 'missing term', 'unowned line', 'wrong footnote'])(
  'reconnects the witnessed compound after separately owned table and footnote content: %s',
  (fault) => {
    const runs = [
      item(
        'Experiments established stable conditions over several trial runs.',
        48,
        624,
        252,
        10,
        'body'
      ),
      item(
        'Each measurement was recorded across the same trial interval.',
        48,
        636,
        252,
        10,
        'body'
      ),
      item(
        'The study initially used a multi-stage calibration procedure.',
        48,
        648,
        252,
        10,
        'body'
      ),
      item(
        'The recorded reference frames provided one independent baseline.',
        48,
        660,
        252,
        10,
        'body'
      ),
      item(
        'Each group went through a repeatable set of prepared test steps.',
        48,
        672,
        252,
        10,
        'body'
      ),
      item('The next recorded values were used by the observation team.', 48, 684, 252, 10, 'body'),
      item('They were measured before starting the multi-', 48, 696, 252, 10, 'body', false),
      item('1', 57, 711, 3, 6, 'body', false),
      item('https://example.org/registry', 60.4, 714, 110, 8, 'body', false),
      item('TABLE I: Summary of the calibration trials.', 358, 53, 160, 10, 'caption'),
      ...[
        ['', 'Sample A', 'Sample B', 'Sample C'],
        ['Control', 'Test', 'Test', 'Test'],
        ['Count A', '1.437', '2.933', '3.414'],
        ['Count B', '1.100', '1.405', '2.594'],
        ['Count C', '3.869', '6.026', '9.794'],
        ['TOTAL', '6.406', '10.364', '15.802']
      ].flatMap((row, n) =>
        row.flatMap((text, col) =>
          text
            ? [
                item(
                  text,
                  [345, 427, 474, 508][col],
                  74 + n * 10,
                  col ? 20 : 26,
                  8,
                  'table',
                  col === 3
                )
              ]
            : []
        )
      ),
      item(
        'stage, we first recorded each configuration in a short log.',
        312,
        164,
        252,
        10,
        'body'
      ),
      item(
        'The baseline trials completed before all later observations.',
        312,
        176,
        252,
        10,
        'body'
      ),
      item('These controlled tests were repeated for every run.', 312, 188, 252, 10, 'body')
    ]
    if (fault === 'missing term') runs[2].str = runs[2].str.replace('multi-stage', 'systematic')
    if (fault === 'unowned line')
      runs.splice(runs.length - 3, 0, item('Separate warning.', 314, 140, 80, 10, 'note'))
    if (fault === 'wrong footnote') runs[8].str = 'Separate note.'
    for (const run of runs) run.fontVertical = false
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 800, rotation: 0, items: runs }]
    })
    const body = units.find((unit) => unit.source.includes('before starting the multi-'))!
    expect(body.fragments).toHaveLength(fault === 'complete' ? 2 : 1)
    expect(body.source.includes('multi-stage, we first')).toBe(fault === 'complete')
    expect(
      units.some((unit) => unit.source === 'TABLE I: Summary of the calibration trials.')
    ).toBe(true)
    if (fault !== 'wrong footnote')
      expect(units.some((unit) => unit.source === '1https://example.org/registry')).toBe(true)
  }
)

it.each(['complete', 'foreign prose', 'missing witness'])(
  'rejoins a word below a proved floating table (%s)',
  (shape) => {
    const fonts = {
      body: [0.678, -0.216],
      bold: [0.69, -0.209],
      caption: [0.688, -0.209]
    }
    const row = (
      text: string,
      x: number,
      y: number,
      width: number,
      font: keyof typeof fonts = 'body',
      endsLine = true
    ): PdfLayoutTextItem => ({
      ...item(text, x, 800 - y, width, 9, font, endsLine),
      fontVertical: false,
      fontAscent: fonts[font][0],
      fontDescent: fonts[font][1]
    })
    const left = row(
      'each filtered response. We find that sensors operate more typi-',
      57.6,
      101.8,
      226.8
    )
    const right = row(
      'cally with the chosen settings. The longer validation results showed',
      312.7,
      483,
      226.8
    )
    const caption = row('Table 7:', 312.7, 566.7, 29.1, 'body', false)
    const cells = [
      row('Zone', 383.6, 530.4, 17.4, 'body', false),
      row('Survey', 413, 530.4, 26.9, 'body', false),
      row('Sample A', 340.9, 515, 30.4, 'body', false),
      row('41.5', 385.4, 515, 15.7, 'body', false),
      row('81.0', 456.8, 515, 15.7, 'bold', false),
      row('36.4', 495.6, 515, 15.7, 'bold', false),
      row('124.8', 452.3, 504.6, 20.2, 'body', false),
      row('106.2', 491.1, 504.6, 20.2)
    ]
    const foreign = row(
      'The independent report describes a different set of measurements.',
      312.7,
      495,
      226.8
    )
    const runs = [
      row(
        shape === 'missing witness'
          ? 'An earlier reading was available for independent tests.'
          : 'A typical reading was available for independent tests.',
        57.6,
        585,
        226.8
      ),
      row('Stable vs Time-Varying:', 57.6, 112.2, 118.4, 'bold', false),
      left,
      caption,
      row(
        'Measurements obtained with the chosen settings were collected as pre-',
        345,
        566.7,
        194.5,
        'caption'
      ),
      row('scribed in the test procedure.', 312.7, 556.3, 125.7, 'caption', false),
      ...cells,
      ...(shape === 'foreign prose' ? [foreign] : []),
      right,
      row('consistent agreement across both sensor batches.', 312.7, 472.6, 226.8)
    ]
    const result = groupPdfTranslationPages({
      pages: [{ page: 1, width: 596, height: 842, rotation: 0, items: runs }],
      pageCount: 1
    })
    const owner = (run: PdfLayoutTextItem): (typeof result.units)[number] | undefined =>
      result.units.find((unit) => unit.items.includes(`1:${runs.indexOf(run)}`))
    const first = owner(left)
    const second = owner(right)
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    if (shape === 'complete') {
      expect(first).toBe(second)
      expect(first?.fragments).toHaveLength(2)
      expect(first?.source).toContain('typically with the chosen settings')
    } else {
      expect(first).not.toBe(second)
    }
    expect([caption, ...cells].every((run) => owner(run) !== first && owner(run) !== second)).toBe(
      true
    )
    expectNativeOwnership(result, runs)
  }
)

it.each(['complete', 'foreign prose', 'missing witness'])(
  'rejoins a witnessed word below a compact schematic caption (%s)',
  (shape) => {
    const row = (
      text: string,
      x: number,
      y: number,
      width: number,
      endsLine = true,
      caption = false
    ): PdfLayoutTextItem => {
      const size = caption ? 8.5 : 9
      return {
        ...item(text, x, 800 - y, width, size, caption ? 'Caption' : 'Body', endsLine),
        height: text ? size : 0,
        fontVertical: false,
        fontAscent: caption ? 0.722 : 0.715,
        fontDescent: caption ? -0.217 : -0.282
      }
    }
    const left = row('] and repeated tomo-', 207.5, 59.8, 91, false)
    const caption = row('Fig. 4.', 320.9, 450.6, 24.6, false, true)
    const tail = row(
      'graphic measurements under precisely controlled settings [8].',
      320.7,
      432.7,
      249.1
    )
    const neighbor = row(
      'The next phase evaluates the geometry with a separate sensor.',
      332.9,
      421.1,
      238.7
    )
    const runs = [
      row(
        shape === 'missing witness'
          ? 'A separate scan was independently evaluated for the study.'
          : 'A tomographic scan was independently evaluated for the study.',
        320.7,
        674,
        249.1
      ),
      row('rates [', 47.8, 269.6, 30, false),
      row('6', 77.8, 269.6, 4.5, false),
      row(']. The first calibration uses a common protocol', 82.3, 269.6, 214.9),
      row('with the reference set as the starting point for comparison.', 47.8, 258.7, 250.7),
      row('5', 71.4, 70.7, 4.5, false),
      row(']. Several variants are compared using recorded settings', 75.9, 70.7, 221.2),
      row(
        'for the assessment; related examples include the baseline report [',
        47.8,
        59.8,
        137.2,
        false
      ),
      left,
      row('', 320.9, 450.6, 0, true, true),
      ...(shape === 'foreign prose'
        ? [row('Independent calibration notes were filed for the measurements.', 408, 466, 249.1)]
        : []),
      caption,
      row('Illustration of the measuring fixture.', 348.5, 450.6, 124.3),
      tail,
      neighbor
    ]
    const result = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items: runs }],
      pageCount: 1
    })
    const owner = (
      run: PdfLayoutTextItem
    ): ReturnType<typeof extract>['units'][number] | undefined =>
      result.units.find((unit) => unit.items.includes(`1:${runs.indexOf(run)}`))
    const first = owner(left)
    expect(first).toBeDefined()
    expect(owner(tail)).toBeDefined()
    if (shape === 'complete') {
      expect(first).toBe(owner(tail))
      expect(first?.fragments).toHaveLength(2)
      expect(first?.source).toContain('tomographic measurements')
    } else {
      expect(first).not.toBe(owner(tail))
    }
    expect(owner(caption)).not.toBe(first)
    expect(owner(neighbor)).not.toBe(first)
    expectNativeOwnership(result, runs)
  }
)

it.each(['native margin', 'internal marker', 'foreign face'])(
  'joins a split funding name across native columns only with a protected folio (%s)',
  (proof) => {
    const items = [
      item('1', 545, proof === 'internal marker' ? 51 : 36, 5, 10, 'body', false),
      item('The original measurements were checked in the main archive.', 50, 686.3, 240, 10),
      item('Each response was confirmed before examining the results.', 50, 697.8, 240, 10),
      item('The report includes the final verified observations.', 50, 709.3, 239, 10),
      item('This study was supported by the Coastal Habi-', 60, 723.7, 230, 10),
      item(
        'tat Council under Grant No. 24680, to preserve records',
        310,
        62,
        240,
        10,
        proof === 'foreign face' ? 'shift' : 'body'
      ),
      item('and to document the field observations from each site', 310, 73.5, 240, 10),
      item('and to house them in the habitat research collection.', 310, 85, 204, 10),
      item('The following appendix reports the independent records.', 320, 99.4, 230, 10)
    ].map((run) => ({ ...run, fontVertical: false, fontAscent: 0.694, fontDescent: -0.194 }))
    const { units } = extract(items)
    const funding = units.find((unit) => unit.items.includes('1:4'))
    const joined = proof === 'native margin'
    expect(funding?.items.includes('1:5')).toBe(joined)
    expect(funding?.fragments).toHaveLength(joined ? 2 : 1)
    if (joined) expect(funding?.source).toContain('Coastal Habitat Council')
    expect(units.find((unit) => unit.items.includes('1:0'))?.items).toEqual(['1:0'])
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      items.map((_, index) => `1:${index}`).sort()
    )
  }
)

it.each(['complete word', 'unproved word', 'different face'])(
  'keeps only the inline formula protected after a native word wrap (%s)',
  (proof) => {
    const items = [
      item(
        'The response can be measured using either of two detailed procedures.',
        327,
        407,
        235,
        10
      ),
      item('The first mode:', 317, 418.5, 61, 10, 'body', false),
      item('i) by confirming the detector cali-', 385, 418.5, 177, 10),
      item('bration', 317, 430, 30, 10, proof === 'different face' ? 'foreign' : 'body', false),
      item('(', 350, 430, 4, 10, 'bracket', false),
      item('v', 354, 430, 5, 10, 'variable', false),
      item('0', 359, 431.5, 4, 7, 'subscript', false),
      item(')', 363.5, 430, 4, 10, 'bracket', false),
      item('and gathering several independent samples', 370, 430, 191, 10),
      item('after the previous preparation cycle is complete.', 317, 441.5, 245, 10),
      item(
        proof === 'unproved word'
          ? 'A new procedure describes the data validation separately.'
          : 'A new procedure describes the data calibration separately.',
        327,
        459,
        235,
        10
      )
    ].map((run) => ({ ...run, fontVertical: false, fontAscent: 0.694, fontDescent: -0.194 }))
    const { units } = extract(items)
    const body = units.find((unit) => unit.items.includes('1:2'))
    const formula = units.find((unit) => unit.items.includes('1:7'))
    expect(body?.items.includes('1:3')).toBe(proof === 'complete word')
    if (proof === 'complete word') {
      expect(body?.source).toContain('detector calibration')
      expect(formula?.source).toBe('(v0)')
      expect(formula?.preserve).toBe('formula')
      expect(formula?.items).toEqual(['1:4', '1:5', '1:6', '1:7'])
    }
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      items.map((_, index) => `1:${index}`).sort()
    )
  }
)

it.each(['raised native number', 'level number', 'different line edge'])(
  'rejoins only a witnessed word inside a two-line numbered footnote (%s)',
  (shape) => {
    const items = [
      item('The earlier measurements confirmed the new calibration procedure.', 54, 645, 245, 10),
      item(
        'This completes the description of the separate method.',
        54,
        657,
        196,
        10,
        'body',
        false
      ),
      { ...item('', 56.5, 701, 0, 8), height: 0 },
      item('1', 56.5, shape === 'level number' ? 704 : 701.1, 3, 6, 'body', false),
      item('The team printed the note to explain an independent cali-', 62, 704, 237, 8),
      item(
        'bration applied to each sample before comparing the stored records.',
        shape === 'different line edge' ? 68 : 62,
        713.5,
        234,
        8,
        'body',
        false
      ),
      item('An independent diagram label', 341, 112, 145, 6, 'figure')
    ].map((run) => ({ ...run, fontVertical: false, fontAscent: 0.675, fontDescent: -0.218 }))
    const { units } = extract(items)
    const note = units.find((unit) => unit.items.includes('1:4'))
    const joined = shape === 'raised native number'
    expect(note?.items.includes('1:5')).toBe(joined)
    if (joined) {
      expect(note?.source).toContain('independent calibration applied')
      expect(note?.items).toEqual(['1:3', '1:4', '1:5'])
    }
    expect(units.find((unit) => unit.items.includes('1:6'))?.items).toEqual(['1:6'])
    expect(units.flatMap((unit) => unit.items).sort()).toEqual([
      '1:0',
      '1:1',
      '1:3',
      '1:4',
      '1:5',
      '1:6'
    ])
  }
)

it.each(['same native page turn', 'different heading', 'intervening row'])(
  'continues a native conclusion only between proved closing headings (%s)',
  (shape) => {
    const first = [
      item(shape === 'different heading' ? 'III. RESULTS' : 'III. CONCLUSION', 400, 690, 75, 10),
      item('The experiments compared the original method with a separate test.', 315, 708, 245, 10),
      item('The reported observations agreed over a broad range of controls.', 315, 720, 245, 10),
      item(
        'The sensors closest to the changing source showed that the samples',
        315,
        732,
        245,
        10,
        'body',
        false
      )
    ]
    const second = [
      ...(shape === 'intervening row'
        ? [item('A separate running note', 190, 34, 180, 8, 'other')]
        : []),
      item(
        'respond consistently under the same independent laboratory conditions.',
        50,
        58,
        245,
        10
      ),
      item('These repeatable measurements support the preliminary observations.', 50, 70, 245, 10),
      item(
        'The report also records the practical limits of this measurement approach.',
        50,
        82,
        224,
        10
      ),
      item('ACKNOWLEDGMENT', 122.5, 103, 100, 10),
      ...Array.from({ length: 12 }, (_, index) =>
        item(
          `[${index + 1}] A complete journal reference with its independent bibliographic details (2020).`,
          315,
          200 + 15 * index,
          245,
          8,
          'reference'
        )
      )
    ]
    const pages = [first, second].map((items, index) => ({
      page: index + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items: items.map((i) => ({
        ...i,
        fontVertical: false,
        fontAscent: 0.678,
        fontDescent: -0.216
      }))
    }))
    const { units } = groupPdfTranslationPages({ pages })
    const a = units.find((u) => u.items.includes('1:3'))
    const b = units.find((u) => u.items.includes(shape === 'intervening row' ? '2:1' : '2:0'))
    expect(a === b).toBe(shape === 'same native page turn')
    const heading = units.find((u) => u.source === 'ACKNOWLEDGMENT')
    expect(heading?.items).toEqual([shape === 'intervening row' ? '2:4' : '2:3'])
    expect(new Set(units.flatMap((u) => u.items)).size).toBe(first.length + second.length)
  }
)

it.each(['consecutive displays', 'different equation number', 'first independent line'])(
  'joins a page-spanning display introduction only with consecutive native equations (%s)',
  (shape) => {
    const equation = (n: number, at: number): PdfLayoutTextItem[] => [
      item('Q', 190, at, 10, 12, 'symbol', false),
      item('=', 220, at, 10, 12, 'body', false),
      item('σ', 250, at, 11, 12, 'symbol', false),
      item(`(${n})`, 535, at, 15, 12)
    ]
    const pages = [
      [
        ...equation(4, 656),
        item(
          'With the observations recorded in two independent runs, it is straightforward to calculate',
          97,
          715,
          453,
          12
        ),
        item('1', 303, 778, 6, 12, 'body', false)
      ],
      [
        ...(shape === 'first independent line'
          ? [item('A standalone header', 70, 85, 125, 10)]
          : []),
        item(
          'the reference voltages for all components treated in this example:',
          68.2,
          109,
          380,
          12
        ),
        ...equation(shape === 'different equation number' ? 7 : 5, 145)
      ]
    ].map((items, index) => ({
      page: index + 1,
      width: 612,
      height: 792,
      rotation: 0,
      items: items.map((r) => ({ ...r, fontVertical: false, fontAscent: 0.69, fontDescent: -0.21 }))
    }))
    const { units } = groupPdfTranslationPages({ pages })
    const head = units.find((u) => u.items.includes('1:4'))
    const tail = units.find((u) =>
      u.items.includes(shape === 'first independent line' ? '2:1' : '2:0')
    )
    expect(head === tail).toBe(shape === 'consecutive displays')
    expect(units.find((u) => u.items.includes('1:5'))?.source).toBe('1')
    expect(units.find((u) => u.items.includes('1:3'))?.preserve).toBe('formula')
    expect(new Set(units.flatMap((u) => u.items)).size).toBe(
      pages[0].items.length + pages[1].items.length
    )
  }
)

it.each(['attested word', 'unattested word', 'other margin'])(
  'keeps a witnessed caption wrap above aligned numeric cells (%s)',
  (proof) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      size: number,
      font: string,
      eol: boolean
    ): PdfLayoutTextItem => ({
      ...item(str, x, y + 8, width, size, font, eol),
      fontVertical: false,
      fontAscent: font === 'bold' ? 0.69 : 0.678,
      fontDescent: font === 'bold' ? -0.209 : -0.216
    })
    const items = [
      row('Table 1', 34, 97, 27, 8.97, 'bold', false),
      row(': Metric comparison across calibrated stations', 61, 97, 204, 8.97, 'body', true),
      row(
        proof === 'unattested word'
          ? 'Field measurements preceded battery calibration'
          : 'Results are provided for repeatable conditions in the field',
        34,
        108,
        232,
        8.97,
        'body',
        true
      ),
      row('Table 2', 281, 97, 27, 8.97, 'bold', false),
      row(': Comparison of electrical readings with repeat-', 308, 97, 205, 8.97, 'body', true),
      row(
        'able settings, using independent instruments with known margins',
        proof === 'other margin' ? 287 : 281,
        108,
        210,
        8.97,
        'body',
        false
      ),
      row('', 295, 124, 0, 0, 'bold', true),
      row('Zones', 295, 124, 31, 9.96, 'bold', false),
      row('Survey [1]', 348, 124, 41, 9.96, 'bold', false),
      row('Field', 400, 124, 26, 9.96, 'bold', false),
      row('[2]', 428, 124, 11, 9.96, 'body', false),
      row('Trial', 451, 124, 21, 9.96, 'bold', false),
      row('Ref', 484, 124, 14, 9.96, 'bold', false),
      row('', 295, 141, 0, 0, 'body', true),
      row('District', 295, 141, 41, 9.96, 'body', false),
      row('8.10', 360, 141, 17, 9.96, 'body', false),
      row('6.20', 411, 141, 17, 9.96, 'body', false),
      row('4.30', 453, 141, 17, 9.96, 'bold', false),
      row('2.40', 485, 141, 12, 9.96, 'body', true),
      row('Shelter', 295, 153, 29, 9.96, 'body', false),
      row('7.15', 360, 153, 17, 9.96, 'body', false),
      row('5.25', 411, 153, 17, 9.96, 'body', false),
      row('3.35', 453, 153, 17, 9.96, 'bold', false),
      row('1.45', 483, 153, 17, 9.96, 'body', true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const caption = units.find((u) => u.items.includes('1:3'))
    const secondLine = units.find((u) => u.items.includes('1:5'))
    expect(caption === secondLine).toBe(proof === 'attested word')
    if (proof === 'attested word') expect(caption?.source).toContain('with repeatable settings')
    expect(units.find((u) => u.source === '8.10')?.preserve).toBe('literal')
  }
)

it.each(['matching bullet', 'different text rail', 'closed lead'])(
  'joins a terminal noun phrase only within the matching native bullet (%s)',
  (proof) => {
    const row = (s: string, x: number, y: number, w: number): PdfLayoutTextItem => ({
      ...item(s, x, y, w, 9),
      fontVertical: false,
      fontAscent: 0.69,
      fontDescent: -0.21
    })
    const items = [
      row('Several independent adjustments keep the recorded measurements stable:', 285, 420, 253),
      row('• Adjust the pressure sensor before taking a reference reading,', 315, 442, 213),
      row(
        'which removes drift and improves alignment.',
        323,
        452.5,
        proof === 'different text rail' ? 201 : 205
      ),
      row(
        proof === 'closed lead'
          ? '• The compact instrument has two optical stages.'
          : '• The compact instrument maintains alignment between the',
        315,
        471,
        213
      ),
      row('reference sample and the independent light source.', 323, 481.5, 150),
      row('The next group of samples was prepared on another day.', 300, 502, 229)
    ]
    const { units } = extract(items)
    const head = units.find((u) => u.items.includes('1:3'))
    const tail = units.find((u) => u.items.includes('1:4'))
    expect(head === tail).toBe(proof === 'matching bullet')
    expect(units.find((u) => u.items.includes('1:1'))?.items).toEqual(['1:1', '1:2'])
  }
)

it.each(['repeated term', 'different term', 'native row in between'])(
  'keeps a short native phrase inside its repeated numbered item (%s)',
  (shape) => {
    const row = (text: string, left: number, y: number, width: number): PdfLayoutTextItem => ({
      ...item(text, left, y, width, 9),
      fontVertical: false,
      fontAscent: 0.69,
      fontDescent: -0.21
    })
    const items = [
      row(
        '2. The calibration plan records several independent readings before every trial',
        280,
        385,
        230
      ),
      row(
        shape === 'different term'
          ? 'and follows a separate review procedure.'
          : 'and follows the test reference method.',
        292,
        396,
        135
      ),
      ...(shape === 'native row in between'
        ? [row('Independent native label.', 45, 401, 147)]
        : []),
      row('3. The following measurements support the second stage of the procedure', 280, 411, 230),
      row('by allowing the instruments to be adjusted according to the test', 292, 422, 218),
      row('reference method.', 292, 433, 65),
      row('4. The remaining recorded observations are compared across all groups.', 280, 449, 230)
    ]
    const { units } = extract(items)
    const start = units.find((u) => u.source.startsWith('3. The following'))
    expect(start?.source.endsWith('test reference method.')).toBe(shape === 'repeated term')
    expect(units.some((u) => u.source.startsWith('4. The remaining'))).toBe(true)
  }
)

it.each(['matching facing pages', 'wrong even page number', 'different repeated title'])(
  'keeps the alternating source-only rows out of body flow (%s)',
  (shape) => {
    const first = 'Documenting Practical Measurements from',
      second = 'Independent Field Instruments',
      title = `${first} ${second}`,
      byline = 'J. Larkin et al.'
    const cover = [
      item(first, 145, 100, 288, 14, 'cover'),
      item(second, 194, 119, 212, 14, 'cover'),
      item('Jamie Larkin, Jules Warren, and Jae Emery', 183, 151, 232, 10)
    ]
    const pages = [
      cover,
      ...[2, 3, 4, 5].map((page) => {
        const y = page <= 3 ? 137 : 272,
          even = page % 2 === 0,
          mark = item(
            String(shape === 'wrong even page number' && page === 4 ? 7 : page),
            even ? 125 : 470,
            y,
            5,
            9,
            'imprint',
            false
          ),
          label = item(
            even ? byline : shape === 'different repeated title' && page === 5 ? second : title,
            even ? 164 : 125,
            y,
            even ? 72 : 270,
            9,
            'imprint'
          )
        return [
          item(
            'Several independent observations clarify the measurement process and',
            126,
            y - 25,
            344,
            10
          ),
          item(
            'the sampling conditions for the remaining equipment in our survey.',
            126,
            y - 14,
            344,
            10
          ),
          ...(even ? [mark, label] : [label, mark]),
          item(
            'The comparison uses observations from separate trial conditions.',
            126,
            y + 28,
            344,
            10
          )
        ]
      })
    ].map((items, i) => ({
      page: i + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items: items.map((x) => ({ ...x, fontVertical: false, fontAscent: 0.69, fontDescent: -0.21 }))
    }))
    const { units } = groupPdfTranslationPages({ pages })
    const native = (page: number, index: number): (typeof units)[number] | undefined =>
      units.find((u) => u.items.includes(`${page}:${index}`))
    expect(native(3, 2)?.sourceOnly === true).toBe(shape === 'matching facing pages')
    expect(native(4, 3)?.sourceOnly === true).toBe(shape === 'matching facing pages')
    expect(native(3, 1)?.sourceOnly).toBeUndefined()
    expect(native(3, 4)?.sourceOnly).toBeUndefined()
    expect(new Set(units.flatMap((u) => u.items)).size).toBe(pages.flatMap((p) => p.items).length)
  }
)

it.each(['centered caption', 'different axis', 'no numeric table'])(
  'keeps the short ending of a centered table caption in its source owner (%s)',
  (shape) => {
    const row = (
      text: string,
      x: number,
      y: number,
      width: number,
      font = 'body',
      eol = true
    ): PdfLayoutTextItem => ({
      ...item(text, x, y, width, 9, font, eol),
      fontVertical: false,
      fontAscent: 0.69,
      fontDescent: -0.21
    })
    const runs = [
      row(
        'The instrument was adjusted before each sample was returned to the enclosure.',
        311,
        344,
        223
      ),
      row('Table 2:', 325, 371, 28, 'body', false),
      row('Comparison of variances relative to', 356, 371, 169, 'caption'),
      row('the calibrated method (', 315, 382, 60, 'caption', false),
      row('RC-BASE', 376, 382, 29, 'identifier', false),
      row(') for channel X and the average of', 405, 382, 130, 'caption'),
      row('all measurements.', shape === 'different axis' ? 410 : 400, 393, 50, 'caption', false),
      row('Model', 340, 421, 25, 'heading', false),
      row('Low', 426, 421, 32, 'heading', false),
      row('High', 493, 421, 32, 'heading'),
      ...[444, 454].flatMap((y, n) => [
        row(n ? 'Option B' : 'Option A', 340, y, 35, 'body', false),
        row(shape === 'no numeric table' ? 'Safe' : `${n + 2}%`, 432, y, 13, 'body', false),
        row(shape === 'no numeric table' ? 'Clear' : `${n + 4}%`, 500, y, 13)
      ])
    ]
    const { units } = extract(runs)
    const caption = units.find((u) => u.source.startsWith('Table 2:'))
    expect(caption?.source.endsWith('all measurements.')).toBe(shape === 'centered caption')
    expect(caption?.fragments.length).toBe(shape === 'centered caption' ? 2 : 1)
    expect(units.find((u) => u.source === 'Model')?.items).toEqual(['1:7'])
  }
)

it.each(['aligned neighboring bullet', 'misaligned neighboring bullet'])(
  'keeps a purpose clause with its hanging bullet (%s)',
  (proof) => {
    const items = [
      item('• We recorded the signal from the first reference array', 340, 200, 220, 10),
      item('for three trials and retained the strongest observations', 349, 212, 211, 10),
      item(
        'from the second day.',
        proof === 'aligned neighboring bullet' ? 349 : 339,
        224,
        160,
        10
      ),
      item('• We implemented a compact adaptation module', 340, 236, 220, 10),
      item('to reduce the effort required by each operator.', 349, 248, 188, 10),
      item('• We compare the outcomes with an independent method.', 340, 260, 220, 10)
    ]
    const units = extract(
      items.map((run) => ({ ...run, fontVertical: false, fontAscent: 0.8, fontDescent: -0.2 }))
    ).units.filter((unit) => unit.items.some((key) => key === '1:3' || key === '1:4'))
    expect(units.length).toBe(proof === 'aligned neighboring bullet' ? 1 : 2)
    if (proof === 'aligned neighboring bullet')
      expect(units[0].source).toContain('module to reduce')
  }
)

it.each(['ordinary', 'font', 'gap', 'column', 'complete'])(
  'keeps a witnessed body-column return with %s geometry',
  (variant) => {
    const runs = [
      item('A neighboring complete sentence describes these ordinary results.', 100, 80, 400, 10),
      item('A second complete sentence checks the same experimental setup.', 100, 91, 400, 10),
      item(
        variant === 'complete'
          ? 'The quantity uses a frozen state for these remaining parameters.'
          : 'the quantity uses a frozen state for the remaining',
        270,
        130,
        230,
        10
      ),
      item(
        'parameters. The next measurement uses the same common configuration.',
        variant === 'column' ? 330 : 100,
        variant === 'gap' ? 180 : 141,
        400,
        10,
        variant === 'font' ? 'caption' : 'body'
      ),
      item(
        'The final observation confirms these independent results.',
        100,
        variant === 'gap' ? 191 : 152,
        330,
        10
      )
    ]
    const result = extract(
        runs.map((run) => ({ ...run, fontVertical: false, fontAscent: 0.75, fontDescent: -0.2 }))
      ),
      head = result.units.find((unit) => unit.items.includes('1:2'))!
    expect(head.items.includes('1:3')).toBe(variant === 'ordinary')
    expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
      runs.map((_, index) => `1:${index}`).sort()
    )
  }
)

it.each(['ordinary', 'font', 'gap', 'peer', 'complete'])(
  'keeps a short hanging bullet continuation with %s evidence',
  (variant) => {
    const runs = [
      item('• Another complete item describes the shared test process.', 100, 100, 400, 10),
      item(
        'The same process is used for these independent observations.',
        variant === 'peer' ? 125 : 108.5,
        111,
        390,
        10
      ),
      item(
        variant === 'complete'
          ? '• A new approach works with several previous methods.'
          : '• A new approach works with several previous methods, such',
        100,
        130,
        400,
        10
      ),
      item(
        'as feature-sharing. A separate check confirms the result.',
        108.5,
        variant === 'gap' ? 180 : 141,
        280,
        10,
        variant === 'font' ? 'caption' : 'body',
        false
      )
    ]
    const result = extract(
        runs.map((run) => ({ ...run, fontVertical: false, fontAscent: 0.75, fontDescent: -0.2 }))
      ),
      head = result.units.find((unit) => unit.items.includes('1:2'))!
    expect(head.source.includes('such as feature-sharing.')).toBe(variant === 'ordinary')
    expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
      runs.map((_, index) => `1:${index}`).sort()
    )
  }
)

it.each(['ordinary', 'unwitnessed', 'gap', 'column'])(
  'joins a hyphenated paragraph tail only with %s evidence',
  (variant) => {
    const runs = [
      item(
        'A relatively small sample establishes the complete word independently.',
        100,
        80,
        400,
        10
      ),
      item('A second complete sentence calibrates the ordinary body type.', 100, 91, 400, 10),
      item(
        'This ordinary paragraph contains several words and a ' +
          (variant === 'unwitnessed' ? 'custom-' : 'rela-'),
        100,
        130,
        400,
        10
      ),
      item(
        'tively small number of tests provides sufficient coverage of these parameters.',
        variant === 'column' ? 300 : 100,
        variant === 'gap' ? 180 : 141,
        400,
        10
      ),
      item(
        'The complete final sentence retains all of its original native ownership.',
        100,
        variant === 'gap' ? 191 : 152,
        400,
        10
      )
    ]
    const result = extract(
        runs.map((run) => ({ ...run, fontVertical: false, fontAscent: 0.75, fontDescent: -0.2 }))
      ),
      head = result.units.find((unit) => unit.items.includes('1:2'))!
    expect(head.source.includes('relatively small')).toBe(variant === 'ordinary')
    expect(result.units.flatMap((unit) => unit.items).sort()).toEqual(
      runs.map((_, index) => `1:${index}`).sort()
    )
  }
)

it.each([
  'closed record',
  'no peer',
  'foreign font',
  'wide gap',
  'different column',
  'mathematical tail'
])('keeps a short numbered label with only its witnessed hanging question (%s)', (proof) => {
  const runs = [
    item('1. Prompt:', 80, 100, 50, 10.9091, 'body', false),
    item('Does method need such', 140, 100, 160),
    item(
      proof === 'mathematical tail'
        ? 'a + b = c'
        : 'a sufficiently large set of independent observations',
      proof === 'different column' ? 350 : 93,
      proof === 'wide gap' ? 130 : 113,
      207,
      10.9091,
      proof === 'foreign font' ? 'foreign' : 'body'
    ),
    item('before recording the final response?', 93, 126, 160),
    item('Reply: The separate complete response remains an independent paragraph.', 93, 148, 207),
    ...(proof === 'no peer'
      ? []
      : [
          item('2. Prompt: Does this method converge', 80, 180, 220),
          item('more slowly when the prior result changes', 93, 193, 207),
          item('between the independent evaluations?', 93, 206, 170),
          item('Reply: This separate response remains unchanged.', 93, 228, 207)
        ])
  ]
  const { units } = extract(runs)
  const head = units.find((unit) => unit.items.includes('1:0'))!
  expect(head.items.includes('1:2')).toBe(proof === 'closed record')
  expect(head.items).not.toContain('1:4')
  if (proof === 'closed record') {
    expect(head.source).toContain('such a sufficiently large set')
    expect(head.source).toContain('final response?')
    const peer = units.find((unit) => unit.items.includes('1:5'))!
    expect(peer.source).toContain('converge more slowly')
    expect(peer.items).not.toContain('1:8')
  }
  expect(units.flatMap((unit) => unit.items).sort()).toEqual(
    runs.map((_, index) => `1:${index}`).sort()
  )
})

it('retains several complete sentences within a numbered method record', () => {
  const runs = [
    item('1. Method: The apparatus records several independent readings', 80, 100, 220),
    item('during each trial before a new reference is measured.', 93, 113, 207),
    item('It then compares these readings with another stable reference.', 93, 126, 207),
    item('2. Method: The apparatus records several independent control readings', 80, 154, 220),
    item('before the independent comparison is completed.', 93, 167, 207)
  ]
  const { units } = extract(runs)
  const first = units.find((unit) => unit.items.includes('1:0'))!
  expect(first.items).toEqual(['1:0', '1:1', '1:2'])
  expect(first.source).toContain('measured. It then compares')
  expect(first.items).not.toContain('1:3')
})

it.each(['wrapped', 'no abstract witness', 'no new paragraph'])(
  'keeps a punctuated final word with its full-width keyword list (%s)',
  (condition) => {
    const runs = [
      item(
        condition === 'no abstract witness'
          ? 'The measured values are accurate within expected thresholds in the report.'
          : 'The measured values are accurate within reference intervals in the report.',
        83,
        325,
        313,
        9,
        'body',
        false
      ),
      item('Keywords:', 58, 365, 46, 10, 'label', false),
      { ...item(' ', 104, 365, 6, 10, 'label', false), height: 0 },
      item('Measurements, temperature, accuracy, calibration, reference', 110, 365, 438, 10),
      item('intervals.', 58, 377, 29, 10),
      item(
        'The following paragraph explains the equipment used for the measurements.',
        condition === 'no new paragraph' ? 58 : 70,
        401,
        270,
        10,
        'body',
        false
      )
    ].map((run) => ({ ...run, fontAscent: 0.68, fontDescent: -0.22, fontVertical: false }))
    const result = extract(runs)
    const owner = result.units.find((unit) => unit.items.includes('1:1'))
    expect(owner?.items).toEqual(condition === 'wrapped' ? ['1:1', '1:3', '1:4'] : ['1:1', '1:3'])
    if (condition === 'wrapped') expect(owner?.source).toMatch(/reference intervals\.$/u)
    expectNativeOwnership(result, runs)
  }
)

it.each(['wrapped', 'separate lane'])(
  'keeps a wrapped Ångström resolution with its native prose (%s)',
  (shape) => {
    const x = shape === 'wrapped' ? 50 : 75
    const runs = [
      item('The first measurement uses the stable set of optical components.', 59, 600, 500, 10),
      item(
        'We repeated the acquisition using the same settings with a resolution of',
        50,
        612.5,
        510,
        10
      ),
      item('2.6 ˚', x, 625, 23.5, 10, 'body', false),
      item('A.', x + 16, 625, 10.2, 10),
      item(
        'The next paragraph reports an independent test of the calibration.',
        59,
        637.5,
        500,
        10
      ),
      item('This measurement used a separate reference for the comparison.', 50, 650, 510, 10)
    ].map((run) => ({ ...run, fontAscent: 0.69, fontDescent: -0.21, fontVertical: false }))
    const result = extract(runs)
    const owner = result.units.find((unit) => unit.items.includes('1:1'))
    expect(owner?.items.includes('1:2')).toBe(shape === 'wrapped')
    expect(owner?.items.includes('1:3')).toBe(shape === 'wrapped')
    expect(owner?.items.includes('1:4')).toBe(false)
    expectNativeOwnership(result, runs)
  }
)

it.each(['wrapped', 'unrelated field'])(
  'keeps the last word of a wrapped keyword taxonomy with its list (%s)',
  (shape) => {
    const runs = [
      item('Key words:', 42, 393, 47, 10, 'label', false),
      { ...item(' ', 89, 393, 6, 10, 'label', false), height: 0 },
      item(
        'methods: fitting – equipment: calibration – materials: sampling – controls: response' +
          (shape === 'wrapped' ? ' and' : ''),
        95,
        393,
        451,
        10
      ),
      item('uncertainty', 42, 405.5, 32, 10),
      item('1 INTRODUCTION', 42, 453, 80, 9, 'label'),
      item('In the following section we discuss the setup for the measurements.', 52, 467, 390, 9)
    ].map((run) => ({ ...run, fontAscent: 0.69, fontDescent: -0.21, fontVertical: false }))
    const result = extract(runs)
    const owner = result.units.find((unit) => unit.items.includes('1:2'))
    expect(owner?.items.includes('1:3')).toBe(shape === 'wrapped')
    expect(owner?.items.includes('1:4')).toBe(false)
    expectNativeOwnership(result, runs)
  }
)

it.each([true, false])(
  'joins a Roman-numbered title only on its native column center (%s)',
  (centered) => {
    const runs = [
      item('II.', 324, 600, 15, 9, 'heading', false),
      item(' ', 339, 600, 10, 9, 'heading', false),
      item('COMPARISON OF THE RESULTS WITH', 349, 600, 206, 9, 'heading'),
      item('MEASUREMENTS', centered ? 400 : 412, 610.5, 79, 9, 'heading', false),
      item('', 479, 610.5, 0, 9, 'heading'),
      item('During the final inspection we compared each measured range', 327, 636, 235, 10),
      item('with the predicted interval for the system.', 317, 647.5, 155, 10)
    ].map((run) => ({ ...run, fontVertical: false, fontAscent: 0.8, fontDescent: -0.2 }))
    const { units } = extract(runs)
    const title = units.find((unit) => unit.items.includes('1:0'))
    expect(title?.items.includes('1:3')).toBe(centered)
    if (centered) {
      expect(title?.source).toBe('II. COMPARISON OF THE RESULTS WITH MEASUREMENTS')
      expect(title?.fragments).toHaveLength(2)
    }
    expect(units.find((unit) => unit.items.includes('1:5'))?.items).toEqual(['1:5', '1:6'])
  }
)

it.each(['matching sequence', 'skipped number', 'different typeface', 'off center'])(
  'joins a series of two-line native Roman titles only with a shared heading layout (%s)',
  (fixture) => {
    const titles = [
      ['OPTICAL MAPPING OF THE', 'SAMPLE'],
      ['CALIBRATION AND MEASUREMENT', 'RANGE'],
      ['LIGHT SOURCES AND', 'DETECTORS']
    ]
    const items = titles
      .flatMap(([title, tail], index) => {
        const marks = ['I.', 'II.', fixture === 'skipped number' ? 'IV.' : 'III.']
        const y = 130 + 130 * index
        const fullWidth = index === 2 ? 160 : 206
        const start = (352 - fullWidth) / 2
        const markWidth = 7 + 4 * index
        const font = index === 2 && fixture === 'different typeface' ? 'alternate' : 'heading'
        return [
          item(marks[index], start, y, markWidth, 9, font, false),
          { ...item(' ', start + markWidth, y, 10, 9, font, false), height: 0 },
          item(title, start + markWidth + 10, y, fullWidth - markWidth - 10, 9, font),
          item(
            tail,
            index === 2 && fixture === 'off center' ? 156 : 149,
            y + 10.5,
            54,
            9,
            font,
            false
          ),
          item('', 203, y + 10.5, 0, 9, font),
          item('A stable reference measures the range of each sensor', 63, y + 37, 236, 10),
          item(
            'throughout the experiment with enough power to establish the baseline.',
            53,
            y + 48.5,
            244,
            10
          )
        ]
      })
      .map((run) => ({ ...run, fontVertical: false, fontAscent: 0.8, fontDescent: -0.2 }))
    const result = extract(items)
    for (const [index, [title, tail]] of titles.entries()) {
      const mark = index * 7
      const owner = result.units.find((u) => u.items.includes(`1:${mark}`))
      expect(owner?.items.includes(`1:${mark + 3}`)).toBe(fixture === 'matching sequence')
      if (fixture === 'matching sequence') {
        expect(owner?.source).toBe(`${'I'.repeat(index + 1)}. ${title} ${tail}`)
        expect(owner?.fragments).toHaveLength(2)
      }
      expect(result.units.find((u) => u.items.includes(`1:${mark + 5}`))?.items).toEqual([
        `1:${mark + 5}`,
        `1:${mark + 6}`
      ])
    }
    expectNativeOwnership(result, items)
  }
)
