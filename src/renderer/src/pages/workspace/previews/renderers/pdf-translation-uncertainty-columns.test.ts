import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from './pdf-translation-layout'

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  font = 8,
  fontName = 'table',
  hasEOL = false
): PdfLayoutTextItem => ({
  str,
  width,
  height: font,
  dir: 'ltr',
  fontName,
  hasEOL,
  transform: [font, 0, 0, font, x, 800 - y]
})

const measuredTable = (): PdfLayoutTextItem[] => [
  ...[100, 124, 148].flatMap((y, index) => [
    item(`Measured row ${index}`, 50, y, 65, 8, 'table', true),
    item('118.5', 128.9, y, 17),
    item('±', 146.9, y, 4.8),
    item('14.3', 152.7, y, 13.1),
    item('115.9', 174.2, y, 17),
    item('±', 192.2, y, 4.8),
    item('17.4', 198, y, 13.1),
    item('0.722', 221, y, 17),
    item('0.472', 264, y, 17, 8, 'table', true)
  ]),
  ...[100, 124, 148].map((y) =>
    item(
      'A separate neighboring paragraph has a larger native type size.',
      305,
      y,
      235,
      10,
      'body',
      true
    )
  )
]

const extract = (items: PdfLayoutTextItem[]): ReturnType<typeof groupPdfTranslationPages> =>
  groupPdfTranslationPages({ pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }] })

it('does not turn the right operand of a native uncertainty statistic into a table column', () => {
  const items = measuredTable(),
    result = extract(items)
  for (const text of ['118.5 ± 14.3', '115.9 ± 17.4']) {
    const cells = result.units.filter((unit) => unit.source === text)
    expect(cells).toHaveLength(3)
    expect(cells.every((cell) => cell.sourceOnly && cell.items.length === 3)).toBe(true)
  }
  expect(result.units.some((unit) => unit.source.includes('14.3 115.9'))).toBe(false)
  expect(result.units.filter((unit) => unit.source === '0.722')).toHaveLength(3)
  expect(result.units.filter((unit) => unit.source === '0.472')).toHaveLength(3)
  const owned = result.units.flatMap((unit) => unit.items)
  expect(owned).toHaveLength(items.length)
  expect(new Set(owned).size).toBe(items.length)
})

it('keeps genuine dense numeric columns independent when no uncertainty sign connects them', () => {
  const items = measuredTable().filter((run) => run.str !== '±'),
    result = extract(items)
  expect(result.units.filter((unit) => unit.source === '14.3')).toHaveLength(3)
  expect(result.units.filter((unit) => unit.source === '17.4')).toHaveLength(3)
  expect(result.units.some((unit) => unit.source.includes('118.5 14.3'))).toBe(false)
})

it.each([
  {
    name: 'a different native sign font',
    change: (run: PdfLayoutTextItem) => ({ ...run, fontName: 'foreign' })
  },
  { name: 'a new native line', change: (run: PdfLayoutTextItem) => ({ ...run, hasEOL: true }) },
  {
    name: 'a different native sign size',
    change: (run: PdfLayoutTextItem) => ({
      ...run,
      transform: [9, 0, 0, 9, ...run.transform.slice(4)]
    })
  }
])('does not borrow the neighboring number through $name', ({ change }) => {
  const items = measuredTable().map((run) => (run.str === '±' ? change(run) : run)),
    result = extract(items)
  expect(result.units.filter((unit) => unit.source === '14.3')).toHaveLength(3)
  expect(result.units.filter((unit) => unit.source === '17.4')).toHaveLength(3)
  expect(result.units.some((unit) => unit.source === '118.5 ± 14.3')).toBe(false)
})

const wrappedDescriptor = (): PdfLayoutTextItem[] => {
  const items = measuredTable()
  // The broken row cannot itself prove a complete frame. Three other records
  // independently establish the repeated measured columns.
  items.splice(
    27,
    0,
    ...items.slice(0, 9).map((run) => ({
      ...run,
      transform: [...run.transform.slice(0, 5), 628]
    }))
  )
  items.splice(
    0,
    1,
    item('Measure of dependen', 50, 100, 69.9),
    item('-', 120.1, 100, 2.4),
    item('ce (min)', 50, 112, 26.8, 8, 'table', true)
  )
  return items
}

