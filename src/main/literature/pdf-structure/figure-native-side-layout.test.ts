import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('src/main/literature/pdf-structure/fixtures', `${name}.jsonl`))
const associate = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  associateFigures(f.page, f.captions, f.tables)
const rect = (g: { normalizedRect: number[] }, page: { width: number; height: number }): number[] =>
  g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))

it('follows both native flowchart branches past a side caption without including article prose', () => {
  const f = fixture('branching-flowchart'),
    original = structuredClone(f)
  const result = associate(f)[0]
  expect(result.rect).toEqual([80.192125, 95.10697265625001, 441.0566875, 475.53486328125])
  expect(result.graphicsCount).toBe(17)
  // This includes the distant six-month node and both formerly unassigned connectors.
  for (const g of f.page.graphicsBounds) {
    const r = rect(g, f.page)
    expect(r[0]).toBeGreaterThanOrEqual(result.rect[0])
    expect(r[1]).toBeGreaterThanOrEqual(result.rect[1])
    expect(r[2]).toBeLessThanOrEqual(result.rect[2])
    expect(r[3]).toBeLessThanOrEqual(result.rect[3])
  }
  expect(result.rect[2]).toBeLessThan(f.captions[0].rect[0])
  expect(f).toEqual(original)
})

it.each(['missing-connectors', 'unlabelled-frames', 'disconnected-panel'])(
  'declines a complete flowchart crop with %s',
  (mode) => {
    const f = fixture('branching-flowchart')
    if (mode === 'missing-connectors')
      f.page.graphicsBounds = f.page.graphicsBounds.filter((g: { normalizedRect: number[] }) => {
        const r = rect(g, f.page)
        return !(r[2] - r[0] < 16 && r[1] < 280 && r[3] > 250)
      })
    if (mode === 'unlabelled-frames') f.page.lines = []
    if (mode === 'disconnected-panel')
      f.page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: [
          20 / f.page.width,
          320 / f.page.height,
          45 / f.page.width,
          350 / f.page.height
        ]
      })
    expect(associate(f)[0].rect).toBeUndefined()
  }
)

it('assigns the top-aligned side legend to the lower raster and keeps both running heads outside crops', () => {
  const f = fixture('stacked-side-figures'),
    original = structuredClone(f)
  const results = associate(f)
  expect(results).toHaveLength(2)
  const images = f.page.graphicsBounds.filter((g: { kind: string }) => g.kind === 'image')
  expect(images).toHaveLength(2)
  expect(results.map((r: { rect: number[] }) => r.rect)).toEqual(
    images.map((g: { normalizedRect: number[] }) => rect(g, f.page))
  )
  expect(results.every((r: { graphicsCount: number }) => r.graphicsCount === 1)).toBe(true)
  expect(results[0].rect[3]).toBeLessThan(f.captions[0].rect[1])
  expect(results[1].rect[0]).toBeLessThan(f.captions[1].rect[0])
  expect(f).toEqual(original)
})

it('does not prioritize a vertically displaced side legend over an aligned neighboring caption', () => {
  const f = fixture('stacked-side-figures')
  f.captions[1].rect[1] += 10
  f.captions[1].rect[3] += 10
  expect(associate(f)[0].reason).toBe('ambiguous-graphic-direction')
  expect(associate(f)[1].rect).toBeUndefined()
})

it('does not resolve equally placed competing side legends by input order', () => {
  const f = fixture('stacked-side-figures')
  f.captions.push({
    ...structuredClone(f.captions[1]),
    lines: ['Fig. 7. Competing caption.', 'A second legend.']
  })
  const results = associate(f)
  expect(results[1].rect).toBeUndefined()
  expect(results[2].rect).toBeUndefined()
})

it('keeps table-owned raster content out of a neighboring figure', () => {
  const f = fixture('stacked-side-figures')
  const lower = f.page.graphicsBounds.find(
    (g: { normalizedRect: number[] }) => rect(g, f.page)[1] > 300
  )
  f.tables.push(rect(lower, f.page))
  expect(associate(f)[1].rect).toBeUndefined()
})

it('requires a matching distant journal header before excluding an author-like text line', () => {
  const f = fixture('stacked-side-figures')
  f.page.lines = f.page.lines.filter(
    (l: { text: string }) => !l.text.startsWith('Clinica Chimica Acta')
  )
  expect(associate(f)[0].rect[1]).toBeLessThan(40)
})

it('removes both running heads from an already-associated raster without trimming the source plate', () => {
  const f = fixture('split-running-figure-header'),
    original = structuredClone(f)
  const result = associate(f)[0]
  const images = f.page.graphicsBounds.filter((g: { kind: string }) => g.kind === 'image')
  expect(images).toHaveLength(1)
  expect(result.rect).toEqual(rect(images[0], f.page))
  expect(result.graphicsCount).toBe(1)
  expect(f).toEqual(original)
})

it('joins a short hanging legend and excludes outlined furniture from the complete native flowchart', () => {
  const f = fixture('outlined-heading-flowchart'),
    original = structuredClone(f)
  const captions = findCaptionCandidates([f.page])
  expect(captions[0].lines).toEqual([
    'Figure 1. Consort diagram of patients',
    'included in the study.'
  ])
  const result = associateFigures(f.page, captions, f.tables)[0]
  const plate = f.page.graphicsBounds.find((g: { kind: string }) => g.kind === 'image')
  expect(result.rect).toEqual(rect(plate, f.page))
  expect(result.graphicsCount).toBe(2)
  expect(f).toEqual(original)
})

it.each(['missing-author', 'incomplete-prose', 'competing-panel'])(
  'retains ambiguous native paths with %s instead of guessing page furniture',
  (mode) => {
    const f = fixture('outlined-heading-flowchart')
    if (mode === 'missing-author')
      f.page.lines = f.page.lines.filter((l: { text: string }) => !l.text.endsWith('et al'))
    if (mode === 'incomplete-prose')
      f.page.lines = f.page.lines.filter((l: { text: string }) => !l.text.startsWith('randomly by'))
    if (mode === 'competing-panel')
      f.page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.2, 0.36, 0.4, 0.4] })
    expect(
      associateFigures(f.page, findCaptionCandidates([f.page]), f.tables)[0].rect
    ).toBeUndefined()
  }
)

it.each(['no-side-graphic', 'complete-caption', 'distant-tail', 'uppercase-tail'])(
  'requires bounded hanging-caption evidence with %s',
  (mode) => {
    const f = fixture('outlined-heading-flowchart')
    const start = f.page.lines.find((l: { text: string }) => l.text.startsWith('Figure 1.'))
    const tail = f.page.lines.find((l: { text: string }) => l.text === 'included in the study.')
    if (mode === 'no-side-graphic') f.page.graphicsBounds = []
    if (mode === 'complete-caption') start.text += '.'
    if (mode === 'distant-tail') tail.y += 20
    if (mode === 'uppercase-tail') tail.text = 'Included in the study.'
    expect(findCaptionCandidates([f.page])[0].lines).toEqual([start.text])
  }
)
