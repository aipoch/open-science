import assert from 'node:assert/strict'
import { it as test } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from './pdf-translation-layout'

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  hasEOL = false,
  font = 10
): PdfLayoutTextItem => ({
  str,
  width,
  height: font,
  dir: 'ltr',
  hasEOL,
  transform: [font, 0, 0, font, x, 800 - y]
})

const extract = (
  items: PdfLayoutTextItem[]
): ReturnType<typeof groupPdfTranslationPages>['units'] =>
  groupPdfTranslationPages({
    pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }]
  }).units

const duration = (
  suffix = 'min) will be offered to participants.',
  x = 72.05,
  y = 112
): PdfLayoutTextItem[] => [
  item('Education sessions are designed for participants and last', 56, 100, 247.88, true),
  item('(40', 56, 112, 14.8),
  item(' ', 70.8, 112, 1.25),
  item(suffix, x, y, 210, true)
]

// Geometry follows BMJ e080239 p5: a number and its clinical duration unit
// occupy adjacent full-size native runs, with a closed parenthesis in prose.
test('a closed clinical duration stays in its full sentence', () => {
  const units = extract(duration())
  assert.ok(
    units.some(
      (unit) =>
        !unit.sourceOnly &&
        /Education sessions are designed for participants and last \(40 min\) will be offered/u.test(
          unit.source
        )
    ),
    JSON.stringify(units)
  )
})

test.each([
  { name: 'a neighboring column', x: 320 },
  { name: 'a different native baseline', y: 113 },
  { name: 'an unclosed duration', suffix: 'min will be offered to participants.' },
  { name: 'a duration defining an equation', suffix: 'min) where x denotes the elapsed variable.' },
  { name: 'a symbolic operand', suffix: 'x) will be used in this equation.' },
  { name: 'a multiplied expression', suffix: 'min * x) will be used in this equation.' },
  { name: 'a subtracted expression', suffix: 'min − x) will be used in this equation.' },
  { name: 'a numerical comparison', suffix: 'min < 50) will be used in this equation.' }
])('$name retains its duration/formula boundary', ({ suffix, x, y }) => {
  const units = extract(duration(suffix, x, y))
  assert.ok(
    !units.some((unit) => !unit.sourceOnly && /\(40 (?:min|x)/u.test(unit.source)),
    JSON.stringify(units)
  )
})

test('intervening native content prevents duration ownership', () => {
  const runs = duration()
  runs.splice(2, 0, item('Independent native caption.', 400, 200, 160, true))
  const units = extract(runs)
  assert.ok(
    !units.some((unit) => !unit.sourceOnly && /\(40 min\)/u.test(unit.source)),
    JSON.stringify(units)
  )
})

const timepoints = (
  lead = 'chemotherapy (T',
  suffix = '), after surgery (T',
  x = 120.35
): PdfLayoutTextItem[] => [
  item('Data will be captured across five timepoints:', 40, 100, 250, true),
  item('baseline (T0), mid-chemotherapy (T1), end of', 40, 112, 250, true),
  item(lead, 40, 124, 77.3),
  item(' ', 117.3, 124, 0.007),
  item('2', 117.307, 127.3301, 3.0316, true, 5.83),
  item(suffix, x, 124, 80.699),
  item('3', x + 80.7094, 127.3301, 3.0316, true, 5.83),
  item('), and at 6 months after completion.', x + 83.7409, 124, 180, true)
]

// This is a clinical timepoint enumeration, not a generic T-index formula.
// Subscript digits remain native-owned parts of their closed parentheticals.
test('closed clinical timepoints stay with their complete paragraph', () => {
  const units = extract(timepoints())
  assert.ok(
    units.some(
      (unit) =>
        !unit.sourceOnly &&
        /five timepoints/u.test(unit.source) &&
        /chemotherapy \(T2\), after surgery \(T3\)/u.test(unit.source)
    ),
    JSON.stringify(units)
  )
})

test.each([
  { name: 'a generic named function', lead: 'response (T' },
  { name: 'a variable definition', suffix: ') where T denotes the temperature (T' },
  { name: 'an unclosed index', suffix: ', after surgery (T' },
  { name: 'a neighboring-column close', x: 330 },
  { name: 'an added symbolic operand', suffix: ' + x), after surgery (T' }
])('$name does not inherit clinical timepoint ownership', ({ lead, suffix, x }) => {
  const units = extract(timepoints(lead, suffix, x))
  assert.ok(
    !units.some((unit) => !unit.sourceOnly && /(?:chemotherapy|response) \(T2/u.test(unit.source)),
    JSON.stringify(units)
  )
})

const acronym = (
  lead = '(RE-',
  tail = 'AIM) constructs have been incorporated.',
  x = 60.1,
  y = 112
): PdfLayoutTextItem[] => [
  item('The implementation framework includes measures', 40, 100, 248, true),
  item(lead, 40, 112, 20.1),
  item(tail, x, y, 240, true)
]

test('the known closed RE-AIM framework acronym stays with its clinical prose', () => {
  const units = extract(acronym())
  assert.ok(
    units.some(
      (unit) =>
        !unit.sourceOnly && /framework includes measures \(RE-AIM\) constructs/u.test(unit.source)
    ),
    JSON.stringify(units)
  )
})

test.each([
  {
    name: 'an ordinary uppercase subtraction',
    lead: '(AB-',
    tail: 'CD) constructs are calculated.'
  },
  { name: 'a known acronym in another column', x: 330 },
  { name: 'a known acronym on another baseline', y: 113 },
  { name: 'an unclosed known acronym', tail: 'AIM constructs have been incorporated.' },
  { name: 'a known acronym introducing a definition', tail: 'AIM) where x denotes its variable.' }
])('$name remains separated', ({ lead, tail, x, y }) => {
  const units = extract(acronym(lead, tail, x, y))
  assert.ok(
    !units.some((unit) => !unit.sourceOnly && /\((?:RE-AIM|AB-CD)/u.test(unit.source)),
    JSON.stringify(units)
  )
})

test('intervening native content prevents clinical timepoint ownership', () => {
  const runs = timepoints()
  runs.splice(5, 0, item('Independent caption.', 400, 220, 160, true))
  const units = extract(runs)
  assert.ok(
    !units.some((unit) => !unit.sourceOnly && /chemotherapy \(T2/u.test(unit.source)),
    JSON.stringify(units)
  )
})

test('an independently shifted closing run prevents clinical timepoint ownership', () => {
  const runs = timepoints()
  runs[5].transform[5] -= 1
  const units = extract(runs)
  assert.ok(
    !units.some((unit) => !unit.sourceOnly && /chemotherapy \(T2/u.test(unit.source)),
    JSON.stringify(units)
  )
})
