import assert from 'node:assert/strict'
import { it as test } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from './pdf-translation-layout'

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  fontName = 'body',
  font = 9,
  hasEOL = false
): PdfLayoutTextItem => ({
  str,
  width,
  height: font,
  fontName,
  hasEOL,
  dir: 'ltr',
  transform: [font, 0, 0, font, x, 800 - y]
})
const extract = (
  items: PdfLayoutTextItem[]
): ReturnType<typeof groupPdfTranslationPages>['pages'][number]['blocks'] =>
  groupPdfTranslationPages({ pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }] })
    .pages[0].blocks

// BMJ Table 2 uses a 9pt label font, adjacent 10.8pt wrap baselines,
// and checkmarks lowered by 0.954pt. Sparse rows select different columns.
const schedule = (header = true, drift = 0, labelFont = 9): PdfLayoutTextItem[] => [
  ...(header
    ? [
        item('Measure', 44.5, 75, 37.17, 'header'),
        item('Screening', 161.5, 75, 43.17, 'header'),
        item('Baseline', 213.5, 75, 40.31, 'header'),
        item('During treatment', 266.5, 75, 56.17, 'header'),
        item('Post-treatment', 331.5, 75, 48.17, 'header'),
        item('Post-surgery', 389.5, 75, 58.18, 'header'),
        item('Follow-up', 501.5, 75, 42.8, 'header')
      ]
    : []),
  item('Activity', 53.46, 100, 32, 'body', labelFont, true),
  item('Questionnaire', 53.46, 110.8, 60, 'body', labelFont),
  item('✓', 213.47 + drift, 100.954, 9, 'marks'),
  item('✓', 331.46 + drift, 100.954, 9, 'marks'),
  item('✓', 501.47 + drift, 100.954, 9, 'marks'),
  item('Programme satisfaction:', 53.46, 125.227, 98.02, 'body', labelFont, true),
  item('HeiQ (Domain 9)', 53.46, 136.027, 65.85, 'body', labelFont),
  item('✓', 331.46 + drift, 126.181, 9, 'marks'),
  item('Self-efficacy: CBI-B', 53.46, 150.454, 79.5, 'body', labelFont),
  item('✓', 213.47 + drift, 151.408, 9, 'marks'),
  item('✓', 331.46 + drift, 151.408, 9, 'marks'),
  item('✓', 501.47 + drift, 151.408, 9, 'marks')
]

const assertCells = (blocks: ReturnType<typeof extract>): void => {
  for (const source of [
    'Activity Questionnaire',
    'Programme satisfaction: HeiQ (Domain 9)',
    'Self-efficacy: CBI-B'
  ]) {
    assert.ok(
      blocks.some((block) => !block.sourceOnly && block.tableCell && block.source === source),
      JSON.stringify(blocks)
    )
  }
  assert.ok(
    !blocks.some((block) => /Questionnaire Programme|Domain 9\) Self/u.test(block.source)),
    JSON.stringify(blocks)
  )
}

test('a proven schedule keeps a sparse single-check record and its wraps independent', () => {
  assertCells(extract(schedule()))
})

test('a continued schedule allows long label wraps between sparse record starts', () => {
  const items = schedule()
  const start = items.findIndex((run) => run.str === 'Activity')
  for (const run of items.slice(start + 5)) run.transform[5] -= 43.2
  items.splice(
    start,
    2,
    item('Cardio-metabolic', 53.46, 100, 78, 'body', 9, true),
    item('markers (fasting glucose,', 53.46, 110.8, 100, 'body', 9, true),
    item('HbA1c, fasting serum', 53.46, 121.6, 90, 'body', 9, true),
    item('insulin, triglycerides,', 53.46, 132.4, 95, 'body', 9, true),
    item('Chol, HDL, LDL, thyroid)', 53.46, 143.2, 100)
  )
  // Restore the first record's marks, which were serialized after its wraps.
  const marks = items.filter((run) => run.str === '✓').slice(0, 3)
  for (const mark of marks) mark.transform[5] = 800 - 100.954
  const blocks = extract(items)
  assert.ok(
    blocks.some(
      (block) =>
        block.tableCell &&
        block.source.startsWith('Cardio-metabolic markers') &&
        block.source.endsWith('thyroid)') &&
        !/Programme/u.test(block.source)
    ),
    JSON.stringify(blocks)
  )
  assert.ok(
    blocks.some(
      (block) => block.tableCell && block.source === 'Programme satisfaction: HeiQ (Domain 9)'
    ),
    JSON.stringify(blocks)
  )
})

