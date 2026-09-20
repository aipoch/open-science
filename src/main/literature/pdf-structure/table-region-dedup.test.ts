import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { deduplicateTableRegions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-regions.mjs')).href
)
it('collapses overlapping detections only when they own the same source tokens', () => {
  const a = { cropRect: [0, 0, 300, 100], detection: { score: 0.8 } }
  const b = { cropRect: [1, 1, 301, 101], detection: { score: 0.9 } }
  const source = [
    { text: 'Group', rect: [10, 10, 50, 20] },
    { text: '25', rect: [200, 40, 220, 50] }
  ]
  expect(deduplicateTableRegions([a, b], source)).toEqual([b])
  expect(
    deduplicateTableRegions([a, b], [...source, { text: '0', rect: [0, 30, 0.8, 40] }])
  ).toEqual([a, b])
  expect(deduplicateTableRegions([a, b], [])).toEqual([a, b])
  expect(deduplicateTableRegions([a, { ...b, cropRect: [0, 110, 300, 210] }], source)).toHaveLength(
    2
  )
})
