import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from './pdf-translation-layout'

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