test.each([
  { name: 'no header frame', header: false },
  { name: 'drifting check columns', drift: 12 },
  { name: 'a mismatched label font', labelFont: 10 }
])('$name does not acquire schedule cell ownership', ({ header, drift, labelFont }) => {
  const blocks = extract(schedule(header, drift, labelFont))
  assert.ok(
    !blocks.some(
      (block) => block.source === 'Programme satisfaction: HeiQ (Domain 9)' && block.tableCell
    ),
    JSON.stringify(blocks)
  )
})

test('a two-record checklist cannot establish a schedule', () => {
  const runs = schedule().filter((run) => run.transform[5] > 800 - 145)
  const blocks = extract(runs)
  assert.ok(
    !blocks.some(
      (block) => block.source === 'Programme satisfaction: HeiQ (Domain 9)' && block.tableCell
    ),
    JSON.stringify(blocks)
  )
})

test('an outdented section starts outside the preceding schedule cell', () => {
  const runs = schedule()
  runs.push(
    item('Safety and adverse events', 44.46, 175.68, 115, 'header'),
    item('Adverse events', 53.46, 190.11, 65),
    item('Collected throughout the intervention', 266.46, 190.11, 180)
  )
  const blocks = extract(runs)
  assertCells(blocks)
  assert.ok(
    !blocks.some((block) => /CBI-B Safety|CBI-B Adverse/u.test(block.source)),
    JSON.stringify(blocks)
  )
})

test('an independent prose column beside a sparse row is not its label continuation', () => {
  const runs = schedule()
  runs.push(item('Independent neighboring paragraph.', 380, 136.027, 180, 'other', 10, true))
  const blocks = extract(runs)
  assert.ok(
    !blocks.some((block) => /satisfaction:.*Independent|Independent.*Domain 9/u.test(block.source)),
    JSON.stringify(blocks)
  )
  assert.ok(
    blocks.some(
      (block) => block.source === 'Independent neighboring paragraph.' && !block.tableCell
    ),
    JSON.stringify(blocks)
  )
})

test('shifted mark baselines do not supply record identity', () => {
  const runs = schedule()
  for (const run of runs.filter((run) => run.str === '✓')) run.transform[5] -= 2.5
  const blocks = extract(runs)
  assert.ok(
    !blocks.some(
      (block) => block.source === 'Programme satisfaction: HeiQ (Domain 9)' && block.tableCell
    ),
    JSON.stringify(blocks)
  )
})

test('only two measured check columns cannot establish a sparse schedule', () => {
  const runs = schedule().filter((run) => !(run.str === '✓' && run.transform[4] > 400))
  const blocks = extract(runs)
  assert.ok(
    !blocks.some(
      (block) => block.source === 'Programme satisfaction: HeiQ (Domain 9)' && block.tableCell
    ),
    JSON.stringify(blocks)
  )
})

test('an unmarked following native row cannot become the last record wrap', () => {
  const runs = schedule()
  runs.push(item('Independent unmarked row', 53.46, 161.254, 100))
  const blocks = extract(runs)
  assertCells(blocks)
  assert.ok(
    !blocks.some((block) => /CBI-B Independent/u.test(block.source)),
    JSON.stringify(blocks)
  )
})
