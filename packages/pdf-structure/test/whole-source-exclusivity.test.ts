import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { resolve } from './paths'

const { wholeSourceExclusivityFixture: fixture, measuredSourcePartitions: partition } =
  await import(pathToFileURL(resolve('test/fixtures/whole-source-exclusivity.mjs')).href)
const {
  nativeTableSourceConflicts: conflicts,
  reviewNativeTableSources: earlyReview,
  reviewFinalNativeTableSources: review
} = await import(pathToFileURL(resolve('resources/literature-pdf-table-source-integrity.mjs')).href)
const { attachMeasuredTableSourceSegments: attachSegments } = await import(
  pathToFileURL(resolve('resources/literature-pdf-source-segments.mjs')).href
)
const marker = 'native-whole-source-claimed-by-multiple-cells'

it('rejects two cell claims of one whole native source despite partial cell rectangles', () => {
  const f = fixture(),
    before = JSON.stringify(f)
  assert(conflicts(f.table, f.tokens).includes(marker))
  const out = review(f.table, f.tokens, [], [], undefined)
  assert(out.issues.includes('native-table-structure-ambiguous'))
  assert.equal(out.reviewCandidate, false)
  for (const name of ['cells', 'grid', 'cropRect', 'thumbnail', 'notes'])
    assert.equal(out[name], f.table[name])
  assert.equal(JSON.stringify(f), before)
})

it('rejects a whole source claimed beside a measured portion of that same source', () => {
  const f = partition(fixture())
  f.table.cells[0].sourceItems = [f.token.sourceItem]
  delete f.table.cells[0].sourceSegments
  assert(conflicts(f.table, f.tokens).includes(marker))
})

it('keeps two explicit measured source partitions', () => {
  const f = partition(fixture())
  assert(!conflicts(f.table, f.tokens).includes(marker))
})

it('defers candidate whole-source overlap until measured ranges are attached at final assembly', () => {
  const f = fixture(),
    tokens = f.table.cells.map((cell: ReturnType<typeof JSON.parse>, i: number) => {
      const token = {
        text: cell.text,
        rect: cell.sourceRects[0],
        baseline: 30,
        height: 10,
        sourceSegment: {
          ...f.token.sourceItem,
          start: i ? 3 : 0,
          end: i ? 4 : 2,
          rect: cell.sourceRects[0]
        }
      }
      cell.sourceTokens = [{ text: token.text, rect: token.rect, baseline: 30, height: 10 }]
      return token
    }),
    candidate = earlyReview(f.table, f.tokens)
  attachSegments(candidate, tokens)
  assert(candidate.cells.every((cell: ReturnType<typeof JSON.parse>) => cell.sourceSegments))
  const final = review(candidate, f.tokens, [], [], undefined)
  assert(!final.issues.includes('native-table-structure-ambiguous'))
  assert.equal(final.cells, f.table.cells)
  assert.deepEqual(
    final.cells.flatMap((cell: ReturnType<typeof JSON.parse>) => cell.sourceSegments),
    [
      { ...f.token.sourceItem, start: 0, end: 2, rect: [20, 20, 40, 30] },
      { ...f.token.sourceItem, start: 3, end: 4, rect: [50, 20, 60, 30] }
    ]
  )
})

it('still rejects a whole-source overlap that remains after final assembly', () => {
  const f = fixture(),
    candidate = earlyReview(f.table, f.tokens)
  attachSegments(candidate, f.tokens)
  const final = review(candidate, f.tokens, [], [], undefined)
  assert(final.issues.includes('native-table-structure-ambiguous'))
})

it.each([
  'distinct origin',
  'different page',
  'missing native',
  'duplicate native',
  'different literal',
  'non-finite height',
  'zero height',
  'non-finite baseline'
])('does not infer the ownership contradiction with %s', (mode) => {
  const f = fixture()
  if (mode === 'distinct origin')
    f.table.cells[1].sourceItems = [{ ...f.token.sourceItem, index: 1 }]
  if (mode === 'different page')
    f.table.cells[1].sourceItems = [{ ...f.token.sourceItem, pageNumber: 2 }]
  if (mode === 'missing native') f.tokens.length = 0
  if (mode === 'duplicate native') f.tokens.push({ ...f.token })
  if (mode === 'different literal')
    f.table.cells[1].sourceItems = [{ ...f.token.sourceItem, text: 'Other' }]
  if (mode === 'non-finite height') f.token.height = NaN
  if (mode === 'zero height') f.token.height = 0
  if (mode === 'non-finite baseline') f.token.baseline = NaN
  assert(!conflicts(f.table, f.tokens).includes(marker))
})
