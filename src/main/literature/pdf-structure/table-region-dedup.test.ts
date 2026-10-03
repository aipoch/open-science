import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { deduplicateTableRegions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-regions.mjs')).href
)
const { constrainCaptionLaneCrop } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
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

it('trims a lower detector region past an embedded descriptive table caption', () => {
  const table = {
    cropRect: [0, 0, 300, 160],
    detection: { score: 0.8 },
    structure: { objects: [{ label: 'table row', rect: [0, 40, 300, 60] }] }
  }
  const caption = {
    page: 1,
    lines: ['Table 2: Lower results'],
    rect: [10, 48, 290, 60]
  }
  const items = [
    { text: 'Model', horizontal: true, baseline: 70, height: 8, rect: [10, 64, 80, 72] },
    { text: '1', horizontal: true, baseline: 86, height: 8, rect: [10, 80, 30, 88] },
    { text: '2', horizontal: true, baseline: 102, height: 8, rect: [10, 96, 30, 104] },
    { text: '3', horizontal: true, baseline: 118, height: 8, rect: [10, 112, 30, 120] },
    { text: '4', horizontal: true, baseline: 134, height: 8, rect: [10, 128, 30, 136] }
  ]
  const [result] = deduplicateTableRegions([table], items, [caption])
  expect(result.cropRect).toEqual([0, 62, 300, 160])
  expect(result.structure.objects[0].rect).toEqual([0, -22, 300, -2])
})

it('keeps a caption-like region when the following source is too short to prove a table', () => {
  const table = {
    cropRect: [0, 0, 300, 160],
    detection: { score: 0.8 },
    structure: { objects: [] }
  }
  const caption = { page: 1, lines: ['Table 2: Note'], rect: [10, 48, 290, 60] }
  const items = [
    { text: 'One line', horizontal: true, baseline: 70, height: 8, rect: [10, 64, 80, 72] }
  ]
  expect(deduplicateTableRegions([table], items, [caption])[0].cropRect).toEqual(table.cropRect)
})

it('keeps a right-column table inside the lane of its original caption', () => {
  const table = {
    cropRect: [104, 111, 766, 516],
    structure: { objects: [{ label: 'table column', rect: [393, 0, 643, 400] }] }
  }
  const detectorCrop = [497, 103, 766, 516]
  const captions = [
    { lines: ['Table 5. Left'], rect: [75, 63, 429, 93] },
    { lines: ['Table 7. Right'], rect: [463, 63, 818, 93] }
  ]
  const result = constrainCaptionLaneCrop(table, detectorCrop, captions)
  expect(result.cropRect).toEqual([459, 111, 766, 516])
  expect(result.structure.objects[0].rect).toEqual([38, 0, 288, 400])
})
