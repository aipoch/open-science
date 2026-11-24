import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'
import { readPdfTranslationCases } from '../fixtures/read-cases'

const fixture = readPdfTranslationCases<{ page: PdfLayoutPage }>(
  'wrapped-inline-expression-native.jsonl'
)[0]

it('keeps a wrapped inline expression in the sentence without losing its native fragments', () => {
  const { units } = groupPdfTranslationPages({ pages: [fixture.page] })
  expect(units).toHaveLength(1)
  expect(units[0]).toMatchObject({
    source:
      'Each value describes a distinct sampling position. Let each mapping be a linear projection (A z + c for some A and c). The result forms an estimate for the current sample under the conditions given in the example.',
    items: fixture.page.items.map((_, index) => `1:${index}`),
    originalStrings: fixture.page.items.map(({ str }) => str)
  })
  expect(units[0].fragments).toHaveLength(3)
  expect(units[0].preserve).toBeUndefined()
})

const controls: [string, (page: PdfLayoutPage) => void][] = [
  ['different opening face', ({ items }) => (items[1].fontName = 'foreign')],
  ['nonhorizontal expression', ({ items }) => (items[3].transform[1] = 0.4)],
  ['expression on a separate row', ({ items }) => (items[3].transform[5] += 6)],
  [
    'open parentheses',
    ({ items }) => (items[9].str = '. The result supports the current estimate')
  ],
  ['broken return rail', ({ items }) => (items[10].transform[4] += 5)],
  ['different right edge', ({ items }) => (items[9].width -= 7)]
]

it.each(controls)('does not join without continuous native body evidence: %s', (_, change) => {
  const page = structuredClone(fixture.page)
  change(page)
  const { units } = groupPdfTranslationPages({ pages: [page] })
  expect(units.some((unit) => unit.items.includes('1:0') && unit.items.includes('1:10'))).toBe(
    false
  )
})

it.each([false, true])(
  'keeps a wrapped function call with a native predicate, raised=%s',
  (raised) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Body',
      hasEOL = false
    ): PdfLayoutPage['items'][number] => ({
      str,
      dir: 'ltr',
      width,
      height: 10,
      transform: [10, 0, 0, 10, x, y],
      fontName,
      fontAscent: 0.75,
      fontDescent: -0.25,
      fontVertical: false,
      hasEOL
    })
    const lead =
      'The preceding result applies. We next find another expression for the power series'
    const body =
      ') appearing there. The resulting identity contains no additional coefficient multiplying the free parameter'
    const items = [
      item(lead, 82, 743, 442, 'Body', true),
      item('S', 70, 731 + (raised ? 2 : 0), 6, 'Math'),
      item('(', 78, 731, 4),
      item('u, w', 82, 731, 15, 'Math'),
      item(body, 97, 731, 378),
      item('w', 479, 731, 5, 'Math'),
      item('.', 484, 731, 3, 'Body', true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const unit = units.find((candidate) => candidate.items.includes('1:0'))
    expect(unit).toBeDefined()
    if (raised) {
      expect(unit?.items).not.toContain('1:4')
      return
    }
    expect(unit?.source).toBe(`${lead} S (u, w${body} w.`)
    expect(unit?.items).toEqual(items.map((_, i) => `1:${i}`))
    expect(unit?.fragments).toHaveLength(3)
  }
)

it.each([false, true])(
  'keeps matching congruence operands across a native row wrap, raised=%s',
  (raised) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Body',
      hasEOL = false,
      height = 11
    ): PdfLayoutPage['items'][number] => ({
      str,
      dir: 'ltr',
      width,
      height,
      transform: [height, 0, 0, height, x, y],
      fontName,
      fontAscent: 0.75,
      fontDescent: -0.2,
      fontVertical: false,
      hasEOL
    })
    const lead = 'Applying the previous identity gives residues congruent to',
      second = 'modulo seven. The resulting counts fall within the intervals'
    const items = [
      item(lead, 142, 689, 309),
      item('7', 454, 689, 5.5, 'Numbers'),
      item('−', 462, 689, 8.5, 'Operator'),
      item('z', 473, 689, 4, 'Variables'),
      item('and', 481, 689, 18, 'Body', true),
      item('5', 96, 676, 5.5, 'Numbers'),
      item('−', 104, 676, 8.5, 'Operator'),
      item('q', 115, 676, 5.7, 'Variables'),
      item('2', 121, raised ? 677 : 674.4, 4.2, 'Script', false, 8),
      item(second, 130, 676, 216),
      item('[1, 3]', 350, 676, 22, 'Numbers'),
      item('and', 376, 676, 18),
      item('[4, 6]', 398, 676, 22, 'Numbers'),
      item(', respectively, so', 420, 676, 79, 'Body', true),
      item(
        'each interval describes a different class of possible outcomes for a trial.',
        96,
        663,
        403,
        'Body',
        true
      ),
      item(
        'The estimate can then be compared with observed results in the sample.',
        96,
        650,
        403,
        'Body',
        true
      ),
      item(
        'When both intervals are empty, no representative is returned.',
        96,
        637,
        319,
        'Body',
        true
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const owner = units.find((unit) => unit.items.includes('1:0'))
    expect(owner).toBeDefined()
    if (raised) {
      expect(owner?.items).not.toContain('1:9')
      return
    }
    expect(owner?.source).toContain(`${lead} 7 − z and 5 − q2 ${second}`)
    expect(owner?.items).toEqual(items.map((_, index) => `1:${index}`))
    expect(owner?.fragments).toHaveLength(3)
  }
)

