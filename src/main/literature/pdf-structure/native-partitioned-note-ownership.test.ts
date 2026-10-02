import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const { tableNoteOwnershipRect } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const rect = [50, 100, 90, 110]
const token = { text: '= 17', rect, horizontal: true, height: 10, baseline: 110 }
const table = {
  cropRect: [40, 90, 100, 120],
  unassigned: [],
  cells: [
    {
      sourceRects: [
        [50, 100, 60, 110],
        [65, 100, 90, 110]
      ]
    }
  ]
}
const observed = [
  {
    text: token.text,
    rect,
    height: 10,
    baseline: 110,
    gaps: [{ left: 60, right: 65, index: 1 }],
    literalGlyphs: ['=', '1', '7'],
    glyphRuns: [4, 4, 4]
  }
]
const frame = [40, 90, 100, 120]
it('uses uniquely measured complete source partitions only for note ownership', () => {
  expect(tableNoteOwnershipRect(table, frame, 1, [token], observed)).toEqual([40, 90, 100, 110])
  expect(tableNoteOwnershipRect(table, frame, 1, [token])).toEqual(frame)
  expect(table.cropRect).toEqual(frame)
})
it('rejects missing or competing streams, wrong literal glyphs, cuts through glyphs and incomplete ink', () => {
  for (const runs of [
    [],
    [...observed, ...observed],
    observed.map((o) => ({ ...o, literalGlyphs: ['=', '1', '8'] })),
    observed.map((o) => ({ ...o, gaps: [] })),
    observed.map((o) => ({ ...o, rect: [50.001, 100, 90, 110] }))
  ])
    expect(tableNoteOwnershipRect(table, frame, 1, [token], runs)).toEqual(frame)
  expect(
    tableNoteOwnershipRect(
      {
        ...table,
        cells: [
          {
            sourceRects: [
              [50, 100, 61, 110],
              [65, 100, 90, 110]
            ]
          }
        ]
      },
      frame,
      1,
      [token],
      observed
    )
  ).toEqual(frame)
  expect(
    tableNoteOwnershipRect(
      { ...table, cells: [{ sourceRects: [[50, 100, 60, 110]] }] },
      frame,
      1,
      [token],
      observed
    )
  ).toEqual(frame)
  expect(
    tableNoteOwnershipRect(
      table,
      frame,
      1,
      [token, { ...token, text: 'Foreign', rect: [40, 115, 55, 120] }],
      observed
    )
  ).toEqual(frame)
})
