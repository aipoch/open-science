import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { trimTableNoteCrop } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-geometry.mjs')).href
)

it('cuts a confirmed note below final cell ink even when preliminary rows contain the note', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/confirmed-note-below-final-cell-ink-with-stale-row-band.jsonl'
    )
  )
  const cropRect = [...f.table.cropRect]
  expect(f.notes[0].rect[1]).toBeLessThan(f.contentRect[3])
  trimTableNoteCrop({ ...f, cropRect })
  expect(cropRect).toEqual([59, 813, 422, 1046.3078])
  expect(f.table.cropRect[3]).toBe(1054)
})

it('keeps notes from cutting owned cell ink or an unresolved source row', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/confirmed-note-below-final-cell-ink-with-stale-row-band.jsonl'
    )
  )
  for (const uncertain of [false, true]) {
    const cropRect = [...f.table.cropRect]
    if (uncertain) f.table.unassigned = [{ rect: f.notes[0].rect.map((v: number) => v * f.scale) }]
    else f.notes[0].rect[1] = 1037 / f.scale
    trimTableNoteCrop({ ...f, cropRect })
    expect(cropRect).toEqual(f.table.cropRect)
  }
})
const item = (text: string, rect: number[]): object => ({
  text,
  rect,
  baseline: rect[3],
  height: rect[3] - rect[1],
  horizontal: true
})
it('uses captioned paired rules to exclude neighboring prose and include clipped headings and stubs', () => {
  const makeTable = (
    left: number
  ): {
    cropRect: number[]
    structure: { objects: { label: string; rect: number[] }[] }
  } => ({
    cropRect: [left, 22, 210, 120],
    structure: {
      objects: [
        ...[
          [25, 38],
          [44, 60],
          [64, 80],
          [84, 100],
          [104, 118]
        ].map(([a, b]) => ({ label: 'table row', rect: [34 - left, a - 22, 200 - left, b - 22] })),
        ...[
          [34, 140],
          [140, 200]
        ].map(([a, b]) => ({ label: 'table column', rect: [a - left, 3, b - left, 96] })),
        { label: 'table column header', rect: [34 - left, 3, 200 - left, 16] }
      ]
    }
  })
  const items = [
    item('Group', [35, 19, 65, 29]),
    item('Count', [150, 19, 185, 29]),
    ...['Alpha', 'Beta', 'Gamma', 'Delta'].flatMap((text, r) => [
      item(text, [35, 46 + r * 20, 85, 56 + r * 20]),
      item(String(r + 10), [155, 46 + r * 20, 170, 56 + r * 20])
    ]),
    item('an', [8, 66, 22, 76])
  ]
  const captions = [{ lines: ['Table 1: Counts'], rect: [30, 134, 145, 144] }]
  const rules = [
    [30, 38, 205, 38],
    [30, 130, 205, 130]
  ]
  for (const left of [10, 40]) {
    const table = makeTable(left)
    const result = refineTable(table, items, captions, [], rules)
    expect(result.cropRect).toEqual([28, 17, 207, 120])
    expect(result.grid).toEqual([
      ['Group', 'Count'],
      ['Alpha', '10'],
      ['Beta', '11'],
      ['Gamma', '12'],
      ['Delta', '13']
    ])
    expect(result.unassigned).toEqual([])
    expect(result.clipped).toEqual([])
    expect(result.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects)).toHaveLength(10)
    expect(table.cropRect).toEqual([left, 22, 210, 120])
    // Neither an isolated rule nor a detached caption proves the table boundary.
    expect(refineTable(table, items, captions, [], rules.slice(0, 1)).cropRect).toEqual(
      table.cropRect
    )
    expect(refineTable(table, items, [], [], rules).cropRect).toEqual(table.cropRect)
    expect(
      refineTable(
        table,
        [...items, item('Overhanging label', [25, 46, 85, 56])],
        captions,
        [],
        rules
      ).cropRect
    ).toEqual(table.cropRect)
  }
  const normal = { ...makeTable(28), cropRect: [28, 17, 207, 120] }
  expect(
    refineTable(
      normal,
      [...items.slice(0, -1), item('*Footnote', [35, 119, 85, 129])],
      captions,
      [],
      rules
    ).cropRect
  ).toEqual(normal.cropRect)
})
