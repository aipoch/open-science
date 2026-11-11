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
  'body-sized',
  'foreign-font',
  'off-center',
  'native-interruption',
  'terminal'
])(
  'a modestly enlarged first native title retains only its centered lowercase wrap: %s',
  (fault) => {
    const runs = [
      item('General physical behavior in highly asymmetric coupled', 50, 62, 500, 12, 'title'),
      item('systems under controlled interactions', 150, 76, 300, 12, 'title'),
      item('Independent Author', 220, 103, 160, 10, 'author'),
      ...[160, 172, 184, 196].map((y) =>
        item('Ordinary body text establishes the measured native font size.', 50, y, 240, 10)
      )
    ]
    if (fault === 'body-sized')
      for (const run of runs.slice(0, 2)) {
        run.height = 10
        run.transform[0] = 10
        run.transform[3] = 10
      }
    if (fault === 'foreign-font') runs[1].fontName = 'foreign'
    if (fault === 'off-center') runs[1].transform[4] += 20
    if (fault === 'terminal') runs[0].str += '.'
    if (fault === 'native-interruption') runs.splice(1, 0, item('Separate note.', 400, 300, 90))
    const result = extract(runs),
      owner = result.units.find((unit) => unit.items.includes('1:0'))!
    expect(owner.items.includes(fault === 'native-interruption' ? '1:2' : '1:1')).toBe(
      fault === 'complete'
    )
    expect(owner.source).not.toContain('Independent Author')
    expectNativeOwnership(result, runs)
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