it.each([false, true])(
  'keeps a wrapped lower bound with its prose before a display (detached=%s)',
  (detached) => {
    const run = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Body',
      height = 10.5,
      hasEOL = false
    ): PdfLayoutPage['items'][number] => ({
      str,
      width,
      height,
      fontName,
      dir: 'ltr',
      fontAscent: 0.72,
      fontDescent: -0.2,
      fontVertical: false,
      hasEOL,
      transform: [height, 0, 0, height, x, y]
    })
    const end = run('', 0, 0, 0, 'Body', 0, true)
    const items = [
      run('applies to each index', 110, 232, 85),
      run('k', 198, 232, 5, 'Variable', 11),
      run('≥', 206, 232, 8, 'Relation', 11),
      run('2', 217, 232, 5, 'Number', 11),
      run('. A direct check from the definition of the sequence gives', 222, 232, 187),
      run('p', 412, 232, 5, 'Variable', 11),
      run('(2) = 3', 417, 232, 32, 'Number', 11),
      run('. For', 449, 232, 20),
      end,
      run('k', detached ? 118 : 110, 220, 6, 'Variable', 11),
      run('≥', detached ? 127 : 119, 220, 8, 'Relation', 11),
      run('4', detached ? 138 : 130, 220, 5, 'Number', 11),
      run(', factoring gives', detached ? 143 : 135, 220, 94),
      end,
      run('p', 188, 189, 5, 'Variable', 11),
      run('(k) = 3', 193, 189, 31, 'Number', 11),
      run('(1)', 449, 189, 12, 'Number', 11)
    ]
    const { units, pages } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const head = units.find((unit) => unit.items.includes('1:7'))
    if (detached) {
      expect(head?.items).not.toContain('1:12')
      return
    }
    expect(head).toMatchObject({
      source:
        'applies to each index k ≥ 2. A direct check from the definition of the sequence gives p(2) = 3. For k ≥ 4, factoring gives',
      items: ['1:0', '1:1', '1:2', '1:3', '1:4', '1:5', '1:6', '1:7', '1:9', '1:10', '1:11', '1:12']
    })
    const block = pages[0].blocks.find((block) => block.items.includes('1:7'))
    expect(block?.lines.map(({ items }) => items)).toEqual([
      ['1:0', '1:1', '1:2', '1:3', '1:4', '1:5', '1:6', '1:7'],
      ['1:9', '1:10', '1:11', '1:12']
    ])
    expect(units.find((unit) => unit.items.includes('1:14'))?.sourceOnly).toBe(true)
  }
)

it.each([false, true])('keeps the period with the inline set it ends (gap=%s)', (gap) => {
  const run = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName = 'Body',
    height = 11,
    hasEOL = false
  ): PdfLayoutPage['items'][number] => ({
    str,
    width,
    height,
    fontName,
    dir: 'ltr',
    fontAscent: 0.72,
    fontDescent: -0.22,
    fontVertical: false,
    hasEOL,
    transform: [height, 0, 0, height, x, y]
  })
  const first = 'where [m] = {3, . . . , m}'
  const next = '. Hence we estimate each grouping within'
  const items = [
    run('where', 84, 319, 28),
    run('[', 116, 319, 3, 'Symbol'),
    run('m', 119, 319, 7, 'Variable'),
    run('] =', 126, 319, 15, 'Symbol'),
    run('{', 145, 319, 5.5, 'Symbol'),
    run('3', 150.5, 319, 5.5, 'Number'),
    run(', . . . , m', 156, 319, 31, 'Variable'),
    run('}', 187, 319, 5.5, 'Symbol'),
    run(next, gap ? 195 : 192.5, 319, 222),
    run('A', 418, 319, 8.5, 'Variable'),
    run('m', 426.5, 317.2, 5.5, 'Index', 8),
    run(', and record the changes', 432, 319, 96, 'Body', 11, true),
    run(
      'relative to the previous estimate for each category in the sample',
      84,
      306,
      444,
      'Body',
      11,
      true
    ),
    run('according to the declared rule.', 84, 293, 154)
  ]
  const { units, pages } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
  })
  const owner = units.find((unit) => unit.items.includes('1:0'))
  if (gap) {
    expect(owner?.source).toBe(first)
    expect(owner?.items).not.toContain('1:8')
    return
  }
  expect(owner?.source).toBe(
    first +
      next +
      ' Am, and record the changes relative to the previous estimate for each category in the sample according to the declared rule.'
  )
  expect(owner?.items).toEqual(items.map((_, index) => `1:${index}`))
  const block = pages[0].blocks.find((candidate) => candidate.id === owner?.fragments[0].id)
  expect(block?.lines.map((line) => line.items.length)).toEqual([12, 1, 1])
})

