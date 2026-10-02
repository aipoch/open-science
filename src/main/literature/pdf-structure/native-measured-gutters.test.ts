import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { recoverNativeMeasuredGutterTokens } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-measured-gutters.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (
  name = 'native-identifier-and-first-measurement-with-tj-gutter'
): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
const recover = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  recoverNativeMeasuredGutterTokens(f.table, f.tokens, f.captions, f.rules, f.runs)

it('assigns the first scalar from its measured native gap without splitting an identifier', () => {
  const f = fixture(),
    original = structuredClone(f)
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules, f.runs)
  expect(result.grid.slice(1).map((row: string[]) => row.slice(0, 2))).toEqual([
    ['RecordA', '3.14'],
    ['RecordB', '2.71'],
    ['RecordC', '3.18']
  ])
  expect(result.unassigned).toEqual([])
  expect(f).toEqual(original)
})
it('keeps both interval delimiters in their own fields across a font-fragment boundary', () => {
  const f = fixture('native-square-interval-boundary-in-one-tj-run')
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules, f.runs)
  expect(result.grid[1]).toEqual(['RecordA', '[−0.2,+0.4]', '[−0.6,+0.8]'])
  expect(result.unassigned).toEqual([])
})
it.each(['caption', 'closing', 'header', 'gap', 'run', 'extent', 'peer', 'missing-value'])(
  'requires complete original gutter and peer evidence: %s',
  (change) => {
    const f = fixture()
    if (change === 'caption') f.captions = []
    if (change === 'closing') f.rules.pop()
    if (change === 'header') f.tokens.splice(2, 1)
    if (change === 'gap') f.runs[0].gaps[0].left = f.runs[0].gaps[0].right - 1
    if (change === 'run') f.runs[0].glyphRuns[0]++
    if (change === 'extent') f.runs[0].rect[0]++
    if (change === 'peer')
      f.tokens = f.tokens.filter((t: { baseline: number }) => t.baseline !== 80)
    if (change === 'missing-value')
      f.tokens.splice(
        f.tokens.findIndex((t: { text: string }) => t.text === '0.11'),
        1
      )
    expect(recover(f)).toBe(f.tokens)
  }
)
