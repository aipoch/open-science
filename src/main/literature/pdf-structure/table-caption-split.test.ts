import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { splitCaptionedTableRegions, refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { startsDetachedTableCaption, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)

it('separates a numbered caption across a gutter without splitting ordinary references', () => {
  const prose = {
    str: 'Most patients had surgery',
    width: 200,
    height: 10,
    transform: [10, 0, 0, 10, 0, 500]
  }
  const space = { ...prose, str: ' ', width: 100, height: 0, transform: [10, 0, 0, 10, 200, 500] }
  const title = { ...prose, str: 'Table', width: 25, transform: [10, 0, 0, 10, 350, 500] }
  expect(startsDetachedTableCaption([prose, space], title)).toBe(true)
  expect(
    startsDetachedTableCaption([prose], { ...title, transform: [10, 0, 0, 10, 205, 500] })
  ).toBe(false)
  expect(startsDetachedTableCaption([prose], { ...title, str: 'See Table 1' })).toBe(false)
  const rightColumn = { ...prose, transform: [10, 0, 0, 10, 350, 500] }
  const figure = { ...title, str: 'Fig. 1.', transform: [10, 0, 0, 10, 0, 500] }
  expect(startsDetachedTableCaption([rightColumn], figure)).toBe(true)
  expect(startsDetachedTableCaption([rightColumn], { ...figure, str: 'Ordinary text' })).toBe(false)
  expect(
    startsDetachedTableCaption([prose], { ...figure, transform: [10, 0, 0, 10, 180, 500] })
  ).toBe(false)
})

it('recovers centered scanned titles and their grammatical continuation', () => {
  const page = {
    pageNumber: 1,
    width: 500,
    height: 700,
    graphicsBounds: [{ kind: 'image', normalizedRect: [0, 0, 1, 1] }],
    lines: [
      { text: 'Table 3', x: 180, y: 20, width: 40, height: 10, fontSize: 10 },
      {
        text: 'Number of responding patients and duration of',
        x: 80,
        y: 36,
        width: 240,
        height: 8.8,
        fontSize: 8.8
      },
      {
        text: 'the response (months; in parentheses)',
        x: 110,
        y: 47,
        width: 180,
        height: 8.5,
        fontSize: 8.5
      },
      { text: 'Complete response', x: 150, y: 72, width: 100, height: 8.8, fontSize: 8.8 }
    ]
  }
  expect(findCaptionCandidates([page])[0].lines).toEqual(page.lines.slice(0, 3).map((l) => l.text))
  expect(findCaptionCandidates([{ ...page, graphicsBounds: [] }])[0].lines).toEqual(['Table 3'])
})

it('splits independently titled tables while retaining all source rows and wrapped labels', () => {
  const raw = {
    id: 'combined',
    cropRect: [0, 0, 400, 260],
    structure: {
      objects: [
        ...Array.from({ length: 4 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, (c + 1) * 100, 260]
        })),
        ...Array.from({ length: 13 }, (_, r) => ({
          label: 'table row',
          rect: [0, r * 20, 400, (r + 1) * 20]
        }))
      ]
    }
  }
  const captions = [
    { lines: ['Table 1', 'Patient characteristics'], rect: [130, -35, 270, -5] },
    { lines: ['Table 2', 'Treatment regimens'], rect: [130, 110, 270, 140] }
  ]
  const parts = splitCaptionedTableRegions(raw, captions, [])
  expect(parts).toHaveLength(2)
  expect(parts[0].cropRect[3]).toBe(110)
  expect(parts[1].cropRect[1]).toBe(142)
  expect(
    splitCaptionedTableRegions(
      raw,
      [captions[0], { ...captions[1], lines: ['Table 1', 'continued'] }],
      []
    )
  ).toEqual([raw])
  expect(
    splitCaptionedTableRegions(
      raw,
      captions.map((c) => ({ ...c, lines: c.lines.slice(0, 1) })),
      []
    )
  ).toEqual([raw])
  const token = (
    text: string,
    x: number,
    y: number
  ): { text: string; rect: number[]; height: number; baseline: number; horizontal: boolean } => ({
    text,
    rect: [x, y, x + 70, y + 10],
    height: 10,
    baseline: y + 10,
    horizontal: true
  })
  const items = [
    ...['Characteristic', 'Total', 'A', 'B'].map((t, c) => token(t, c * 100 + 5, 3)),
    ...['Age', '53', '52', '54'].map((t, c) => token(t, c * 100 + 5, 23)),
    token('Hormonal or', 5, 43),
    ...['chemotherapy', '26', '13', '13'].map((t, c) => token(t, c * 100 + 5, 57)),
    ...['Previous', '66', '32', '34'].map((t, c) => token(t, c * 100 + 5, 83))
  ]
  const table = refineTable(parts[0], items, captions)
  expect(table.grid).toEqual([
    ['Characteristic', 'Total', 'A', 'B'],
    ['Age', '53', '52', '54'],
    ['Hormonal or chemotherapy', '26', '13', '13'],
    ['Previous', '66', '32', '34']
  ])
  expect(table.unassigned).toEqual([])
})
