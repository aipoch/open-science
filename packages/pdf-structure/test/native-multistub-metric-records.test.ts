import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { readPdfFixture } from './read-fixture'
const { recoverNativeRepeatedMetricSourceGrid: prove } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-repeated-metric-grid.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { refineMeasuredAssignedNumericSegments, attachMeasuredTableSourceSegments } = await import(
  pathToFileURL(resolve('resources/literature-pdf-source-segments.mjs')).href
)
type Input = ReturnType<typeof JSON.parse>
const input = (): Input =>
  readPdfFixture('test/fixtures/source-grids/repeated-metrics-with-two-native-stubs.jsonl')
it('keeps every repeated metric leaf and independently fenced centered cohort', () => {
  const f = input(),
    before = JSON.stringify(f),
    p = prove(f.table, f.tokens, f.captions, f.rules, f.runs)
  expect(p?.columns).toHaveLength(6)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules, f.runs)
  expect(r.grid).toHaveLength(8)
  expect(r.grid[1].slice(2)).toEqual(['Rate', 'Score', 'Rate', 'Score'])
  expect(r.grid[2]).toEqual(['Cohort 0', 'Variant 0', '10', '11', '12', '13'])
  expect(r.grid[4]).toEqual(['', 'Variant 2', '3*', '19', '20', '21'])
  expect(
    r.cells.filter((c: Input) => c.column === 0 && c.row > 1).map((c: Input) => c.rowSpan)
  ).toEqual([3, 3])
  expect(r.unassigned).toEqual([])
  expect(JSON.stringify(f)).toBe(before)
  refineMeasuredAssignedNumericSegments(r, f.tokens, f.runs)
  attachMeasuredTableSourceSegments(r, f.tokens)
  const origins = r.cells.flatMap((c: Input) => c.sourceItems ?? []),
    segments = r.cells.flatMap((c: Input) => c.sourceSegments ?? [])
  expect(segments).toHaveLength(4)
  expect(new Set([...origins, ...segments].map((i: Input) => i.index)).size).toBe(
    JSON.parse(before).tokens.length
  )
  for (const i of JSON.parse(before).tokens) {
    const whole = origins.filter((o: Input) => o.index === i.sourceItem.index)
    const parts = segments
      .filter((o: Input) => o.index === i.sourceItem.index)
      .sort((a: Input, b: Input) => a.start - b.start)
    expect(
      (whole.length === 1 && parts.length === 0) || (whole.length === 0 && parts.length > 0)
    ).toBe(true)
    if (parts.length)
      expect(
        parts
          .map((s: Input) => s.text.slice(s.start, s.end))
          .join('')
          .replace(/\s/gu, '')
      ).toBe(i.text.replace(/\s/gu, ''))
  }
})

it.each<[string, (f: Input) => void]>([
  [
    'a missing native band fence',
    (f) => {
      f.rules = f.rules.filter((r: number[]) => r[1] !== 110)
    }
  ],
  [
    'a missing numeric leaf',
    (f) => {
      f.tokens = f.tokens.filter((i: Input) => i.text !== '35')
    }
  ],
  [
    'a foreign extra cohort',
    (f) => {
      const i = structuredClone(f.tokens.find((i: Input) => i.text === 'Cohort 0'))
      i.sourceItem.index = 1000
      f.tokens.push(i)
    }
  ],
  [
    'an off-center cohort',
    (f) => {
      const i = f.tokens.find((i: Input) => i.text === 'Cohort 0')
      i.rect[1] += 1
      i.rect[3] += 1
      i.baseline += 1
    }
  ],
  [
    'an inconsistent method sequence',
    (f) => {
      const i = f.tokens.find((i: Input) => i.text === 'Variant 0' && i.baseline > 110)
      i.text = i.sourceItem.text = 'Different'
    }
  ],
  [
    'a missing method',
    (f) => {
      f.tokens = f.tokens.filter((i: Input) => !(i.text === 'Variant 1' && i.baseline > 110))
    }
  ],
  [
    'an unproved fused header',
    (f) => {
      f.runs[0].glyphRuns[4] = 8
    }
  ],
  [
    'an unproved fused numeric record',
    (f) => {
      f.runs[1].glyphRuns[2] = 8
    }
  ],
  [
    'a header leaf mismatch',
    (f) => {
      const i = f.tokens.find((i: Input) => i.text === 'Rate')
      i.text = i.sourceItem.text = 'Different'
    }
  ],
  [
    'a contradictory native cohort divider',
    (f) => {
      f.rules.push([10, 85, 60, 85])
    }
  ],
  [
    'a source-original conflict',
    (f) => {
      f.tokens.find((i: Input) => i.text === 'Cohort 0').sourceItem.text = 'Different'
    }
  ],
  [
    'a foreign page original',
    (f) => {
      f.tokens.find((i: Input) => i.text === 'Cohort 0').sourceItem.pageNumber = 2
    }
  ],
  [
    'an unproved interior vertical stroke',
    (f) => {
      f.rules.push([55, 50, 55, 170])
    }
  ],
  [
    'a missing whole native source',
    (f) => {
      delete f.tokens.find((i: Input) => i.text === 'Cohort 0').sourceItem
    }
  ],
  [
    'an out-of-frame segment alias',
    (f) => {
      const s = f.tokens.find((i: Input) => i.text === 'Cohort 0').sourceItem
      f.tokens.push({
        text: 'Alias',
        rect: [400, 190, 420, 198],
        baseline: 198,
        height: 8,
        horizontal: true,
        sourceSegment: { ...s, start: 0, end: 3 }
      })
    }
  ],
  [
    'an out-of-frame nested owner',
    (f) => {
      const i = f.tokens.find((i: Input) => i.text === 'Cohort 0')
      f.tokens.push({
        text: 'Alias',
        rect: [400, 190, 420, 198],
        baseline: 198,
        height: 8,
        horizontal: true,
        sourceTokens: [structuredClone(i)]
      })
    }
  ],
  [
    'a quantitative leaf with arbitrary suffix',
    (f) => {
      const i = f.tokens.find((i: Input) => i.text === '3*')
      i.text = i.sourceItem.text = '3word'
    }
  ],
  [
    'a label crossing the native gutter',
    (f) => {
      f.tokens.find((i: Input) => i.text === 'Cohort 0').rect[2] = 85
    }
  ]
])('declines %s while preserving native input', (_name, mutate) => {
  const f = input()
  mutate(f)
  const before = JSON.stringify(f)
  expect(prove(f.table, f.tokens, f.captions, f.rules, f.runs)).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
