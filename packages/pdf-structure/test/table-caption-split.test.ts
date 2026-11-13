import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { splitCaptionedTableRegions, refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { startsDetachedTableCaption, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
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

const nativeCaptionFrames = (): ReturnType<typeof JSON.parse> => {
  const captions = Array.from({ length: 4 }, (_, n) => ({
    page: 1,
    lines: [`Table ${n + 1}: Anonymous measurements.`],
    rect: [20, n * 100, 180, n * 100 + 10]
  }))
  const items = captions.map((caption, index) => ({
    text: caption.lines[0],
    rect: caption.rect,
    height: 10,
    baseline: caption.rect[3],
    horizontal: true,
    sourceItem: { pageNumber: 1, index, text: caption.lines[0] }
  }))
  for (let n = 0; n < 4; n++)
    for (const y of [25, 45, 65])
      for (const x of [10, 110]) {
        const text = `Value ${n}-${y}-${x}`
        items.push({
          text,
          rect: [x, n * 100 + y, x + 60, n * 100 + y + 8],
          height: 8,
          baseline: n * 100 + y + 8,
          horizontal: true,
          sourceItem: { pageNumber: 1, index: items.length, text }
        })
      }
  const runs = items.map((item) => ({
    ...item,
    glyphRuns: [...item.text.replace(/\s/gu, '')].map(() => 1),
    literalGlyphs: [...item.text.replace(/\s/gu, '')]
  }))
  const rules = captions.flatMap((_, n) =>
    [20, 40, 80].map((y) => [0, n * 100 + y, 200, n * 100 + y])
  )
  const table = {
    id: 'anonymous',
    cropRect: [0, 15, 200, 385],
    structure: {
      objects: [
        ...Array.from({ length: 2 }, (_, n) => ({
          label: 'table column',
          rect: [n * 100, 0, (n + 1) * 100, 370]
        })),
        ...Array.from({ length: 37 }, (_, n) => ({
          label: 'table row',
          rect: [0, n * 10, 200, (n + 1) * 10]
        }))
      ]
    }
  }
  return {
    table,
    captions,
    rules,
    context: {
      items,
      runs,
      graphics: rules.map((r) => ({ kind: 'path', rect: [r[0], r[1] - 0.2, r[2], r[3] + 0.2] })),
      rulePaintBounds: new Map(
        rules.map((r) => [r.join(','), [r[0], r[1] - 0.2, r[2], r[3] + 0.2]])
      )
    }
  }
}

it('separates descriptive captions only at complete printed native frames', () => {
  const f = nativeCaptionFrames(),
    before = structuredClone(f)
  const parts = splitCaptionedTableRegions(f.table, f.captions, f.rules, f.context)
  expect(parts).toHaveLength(4)
  expect(parts.map((p: { caption: unknown }) => p.caption)).toEqual(f.captions)
  expect(parts.map((p: { cropRect: number[] }) => p.cropRect)).toEqual(
    [0, 1, 2, 3].map((n) => [0, n * 100 + 19.8, 200, n * 100 + 80.2])
  )
  expect(f).toEqual(before)
})

it.each([
  'missing paint',
  'missing program',
  'missing closing',
  'unprinted caption',
  'continued number',
  'crossing font',
  'unowned corridor',
  'aliased caption',
  'native image',
  'unowned path'
])('keeps a composite intact without independent frame evidence: %s', (reason) => {
  const f = nativeCaptionFrames()
  if (reason === 'missing paint') f.context.rulePaintBounds.clear()
  if (reason === 'missing program') f.context.runs.splice(3, 1)
  if (reason === 'missing closing') f.rules.splice(5, 1)
  if (reason === 'unprinted caption') f.captions[1].lines[0] += ' Unprinted.'
  if (reason === 'continued number') f.captions[1].lines[0] = f.captions[0].lines[0]
  if (reason === 'native image') f.context.graphics.push({ kind: 'image', rect: [10, 50, 30, 70] })
  if (reason === 'unowned path') f.context.graphics.push({ kind: 'path', rect: [10, 85, 60, 95] })
  if (reason === 'unowned corridor')
    f.context.items.push({ text: 'Footnote', rect: [10, 85, 60, 93], horizontal: true })
  if (reason === 'aliased caption')
    f.context.items.push({ ...structuredClone(f.context.items[0]), rect: [210, 0, 370, 10] })
  if (reason === 'crossing font')
    f.context.items.push({ text: 'Foreign', rect: [10, 79, 30, 110], horizontal: true })
  expect(splitCaptionedTableRegions(f.table, f.captions, f.rules, f.context)).toEqual([f.table])
})
