import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'

const { anonymousMissingGroupHeader: fixture } = await import(
  pathToFileURL(resolve('test/fixtures/native-missing-group-header.mjs')).href
)
const { reviewNativeMissingGroupHeader: review } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-missing-group-header.mjs')).href
)

it('pauses mapping for an omitted native parent band without reconstructing any cells', async () => {
  const f = fixture(),
    before = structuredClone(f.table)
  assert.deepEqual(await review(f.table, f, async () => f.png), {
    ...before,
    issues: ['native-table-structure-ambiguous'],
    reviewCandidate: false
  })
  assert.deepEqual(f.table, before)
})

for (const [name, options] of [
  ['a complete wrapped header', { completeHeader: true }],
  ['a single title spanning both groups', { spanningTitle: true }],
  ['an upper band with inconsistent native baselines', { shiftedParent: true }]
] as const) {
  it(`retains ${name}`, async () => {
    const f = fixture(options)
    assert.equal(await review(f.table, f, async () => f.png), f.table)
  })
}

for (const [name, mutate] of [
  [
    'missing raster',
    (f) => {
      delete f.context.captionLaneRaster
    }
  ],
  [
    'substituted raster',
    (f) => {
      f.png[100] ^= 1
    }
  ],
  [
    'unknown native advance',
    (f) => {
      f.context.content.items[0].width += 1
    }
  ],
  [
    'missing font',
    (f) => {
      f.context.glyphBounds = undefined
    }
  ],
  [
    'duplicate whole owner',
    (f) => {
      f.table.cells[1].sourceItems.push(f.table.cells[1].sourceItems[0])
    }
  ],
  [
    'unknown stroke',
    (f) => {
      f.context.operators.argsArray[3][0] = OPS.fill
    }
  ],
  [
    'inconsistent native path bounds',
    (f) => {
      f.context.operators.argsArray[3][2][0] += 1
    }
  ],
  [
    'missing group fence',
    (f) => {
      f.context.operators.argsArray[6][1][0][4] += 1
    }
  ],
  [
    'multipart table',
    (f) => {
      f.table.parts = []
    }
  ],
  [
    'unbound source viewport',
    (f) => {
      f.table.sourceViewport.width += 1
    }
  ]
] as const) {
  it(`refuses ${name}`, async () => {
    const f = fixture()
    mutate(f)
    assert.equal(await review(f.table, f, async () => f.png), f.table)
  })
}

for (const target of ['table', 'page', 'context'] as const) {
  it(`refuses ${target} identity replacement while loading the page raster`, async () => {
    const f = fixture()
    const actual = await review(f.table, f, async () => {
      if (target === 'table') f.table.cells = [...f.table.cells]
      if (target === 'page') f.page.graphicsBounds = [...f.page.graphicsBounds]
      if (target === 'context') f.context.content.items[0] = { ...f.context.content.items[0] }
      return f.png
    })
    assert.equal(actual, f.table)
  })
}
