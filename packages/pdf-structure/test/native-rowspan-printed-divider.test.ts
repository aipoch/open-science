import { it as test } from 'vitest'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { rowspanAcrossFullDivider } = await import(
  pathToFileURL(resolve('test/fixtures/native-rowspan-printed-divider.mjs')).href
)
const { nativeTableLayoutConflicts: conflicts } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-layout-conflicts.mjs')).href
)
const { reviewFinalNativeTableSources: review } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-source-integrity.mjs')).href
)
type Fixture = ReturnType<typeof JSON.parse>
const marker = 'native-row-span-crosses-full-printed-separator'
const controls: [string, object, ((f: Fixture) => void) | undefined, boolean][] = [
  ['full printed separator', {}, undefined, true],
  ['a legitimate group below the separator', { correct: true }, undefined, false],
  ['a partial divider that stops before the group', { partial: true }, undefined, false],
  ['a white separator', { color: '#ffffff' }, undefined, false],
  ['a transparent separator', { alpha: 0 }, undefined, false],
  ['a clipped separator', { clip: true }, undefined, false],
  [
    'a mismatched source checksum',
    {},
    (f) => {
      f.context.sourceSha256 = 'f'.repeat(64)
    },
    false
  ],
  [
    'a missing original renderer program',
    {},
    (f) => {
      delete f.context.nativeGlyphContext
    },
    false
  ],
  [
    'a changed native operator',
    {},
    (f) => {
      f.context.operators.argsArray[1] = ['other']
    },
    false
  ],
  [
    'a duplicate affected source',
    {},
    (f) => {
      f.cells[1].sourceItems.push(f.cells[3].sourceItems[0])
    },
    false
  ],
  ['an opaque occluder', { occlusion: true }, undefined, false],
  [
    'a nonbijective font alias',
    {},
    (f) => {
      f.context.nativeGlyphContext.content.items[0].fontName = 'Other'
    },
    false
  ],
  [
    'a duplicate filtered graphic identity',
    {},
    (f) => {
      f.context.nativePaintIdentityGraphics.push(f.context.nativePaintIdentityGraphics[0])
    },
    false
  ]
]
for (const [name, options, change, expected] of controls)
  test('checks a native row span with ' + name, () => {
    const f = rowspanAcrossFullDivider(options)
    change?.(f)
    const before = structuredClone(f.table)
    assert.equal(conflicts(f.table, f.tokens, f.rules, [], f.context).includes(marker), expected)
    const out = review(f.table, f.tokens, f.rules, [], f.context)
    if (expected) assert(out.issues.includes('native-table-structure-ambiguous'))
    assert.equal(out.cells, f.cells)
    assert.equal(out.grid, f.grid)
    assert.equal(out.cropRect, f.table.cropRect)
    assert.equal(out.thumbnail, f.table.thumbnail)
    assert.equal(out.notes, f.table.notes)
    assert.deepEqual(f.table, before)
  })
