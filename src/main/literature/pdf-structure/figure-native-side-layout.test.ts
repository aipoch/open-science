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

it('keeps a confirmed duplicate page number below the raster letter outside its crop', () => {
  const f = fixture('framed-letter-above-confirmed-page-number')
  const number = f.page.lines.find((l: { text: string }) => l.text === '32')
  expect(associate(f)[0].rect[3]).toBeLessThan(number.y)
  f.page.lines = f.page.lines.filter((l: { text: string }) => !/^Page 32 of/.test(l.text))
  // Without the independent page-number witness, a numeric figure label stays owned.
  expect(associate(f)[0].rect[3]).toBeGreaterThan(number.y)
})

it('keeps a quantized table footer above a raster plot outside the figure crop', () => {
  const f = fixture('raster-plot-below-quantized-table-footer')
  const plot = f.page.graphicsBounds.find(
    (g: { operationIndex: number }) => g.operationIndex === 831
  )
  expect(associate(f)[1].rect[1]).toBeGreaterThan(rect(plot, f.page)[1] - 2)
  f.tables = []
  // A nearby rule without table ownership may be a plot border.
  expect(associate(f)[1].rect[1]).toBeLessThan(rect(plot, f.page)[1] - 4)
})

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

it.each([
  ['side-schema-below-numbered-running-head', [213, 45, 554, 462]],
  ['stacked-raster-beside-running-logo', [44, 45, 384, 480]],
  ['patient-flow-beside-terminal-caption', [60, 325, 396, 726]],
  ['single-photograph-below-raster-running-head', [299, 94, 554, 452]]
])('retains all panels without running page art in %s', (name, bounds) => {
  const f = fixture(name),
    original = structuredClone(f)
  const result = associate(f)[0]
  expect(result.rect).toBeDefined()
  expect(result.rect[0]).toBeGreaterThanOrEqual(bounds[0])
  expect(result.rect[1]).toBeGreaterThanOrEqual(bounds[1])
  expect(result.rect[2]).toBeLessThanOrEqual(bounds[2])
  expect(result.rect[3]).toBeLessThanOrEqual(bounds[3])
  // Also require the complete occupied extent, not just an arbitrary small crop.
  expect(result.rect[2] - result.rect[0]).toBeGreaterThan(bounds[2] - bounds[0] - 5)
  expect(result.rect[3] - result.rect[1]).toBeGreaterThan(bounds[3] - bounds[1] - 5)
  expect(f).toEqual(original)
})
it('does not interpret an appendix cross-reference between plots as a graphical table', () => {
  const f = fixture('appendix-table-reference-between-plots')
  const captions = findCaptionCandidates([f.page])
  expect(captions).toHaveLength(2)
  expect(captions.map((c: { lines: string[] }) => c.lines[0])).toEqual([
    'Figure 5: The change in screening probability across social groups',
    'Figure 6: Percentage mammography use across the deprivation index'
  ])
  expect(associateFigures(f.page, captions).every((r: { rect?: number[] }) => r.rect)).toBe(true)
})

it.each([
  ['italic-description-below-centered-table-number', 'Demographic characteristics'],
  ['italic-correlation-title-before-ruled-header', 'Correlation Matrix for Main Study Variables.']
])('retains the native manuscript description in %s', (name, title) => {
  const f = fixture(name),
    original = structuredClone(f)
  const captions = findCaptionCandidates([f.page], new Map([[f.page.pageNumber, f.rules]]))
  expect(captions).toHaveLength(1)
  expect(captions[0].lines.join(' ')).toContain(title)
  expect(captions[0].rect[3]).toBeLessThan(120)
  expect(f).toEqual(original)
})
it('retains running-head evidence after repeated author text has already been removed', () => {
  const f = fixture('stacked-raster-beside-running-logo')
  f.page.lines = f.page.lines.filter((l: { text: string }) => !l.text.includes('et al.'))
  f.page.marginRuleBounds = [[0.07421875, 0.0390625, 0.9296875, 0.046875]]
  const result = associate(f)[0]
  expect(result.rect[1]).toBeGreaterThan(45)
  expect(result.rect[3]).toBeGreaterThan(479)
})

it('retains the entire raster containing native labels above captioned vector logos', () => {
  const f = fixture('raster-letterhead-above-captioned-logos'),
    original = structuredClone(f)
  expect(associate(f)[0].rect).toEqual([92.8125, 153, 225.84375, 387.28125])
  expect(f).toEqual(original)
  f.page.lines = f.page.lines.filter(
    (l: { text: string }) => !/^DÉPISTAGE|DANS L|DECAD|337|ZI de|27000/.test(l.text)
  )
  expect(associate(f)[0].rect[1]).toBeGreaterThan(153)
})

it('filters a repeated vector publisher mark before associating a side-captioned flowchart', async () => {
  const { excludeRepeatedMarginContent } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-graphics.mjs')).href
  )
  const f = fixture('vector-wordmark-above-flowchart'),
    original = structuredClone(f)
  const pages = excludeRepeatedMarginContent(f.pages)
  const page = pages.find((p: { pageNumber: number }) => p.pageNumber === 4)
  const result = associateFigures(page, findCaptionCandidates(pages))[0]
  expect(result.rect).toEqual([60.45771875, 325.54142578125, 395.30046875, 725.4923203125])
  expect(result.graphicsCount).toBe(24)
  expect(f).toEqual(original)
  // An unrepeated mark is retained; its shape alone does not prove publisher ownership.
  const alone = excludeRepeatedMarginContent([f.pages[1]])[0]
  expect(alone.graphicsBounds).toEqual(f.pages[1].graphicsBounds)
})

it('retains complete native notes beginning inside raster plot bounds', () => {
  const f = fixture('raster-plots-with-overlapping-native-notes'),
    original = structuredClone(f)
  const results = f.pages.flatMap((p: unknown) => associateFigures(p, f.captions))
  expect(results.map((r: { rect: number[] }) => r.rect[3])).toEqual([
    565.511, 307.6, 407.403, 640.419
  ])
  expect(f).toEqual(original)
  // Adjacent article text uses a different font, and cannot extend this note.
  const page = f.pages[0]
  page.lines.push({
    text: 'Unrelated article prose.',
    fontSize: 12,
    height: 12,
    x: 200.19,
    y: 569,
    width: 200
  })
  expect(associateFigures(page, f.captions)[0].rect[3]).toBe(565.511)
})