it('preserves a separately painted word-end hyphen and the measured descriptor wrap', () => {
  const items = wrappedDescriptor(),
    result = extract(items),
    label = result.units.find((unit) => unit.source === 'Measure of dependen-ce (min)')
  expect(label).toBeDefined()
  expect(label?.sourceOnly).not.toBe(true)
  expect(label?.items).toEqual(['1:0', '1:1', '1:2'])
  expect(result.units.filter((unit) => unit.source === '118.5 ± 14.3')).toHaveLength(4)
  expect(result.units.flatMap((unit) => unit.items)).toHaveLength(items.length)
  expect(new Set(result.units.flatMap((unit) => unit.items)).size).toBe(items.length)
})

it.each([
  {
    name: 'a different descriptor font',
    change: (run: PdfLayoutTextItem) => ({ ...run, fontName: 'foreign' })
  },
  {
    name: 'a symbolic continuation',
    change: (run: PdfLayoutTextItem) => ({ ...run, str: 'x = y (min)' })
  },
  {
    name: 'a separate column',
    change: (run: PdfLayoutTextItem) => ({ ...run, transform: [8, 0, 0, 8, 174, 688] })
  },
  {
    name: 'the next independent measured row',
    change: (run: PdfLayoutTextItem) => ({ ...run, transform: [8, 0, 0, 8, 50, 676] })
  }
])('does not join a separately painted hyphen through $name', ({ change }) => {
  const items = wrappedDescriptor()
  items[2] = change(items[2])
  expect(extract(items).units.some((unit) => unit.source === 'Measure of dependen-ce (min)')).toBe(
    false
  )
})

it('intervening native content cannot be skipped to recover a broken table descriptor', () => {
  const items = wrappedDescriptor()
  items.splice(2, 0, item('Independent caption.', 350, 220, 80, 8, 'caption', true))
  expect(extract(items).units.some((unit) => unit.source === 'Measure of dependen-ce (min)')).toBe(
    false
  )
})

it('admits complete percentage descriptors in a proven table instead of treating them as functions', () => {
  const names = ['Mastectomy (%)', 'Tumorectory (%)', 'Radiotherapy (%)'],
    items = measuredTable().map((run, index) =>
      index < 27 && index % 9 === 0 ? { ...run, str: names[index / 9] } : run
    ),
    result = extract(items)
  for (const name of names) {
    const cell = result.units.find((unit) => unit.source === name)
    expect(cell).toBeDefined()
    expect(cell?.sourceOnly).not.toBe(true)
    expect(cell?.items).toHaveLength(1)
  }
})

it.each([
  'A (%)',
  'M (SD)',
  'Sin (%)',
  'Softmax (%)',
  'sigmoid (%)',
  'Mean (%) = 2',
  'α (%)',
  '\u0015'
])('keeps a literal mathematical table label readonly: %s', (name) => {
  const items = measuredTable().map((run, index) =>
      index < 27 && index % 9 === 0 ? { ...run, str: name } : run
    ),
    result = extract(items)
  expect(result.units.filter((unit) => unit.source === name)).toHaveLength(3)
  expect(result.units.filter((unit) => unit.source === name).every((unit) => unit.sourceOnly)).toBe(
    true
  )
})

it('a percentage argument outside a proven table remains mathematical text', () => {
  const result = extract([item('Mastectomy (%)', 50, 100, 65, 8, 'body', true)])
  expect(result.units[0].sourceOnly).toBe(true)
})

it('split percentage-shaped native runs do not gain the single-run descriptor proof', () => {
  const items = measuredTable()
  items.splice(0, 1, item('Mastectomy', 50, 100, 45), item('(%)', 97, 100, 16, 8, 'table', true))
  const result = extract(items)
  expect(result.units.some((unit) => unit.source === 'Mastectomy (%)' && unit.sourceOnly)).toBe(
    true
  )
})
