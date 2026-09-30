import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    'src/main/literature/pdf-structure/fixtures/source-grids/separate-caption-sheet-with-spaced-paragraph.jsonl'
  )
const parse = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  associateTableCaptions(f.pages[0], f.tables, findCaptionCandidates(f.pages), f.rules, f.pages)[0]

it.each([0.7, 1, 1.8])(
  'retains the complete caption sheet and its actual page at scale %s',
  (scale) => {
    const f = load()
    for (const p of f.pages) {
      p.width *= scale
      p.height *= scale
      for (const l of p.lines)
        for (const k of ['x', 'y', 'width', 'height', 'fontSize']) l[k] *= scale
    }
    for (const r of [...f.tables.map((t: { rect: number[] }) => t.rect), ...f.rules])
      for (let i = 0; i < 4; i++) r[i] *= scale
    const result = parse(f)
    const body = f.pages[1].lines.filter(
      (l: { y: number }) => l.y >= 48 * scale && l.y < 200 * scale
    )
    expect(result.caption.page).toBe(2)
    expect(result.caption.lines).toEqual(body.map((l: { text: string }) => l.text))
    expect(result.caption.rect).toEqual([
      body[0].x,
      body[0].y,
      Math.max(...body.map((l: { x: number; width: number }) => l.x + l.width)),
      body.at(-1).y + body.at(-1).height
    ])
    expect(result.reason).toBeUndefined()
  }
)

it.each([
  'competing-table',
  'same-page-caption',
  'competing-sheet-caption',
  'graphics',
  'invalid-graphics',
  'prose-tail',
  'unfinished-tail',
  'line-gap',
  'font',
  'alignment',
  'different-page-size',
  'rotation',
  'missing-frame',
  'unrelated-header',
  'distant-sheet',
  'unknown-header'
])('leaves caption ownership absent without complete evidence: %s', (mode) => {
  const f = load(),
    p = f.pages[1],
    body = p.lines.filter((l: { y: number }) => l.y >= 48 && l.y < 200)
  if (mode === 'competing-table') f.tables.push(structuredClone(f.tables[0]))
  if (mode === 'same-page-caption') f.pages[0].lines.push({ ...body[0], y: 490 })
  if (mode === 'competing-sheet-caption')
    p.lines.push({ ...body[0], text: 'Table 2. A different comparison', y: 300 })
  if (mode === 'graphics') p.graphicsBounds.push([70, 220, 740, 400])
  if (mode === 'invalid-graphics') p.invalidGraphicsBounds = 1
  if (mode === 'prose-tail')
    p.lines.push({
      ...body[2],
      y: 200,
      text: 'Additional independent results are described on this page.'
    })
  if (mode === 'unfinished-tail') body[2].text = body[2].text.slice(0, -1)
  if (mode === 'line-gap') body[2].y += 15
  if (mode === 'font') body[1].fontSize += 3
  if (mode === 'alignment') body[2].x += 20
  if (mode === 'different-page-size') p.width += 100
  if (mode === 'rotation') p.rotation = 90
  if (mode === 'missing-frame') f.rules = []
  if (mode === 'unrelated-header')
    f.pages[0].lines = f.pages[0].lines.filter((l: { y: number }) => l.y < 48)
  if (mode === 'distant-sheet') p.pageNumber = 3
  if (mode === 'unknown-header') p.lines[0].text = 'A different running title'
  if (mode === 'same-page-caption') expect(parse(f).caption.page).toBe(1)
  else expect(parse(f).caption).toBeUndefined()
})

it('requires an explicitly available neighboring page', () => {
  const f = load()
  expect(
    associateTableCaptions(f.pages[0], f.tables, findCaptionCandidates(f.pages), f.rules)[0].caption
  ).toBeUndefined()
})
