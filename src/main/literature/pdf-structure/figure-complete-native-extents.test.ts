import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { associateFigures, associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)

const pairedCountContinuation = (): ReturnType<typeof JSON.parse> => {
  const line = (text: string, y: number, x = 88, width = 397): ReturnType<typeof JSON.parse> => ({
    text,
    y,
    x,
    width,
    height: 9,
    fontSize: 9
  })
  const title = {
    page: 1,
    lines: ['Table 1. Native Cohort Characteristics'],
    rect: [72, 71, 433, 83]
  }
  const next = { page: 2, lines: ['Table 2. Native Measured Effects'], rect: [72, 363, 302, 375] }
  const first = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      { ...line(title.lines[0], 71, 72, 361), height: 12, fontSize: 12 },
      line('n= 20', 118, 313, 21),
      line('n= 20', 118, 458, 21),
      line('First level 10 (50) 10 (50)', 680),
      line('Second level 3 (15) 3 (15)', 710),
      line('Third level 7 (35) 7 (35)', 740)
    ]
  }
  const page = {
    pageNumber: 2,
    width: 600,
    height: 800,
    lines: [
      line('Fourth level 10 (50) 10 (50)', 72),
      line('Fifth level 3 (15) 3 (15)', 108),
      line('Sixth level 7 (35) 7 (35)', 145),
      { ...line(next.lines[0], 363, 72, 230), height: 12, fontSize: 12 }
    ]
  }
  return {
    title,
    next,
    first,
    page,
    tables: [{ rect: [90, 72, 492, 300] }],
    rules: [[71, 309, 549, 309]]
  }
}
it('keeps a paired-count continuation with its prior title instead of the next title', () => {
  const x = pairedCountContinuation()
  expect(
    associateTableCaptions(x.page, x.tables, [x.title, x.next], x.rules, [x.first, x.page])[0]
      .caption
  ).toEqual(x.title)
})
it.each([
  'no footer',
  'wrong sample totals',
  'different font',
  'new local title',
  'prior prose',
  'multiple prior titles'
])('does not override a local caption from paired counts with %s', (kind) => {
  const x = pairedCountContinuation(),
    captions = [x.title, x.next]
  if (kind === 'no footer') x.rules = []
  if (kind === 'wrong sample totals') x.first.lines[1].text = 'n= 25'
  if (kind === 'different font') x.page.lines[0].fontSize = 12
  if (kind === 'new local title')
    captions.push({ page: 2, lines: ['Table 3. Independent Counts'], rect: [72, 45, 302, 57] })
  if (kind === 'prior prose')
    x.first.lines.push({
      text: 'An independent paragraph discusses other measurements and presents a separate interpretation of those findings.',
      fontSize: 9,
      height: 9,
      x: 88,
      y: 720,
      width: 397
    })
  if (kind === 'multiple prior titles')
    captions.push({ page: 1, lines: ['Table 3. Independent Counts'], rect: [72, 400, 302, 412] })
  expect(
    associateTableCaptions(x.page, x.tables, captions, x.rules, [x.first, x.page])[0].caption
  ).not.toEqual(x.title)
})
const { topCaptionedNativeFlow } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-connectivity.mjs')).href
)
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('src/main/literature/pdf-structure/fixtures', name + '.jsonl'))
const match = (x: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  associateFigures(x.page, x.captions, x.tableRects, x.rules, x.frames)[0]

it('excludes a small publisher raster above its native margin separator', () => {
  const x = load('raster-plate-below-native-publisher-strip')
  expect(match(x).rect[1]).toBeGreaterThan(55)
  expect(match(x).rect[1]).toBeLessThan(100)
})
it('retains complete diagonal categories and the centered native axis title', () => {
  const x = load('diagonal-categories-below-vector-bars')
  expect(match(x).rect[0]).toBeLessThanOrEqual(177.35213)
  expect(match(x).rect[3]).toBeGreaterThanOrEqual(239.5054)
  expect(match(x).rect[3]).toBeLessThan(x.captions[0].rect[1])
})
it('retains the raster border behind vector flow nodes', () => {
  const x = load('flowchart-with-raster-border-and-vector-nodes')
  expect(match(x).rect[0]).toBeLessThan(117)
})
it('excludes an external bare caption grazed by quantized raster bounds', () => {
  const x = load('bare-caption-grazing-quantized-raster-edge')
  expect(match(x).rect[3]).toBeLessThan(410)
})
it('recovers a populated connected flow below its top caption', () => {
  const x = load('top-caption-above-populated-branching-flow')
  expect(match(x).rect).toBeDefined()
  expect(match(x).rect[1]).toBeLessThan(140)
  expect(match(x).rect[3]).toBeGreaterThan(590)
})
it('retains native definitions of repeated flow node keys', () => {
  const x = load('flowchart-with-node-key-definitions')
  expect(match(x).rect[3]).toBeGreaterThanOrEqual(714.1413)
  expect(match(x).rect[3]).toBeLessThan(718.1244)
})
it('retains all eight panels whose native titles otherwise resemble paragraphs', () => {
  const x = load('eight-vector-panels-with-long-native-titles')
  expect(match(x).rect[1]).toBeLessThan(60)
  expect(match(x).rect[3]).toBeGreaterThan(700)
})

it('keeps an inset raster when no native publisher separator proves its ownership', () => {
  const x = load('raster-plate-below-native-publisher-strip')
  x.page.marginRuleBounds = []
  expect(match(x).rect[1]).toBeLessThan(55)
})
it('does not expand from fewer than four diagonal category peers', () => {
  const x = load('diagonal-categories-below-vector-bars')
  let count = 0
  x.page.lines = x.page.lines.filter(
    (l: ReturnType<typeof JSON.parse>) =>
      !(Math.abs(l.width - l.height) < 0.01 && l.height >= l.fontSize * 2) || ++count <= 3
  )
  expect(match(x).rect[3]).toBeLessThan(233)
})
it('keeps the existing path-only flow extent when there is no enclosing raster', () => {
  const x = load('flowchart-with-raster-border-and-vector-nodes')
  x.page.graphicsBounds = x.page.graphicsBounds.filter((g: { kind: string }) => g.kind !== 'image')
  expect(match(x).rect[0]).toBeGreaterThan(125)
})
it('retains a materially embedded caption inside a complete composite raster', () => {
  const x = load('bare-caption-grazing-quantized-raster-edge')
  x.page.graphicsBounds.at(-1).normalizedRect[3] = 0.65
  expect(match(x).rect[3]).toBeGreaterThan(500)
})
it.each(['missing frames', 'empty frame', 'detached path', 'competing caption'])(
  'rejects a top-caption native tree with %s',
  (kind) => {
    const x = load('top-caption-above-populated-branching-flow')
    if (kind === 'missing frames') x.frames = []
    if (kind === 'empty frame') x.frames.push([10, 300, 60, 330])
    if (kind === 'detached path')
      x.page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.02, 0.4, 0.06, 0.5] })
    if (kind === 'competing caption')
      x.captions.push({
        page: 1,
        lines: ['Figure 2. Independent flow.'],
        rect: [200, 300, 350, 312]
      })
    expect(
      topCaptionedNativeFlow(x.page, x.captions[0], x.captions, x.tableRects, x.frames)
    ).toBeUndefined()
  }
)
it('does not append an abbreviation definition without both owned node keys', () => {
  const x = load('flowchart-with-node-key-definitions')
  x.page.lines = x.page.lines.filter((l: { text: string }) => !/^(?:AA|BB)$/.test(l.text))
  expect(match(x).rect[3]).toBeLessThan(707)
})
it('does not exempt paragraph-like titles without explicit native panel references', () => {
  const x = load('eight-vector-panels-with-long-native-titles')
  x.captions[0].lines = ['Figure 1. Native plot.']
  expect(match(x).rect[1]).toBeGreaterThan(350)
})

