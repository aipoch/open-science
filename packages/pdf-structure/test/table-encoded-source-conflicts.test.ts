import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { resolve } from './paths'

const { encodedSourceTableFixture: fixture } = await import(
  pathToFileURL(resolve('test/fixtures/table-encoded-source-conflicts.mjs')).href
)
const { reviewNativeTableSources: early, reviewFinalNativeTableSources: review } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-source-integrity.mjs')).href
)
const { encodedControlImageOnlyTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-regions.mjs')).href
)

it.each(['\u0010', '\u0011'])(
  'pauses a uniquely native-bound encoded cell at final review (%j)',
  (control) => {
    const f = fixture(control),
      before = JSON.stringify(f)
    assert.equal(early(f.table, f.inventory), f.table)
    const result = review(f.table, f.inventory, [], [], f.context)
    assert.deepEqual(result, {
      ...f.table,
      issues: ['native-table-structure-ambiguous'],
      reviewCandidate: false
    })
    for (const key of ['grid', 'cells', 'cropRect', 'notes', 'thumbnail'])
      assert.equal(result[key], f.table[key])
    assert(!Object.hasOwn(result, 'unreliableMathSourceItems'))
    assert(!Object.hasOwn(result, 'nativeBody'))
    assert.equal(JSON.stringify(f), before)
    assert.deepEqual(review(result, f.inventory, [], [], f.context), result)
    assert.equal(
      encodedControlImageOnlyTable(f.table, f.inventory, f.context.sourceContent, []),
      undefined
    )
  }
)

it('recognizes an explicit complete measured owner without borrowing a partial range', () => {
  const f = fixture()
  f.cell.sourceSegments = [{ ...f.control.sourceItem, start: 0, end: 1, rect: f.control.rect }]
  delete f.cell.sourceItems
  assert.equal(review(f.table, f.inventory, [], [], f.context).reviewCandidate, false)
})

it.each([
  'ordinary text',
  'whitespace controls',
  'C1 only',
  'missing inventory',
  'duplicate inventory',
  'coerced native origin',
  'different source page',
  'different native literal',
  'borrowed ordinary source',
  'unbound C0',
  'wrong source rectangle',
  'missing source content',
  'duplicate source content',
  'wrong raw literal',
  'zero native width',
  'NaN native height',
  'missing font metrics',
  'zero font metrics',
  'nonfinite font metrics',
  'inconsistent font metrics',
  'vertical font',
  'missing viewport',
  'nonfinite viewport',
  'nonfinite page size',
  'partial source range',
  'C0 only in notes'
])('does not infer the new conflict with %s', (mode) => {
  const f = fixture(
    mode === 'ordinary text'
      ? 'ordinary'
      : mode === 'whitespace controls'
        ? '\t\n\r\v\f'
        : mode === 'C1 only'
          ? '\u0080'
          : '\u0010'
  )
  if (mode === 'missing inventory') f.inventory.splice(5, 1)
  if (mode === 'duplicate inventory') f.inventory.push({ ...f.control })
  if (mode === 'coerced native origin')
    f.control.sourceItem = { ...f.control.sourceItem, index: '5' }
  if (mode === 'different source page')
    f.cell.sourceItems = [{ ...f.control.sourceItem, pageNumber: 2 }]
  if (mode === 'different native literal') f.control.text = 'ordinary'
  if (mode === 'borrowed ordinary source') {
    f.control.text = 'ordinary'
    f.control.sourceItem.text = 'ordinary'
    f.rawControl.str = 'ordinary'
  }
  if (mode === 'unbound C0') delete f.cell.sourceItems
  if (mode === 'wrong source rectangle') f.cell.sourceRects = [[71, 50, 100, 60]]
  if (mode === 'missing source content') delete f.context.sourceContent
  if (mode === 'duplicate source content') f.context.sourceContent.items.push({ ...f.rawControl })
  if (mode === 'wrong raw literal') f.rawControl.str = 'ordinary'
  if (mode === 'zero native width') f.rawControl.width = 0
  if (mode === 'NaN native height') f.rawControl.height = NaN
  if (mode === 'missing font metrics') delete f.context.sourceContent.styles.native
  if (mode === 'zero font metrics') f.context.sourceContent.styles.native.ascent = 0
  if (mode === 'nonfinite font metrics') {
    f.context.sourceContent.styles.native.ascent = Infinity
    f.control.fontAscent = Infinity
  }
  if (mode === 'inconsistent font metrics') f.control.fontDescent = -0.3
  if (mode === 'vertical font') f.context.sourceContent.styles.native.vertical = true
  if (mode === 'missing viewport') delete f.context.viewport
  if (mode === 'nonfinite viewport') f.context.viewport.transform[0] = NaN
  if (mode === 'nonfinite page size') f.context.viewport.width = Infinity
  if (mode === 'partial source range') {
    f.cell.sourceSegments = [
      { ...f.control.sourceItem, text: '\u0010\u0011', start: 0, end: 1, rect: f.control.rect }
    ]
    delete f.cell.sourceItems
  }
  if (mode === 'C0 only in notes') {
    f.cell.text = 'ordinary'
    f.table.grid[2][1] = 'ordinary'
    f.table.notes[0].text = '\u0010'
  }
  assert.equal(review(f.table, f.inventory, [], [], f.context), f.table)
})