it.each(['aligned', 'shifted row', 'different argument'] as const)(
  'keeps a coordinated function declaration across a native body wrap: %s',
  (shape) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Body',
      hasEOL = false
    ): PdfLayoutPage['items'][number] => ({
      str,
      dir: 'ltr',
      width,
      height: 10,
      transform: [10, 0, 0, 10, x, y],
      fontName,
      fontAscent: 0.76,
      fontDescent: -0.24,
      fontVertical: false,
      hasEOL
    })
    const shift = shape === 'shifted row' ? 4 : 0
    const secondRow = (
      str: string,
      x: number,
      width: number,
      face?: string,
      eol?: boolean
    ): PdfLayoutPage['items'][number] => item(str, x + shift, 637, width, face, eol)
    const argument = shape === 'different argument' ? 'R' : 'Q'
    const items = [
      item(
        'We describe methods used to validate repeated observations. For a sample',
        80,
        650,
        350
      ),
      item('Q', 433, 650, 7, 'Math'),
      item(', let', 440, 650, 14),
      item('F', 458, 650, 7, 'Math'),
      item('(', 467, 650, 4, 'Delimiter'),
      item('Q', 471, 650, 7, 'Math'),
      item(')', 478, 650, 4, 'Delimiter', true),
      secondRow('and', 80, 17),
      secondRow('H', 100, 7, 'Math'),
      secondRow('(', 107, 4, 'Delimiter'),
      secondRow(argument, 111, 7, 'Math'),
      secondRow(')', 118, 4, 'Delimiter'),
      secondRow('respectively denote the measured value and the estimated value of', 125, 288),
      secondRow('Q', 416, 7, 'Math'),
      secondRow('.', 423, 3, 'Body', true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const lead = units.find((unit) => unit.items.includes('1:0'))
    expect(units.flatMap((unit) => unit.items)).toEqual(items.map((_, index) => `1:${index}`))
    if (shape === 'aligned') {
      expect(units).toHaveLength(1)
      expect(lead?.source).toContain('and H(Q) respectively denote')
      expect(lead?.sourceOnly).not.toBe(true)
    } else {
      expect(lead?.items).not.toContain('1:12')
    }
  }
)

it.each([0, 4])('retains a wrapped dimension in its body paragraph (offset=%s)', (offset) => {
  const item = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName = 'Body',
    hasEOL = false
  ): PdfLayoutPage['items'][number] => ({
    str,
    width,
    height: 10,
    dir: 'ltr',
    fontName,
    hasEOL,
    fontVertical: false,
    fontAscent: 0.79,
    fontDescent: -0.21,
    transform: [10, 0, 0, 10, x, y]
  })
  const items = [
    item(
      'A reference path contains each sample in the interior of the',
      72,
      690,
      468,
      'Body',
      true
    ),
    item('central (', 72 + offset, 677.5, 33),
    item('q', 105 + offset, 677.5, 6, 'Variable'),
    item('−', 113 + offset, 677.5, 7, 'Operator'),
    item(
      '3)-cube. Each trial follows the original sequence, and then it',
      122 + offset,
      677.5,
      418,
      'Body',
      true
    ),
    item('ends with a short comparison across the recorded samples.', 72, 665, 320, 'Body', true)
  ]
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
  })
  expect(units.flatMap((unit) => unit.items)).toEqual(items.map((_, index) => `1:${index}`))
  if (offset) {
    expect(units.find((unit) => unit.source === 'central (q −')?.sourceOnly).toBe(true)
  } else {
    expect(units.map((unit) => unit.source)).toEqual([
      'A reference path contains each sample in the interior of the central (q − 3)-cube. Each trial follows the original sequence, and then it ends with a short comparison across the recorded samples.'
    ])
    expect(units[0].sourceOnly).toBeUndefined()
  }
})