const centeredTitle = (label: string): ReturnType<typeof JSON.parse> => ({
  page: {
    pageNumber: 1,
    width: 640,
    height: 800,
    lines: [
      { text: label, fontSize: 8, x: 300, y: 51.3555, width: 40, height: 8 },
      {
        text: 'Means and Dispersions of Measured Outcomes at Two Assessments',
        fontSize: 8,
        x: 160,
        y: 62.9555,
        width: 320,
        height: 8
      },
      {
        text: 'By the Allocated Study Groups and Planned Visits',
        fontSize: 8,
        x: 180,
        y: 72.5555,
        width: 280,
        height: 8
      },
      {
        text: 'Measure First group Second group P',
        fontSize: 8,
        x: 80,
        y: 88.211,
        width: 400,
        height: 8
      }
    ]
  },
  rules: [
    [72, 86.5555, 228, 86.5555],
    [228, 86.5555, 387, 86.5555],
    [387, 86.5555, 568, 86.5555]
  ]
})
it.each(['tablE 1', 'TABLE 1 (cont’d)'])(
  'keeps both centered title lines above segmented native opening: %s',
  (label) => {
    const x = centeredTitle(label)
    expect(findCaptionCandidates([x.page], new Map([[1, x.rules]]))[0].lines).toHaveLength(3)
  }
)
it.each(['missing rule', 'gutter', 'font change', 'different center'])(
  'does not combine a centered title with %s',
  (kind) => {
    const x = centeredTitle('TABLE 1')
    if (kind === 'missing rule') x.rules = []
    if (kind === 'gutter') x.rules[1][0] += 20
    if (kind === 'font change') x.page.lines[2].fontSize = 12
    if (kind === 'different center') x.page.lines[2].x += 30
    expect(findCaptionCandidates([x.page], new Map([[1, x.rules]]))[0].lines.length).toBeLessThan(3)
  }
)

const statisticalContinuation = (): ReturnType<typeof JSON.parse> => {
  const line = (text: string, y: number, width = 440): ReturnType<typeof JSON.parse> => ({
    text,
    fontSize: 10,
    height: 10,
    x: 90,
    y,
    width
  })
  const title = { page: 1, lines: ['Table 2. Native Measured Effects'], rect: [72, 363, 302, 375] }
  const first = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      { text: 'Earlier native record', fontSize: 9, height: 9, x: 90, y: 290, width: 390 },
      { text: title.lines[0], fontSize: 12, height: 12, x: 72, y: 363, width: 230 }
    ]
  }
  const middle = {
    pageNumber: 2,
    width: 600,
    height: 800,
    lines: [
      line('Estimate 1.2 2.3 3.4', 168),
      line('Error 0.1 0.2 0.3', 185),
      line('Effect Size 0.2 0.3 0.4', 202),
      line('Estimate 1.2 2.3 3.4', 690),
      line('Error 0.1 0.2 0.3', 725),
      line('Effect Size 0.2 0.3 0.4', 742)
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [72 / 600, 79 / 800, 544 / 600, 81 / 800] },
      { kind: 'path', normalizedRect: [72 / 600, 759 / 800, 544 / 600, 761 / 800] }
    ]
  }
  const last = {
    pageNumber: 3,
    width: 600,
    height: 800,
    lines: [
      line('Estimate 1.2 2.3 3.4', 89, 380),
      line('Error 0.1 0.2 0.3', 123, 380),
      line('Effect Size 0.2 0.3 0.4', 140, 380),
      line('Estimate 1.2 2.3 3.4', 193, 380),
      line('Error 0.1 0.2 0.3', 210, 380),
      line('Effect Size 0.2 0.3 0.4', 228, 380)
    ]
  }
  return { title, first, middle, last }
}
it.each([2, 3])(
  'links a terminal native table title through a proved statistical frame on page %s',
  (page) => {
    const x = statisticalContinuation(),
      p = page === 2 ? x.middle : x.last
    const rect = page === 2 ? [67, 117, 545, 752] : [69, 89, 480, 238]
    const rules =
      page === 2
        ? [
            [72, 80, 544, 80],
            [72, 760, 544, 760]
          ]
        : [
            [72, 72, 544, 72],
            [72, 245, 544, 245]
          ]
    expect(
      associateTableCaptions(p, [{ rect }], [x.title], rules, [x.first, x.middle, x.last])[0]
        .caption
    ).toEqual(x.title)
  }
)
it.each(['later prose', 'missing native frame', 'different stub', 'different font', 'new caption'])(
  'does not inherit a statistical title with %s',
  (kind) => {
    const x = statisticalContinuation(),
      captions = [x.title]
    let rules = [
      [72, 72, 544, 72],
      [72, 245, 544, 245]
    ]
    if (kind === 'later prose')
      x.first.lines.push({
        text: 'Independent native paragraph',
        fontSize: 12,
        height: 12,
        x: 72,
        y: 400,
        width: 230
      })
    if (kind === 'missing native frame') rules = []
    if (kind === 'different stub') x.last.lines.forEach((l: { x: number }) => (l.x += 30))
    if (kind === 'different font')
      x.last.lines.forEach((l: { fontSize: number }) => (l.fontSize = 12))
    if (kind === 'new caption')
      captions.push({ page: 2, lines: ['Table 3. Independent Records'], rect: [72, 60, 302, 72] })
    expect(
      associateTableCaptions(x.last, [{ rect: [69, 89, 480, 238] }], captions, rules, [
        x.first,
        x.middle,
        x.last
      ])[0].caption
    ).not.toEqual(x.title)
  }
)

const terminalFontOverhang = (): ReturnType<typeof statisticalContinuation> => {
  const x = statisticalContinuation()
  x.last.lines.unshift({ text: 'Heading', fontSize: 10, height: 10, x: 77, y: 71.64, width: 25 })
  return x
}

it('links a native terminal title when only the first stub font box grazes its opening', () => {
  const x = terminalFontOverhang()
  expect(
    associateTableCaptions(
      x.last,
      [{ rect: [72, 71.64, 544, 245] }],
      [x.title],
      [
        [72, 72, 544, 72],
        [72, 245, 544, 245]
      ],
      [x.first, x.middle, x.last]
    )[0].caption
  ).toEqual(x.title)
})

it.each([
  'larger overlap',
  'low baseline',
  'foreign glyph',
  'duplicate glyph',
  'competing opening',
  'different font'
])('rejects terminal opening overhang with %s', (kind) => {
  const x = terminalFontOverhang()
  const rect = [72, 71.64, 544, 245]
  const rules = [
    [72, 72, 544, 72],
    [72, 245, 544, 245]
  ]
  if (kind === 'larger overlap') {
    x.last.lines[0].y = 71.4
    rect[1] = 71.4
  }
  if (kind === 'low baseline') x.last.lines[0].height = 0.5
  if (kind === 'foreign glyph') x.last.lines[0].x = 65
  if (kind === 'duplicate glyph') x.last.lines.push({ ...x.last.lines[0], x: 150 })
  if (kind === 'competing opening') rules.push([72, 71.9, 544, 71.9])
  if (kind === 'different font') x.last.lines[0].fontSize = 14
  expect(
    associateTableCaptions(x.last, [{ rect }], [x.title], rules, [x.first, x.middle, x.last])[0]
      .caption
  ).toBeUndefined()
})
