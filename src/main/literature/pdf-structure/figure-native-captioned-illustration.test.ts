import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const {
  nativeCaptionedRaster,
  nativeCaptionedVectorHeatmap,
  nativeCaptionedWorkflowPanel,
  nativeCaptionedVectorDiagram,
  nativeCaptionedVectorGrid,
  nativeCaptionedFramedRaster,
  nativeCaptionedFramedRasterTextPanel,
  nativeCaptionedRasterArrayFragment,
  nativeCaptionedRasterQuad,
  nativeCaptionedRasterDualPanelGrid,
  nativeCaptionedRasterModerateGap,
  nativeCaptionedTextIllustration,
  nativeLetteredRasterArray,
  nativeRasterGrid
} = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-figure-native-captioned-illustration.mjs')
  ).href
)
const framedBefore = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/caption-before-stacked-framed-raster.jsonl'
    )
  )
const framedAfter = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/caption-after-stacked-framed-raster.jsonl'
    )
  )
const framedTextPanel = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/captioned-ui-raster-text-panel.jsonl'
    )
  )
const wideRasterWithUnrelatedPaths = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/wide-raster-with-unrelated-paths.jsonl'
    )
  )
const framedVectorPromptCard = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/framed-vector-prompt-card.jsonl'
    )
  )
const captionedVectorStageDiagram = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/captioned-vector-stage-diagram.jsonl'
    )
  )
const captionedVectorGrid = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/captioned-vector-grid.jsonl')
  )
const vectorHeatmap = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/vector-success-heatmap.jsonl')
  )
const workflowScreenshot = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/workflow-screenshot-trajectory.jsonl'
    )
  )
const rasterQuad = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/captioned-raster-quad.jsonl')
  )
const dualPanelRasterGrid = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/captioned-dual-panel-four-row-raster.jsonl'
    )
  )
const rasterModerateGap = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/captioned-raster-moderate-gap.jsonl'
    )
  )

it.each([
  ['caption before', framedBefore, [60, 140, 540, 300]],
  ['caption after', framedAfter, [60, 120, 540, 308]]
])('recovers only the nearest framed raster when %s', (_label, load, expected) => {
  const fixture = load()
  expect(
    nativeCaptionedFramedRaster(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual(expected)
})

it('rejects a framed raster claimed by a competing caption', () => {
  const fixture = framedBefore()
  const competing = { page: 1, lines: ['Figure 2. Neighbor.'], rect: [50, 130, 550, 310] }
  expect(
    nativeCaptionedFramedRaster(fixture.page, fixture.caption, [fixture.caption, competing], [])
  ).toBeUndefined()
})

it('recovers a framed raster-plus-text response panel at the outer frame', () => {
  const fixture = framedTextPanel()
  expect(
    nativeCaptionedFramedRasterTextPanel(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([60, 120, 540, 600])
  expect(associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect).toEqual([
    60, 120, 540, 600
  ])
})

it('recovers a pure vector prompt card when an inset frame proves its ownership', () => {
  const fixture = framedVectorPromptCard()
  expect(
    nativeCaptionedTextIllustration(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([69.328125, 71.15625, 545.0625, 309.375])
  expect(associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect).toEqual([
    69.328125, 71.15625, 545.0625, 309.375
  ])
})

it('recovers a staged vector diagram from its outer frame and repeated image marks', () => {
  const fixture = captionedVectorStageDiagram()
  expect(
    nativeCaptionedVectorDiagram(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([71.71875, 204.1875, 542.671875, 408.375])
  expect(associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect).toEqual([
    71.71875, 204.1875, 542.671875, 408.375
  ])
})

it('recovers a narrow vector grid from an attached frame and repeated path lattice', () => {
  const fixture = captionedVectorGrid()
  expect(
    nativeCaptionedVectorGrid(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([306, 63.36, 544.6800000000001, 175.824])
  expect(associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect).toEqual([
    306, 63.36, 544.6800000000001, 175.824
  ])
})

it('rejects a narrow vector grid when a table overlaps its frame', () => {
  const fixture = captionedVectorGrid()
  expect(
    nativeCaptionedVectorGrid(
      fixture.page,
      fixture.caption,
      [fixture.caption],
      [[306, 63, 545, 176]]
    )
  ).toBeUndefined()
})

it('rejects a narrow vector grid claimed by a competing caption', () => {
  const fixture = captionedVectorGrid(),
    competing = { page: 1, lines: ['Figure 7. Neighbor.'], rect: [300, 90, 550, 110] }
  expect(
    nativeCaptionedVectorGrid(fixture.page, fixture.caption, [fixture.caption, competing], [])
  ).toBeUndefined()
})

it('recovers a dense native-vector success-rate heatmap under its caption', () => {
  const fixture = vectorHeatmap()
  expect(
    nativeCaptionedVectorHeatmap(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([100, 80, 453, 216])
  expect(associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect).toEqual([
    100, 80, 453, 216
  ])
})

it('ignores a disconnected vector grid above the local heatmap band', () => {
  const fixture = vectorHeatmap()
  const unrelated = Array.from({ length: 24 }, (_, index) => {
    const row = Math.floor(index / 6)
    const column = index % 6
    const left = 0.1 + column * 0.04
    const top = 0.005 + row * 0.018
    return {
      kind: 'path',
      normalizedRect: [left, top, left + 0.03, top + 0.012]
    }
  })
  fixture.page.graphicsBounds.push(...unrelated)
  expect(
    nativeCaptionedVectorHeatmap(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([100, 80, 453, 216])
})

it('recovers a connected workflow screenshot plate through its spanning path', () => {
  const fixture = workflowScreenshot()
  expect(
    nativeCaptionedWorkflowPanel(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([60, 70, 540, 340])
  expect(associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect).toEqual([
    60, 70, 540, 340
  ])
})

it('accepts a repeated full frame as the ownership witness for code cards', () => {
  const fixture = framedVectorPromptCard()
  fixture.page.graphicsBounds[1] = { ...fixture.page.graphicsBounds[0] }
  expect(
    nativeCaptionedTextIllustration(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([69.328125, 71.15625, 545.0625, 309.375])
})

it('rejects a framed raster-plus-text panel overlapping a table', () => {
  const fixture = framedTextPanel()
  expect(
    nativeCaptionedFramedRasterTextPanel(
      fixture.page,
      fixture.caption,
      [fixture.caption],
      [[60, 120, 540, 600]]
    )
  ).toBeUndefined()
})

it('uses the full border when painted raster bounds are inset', () => {
  const caption = {
    page: 26,
    lines: ['Figure 10. Recurrence summary.'],
    rect: [72, 289.44, 540.08, 481.44]
  }
  const page = {
    pageNumber: 26,
    width: 612,
    height: 792,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds: [
      {
        kind: 'image',
        normalizedRect: [0.1352, 0.0959, 0.871, 0.3305]
      },
      { kind: 'path', normalizedRect: [0.1171875, 0.08984375, 0.890625, 0.359375] },
      {
        kind: 'image',
        normalizedRect: [0.1171875, 0.62109375, 0.890625, 0.91015625]
      },
      { kind: 'path', normalizedRect: [0.1171875, 0.62109375, 0.890625, 0.91015625] }
    ]
  }
  expect(nativeCaptionedFramedRaster(page, caption, [caption], [])?.rect).toEqual([
    71.71875, 71.15625, 545.0625, 284.625
  ])
})

it('recovers a multi-row raster tile grid above its caption', () => {
  const caption = { page: 1, lines: ['Figure 12. Trajectory plate.'], rect: [60, 350, 540, 380] }
  const images = Array.from({ length: 15 }, (_, index) => {
    const column = index % 5
    const row = Math.floor(index / 5)
    return {
      kind: 'image',
      normalizedRect: [
        (100 + column * 80) / 600,
        (90 + row * 70) / 800,
        (150 + column * 80) / 600,
        (140 + row * 70) / 800
      ]
    }
  })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 60, y: 350, width: 480, height: 10, fontSize: 10 }],
    graphicsBounds: images
  }
  expect(nativeRasterGrid(page, caption, [caption], [])?.rect).toEqual([100, 90, 470, 280])
  expect(associateFigures(page, [caption], [], [], [], [])[0].rect).toEqual([100, 90, 470, 280])
})
it('does not merge a neighboring raster grid into the captioned grid', () => {
  const caption = { page: 1, lines: ['Figure 13. Target plate.'], rect: [380, 350, 710, 380] }
  const images = [10, 400].flatMap((left) =>
    Array.from({ length: 15 }, (_, index) => {
      const column = index % 5
      const row = Math.floor(index / 5)
      return {
        kind: 'image',
        normalizedRect: [
          (left + column * 60) / 720,
          (90 + row * 70) / 800,
          (left + column * 60 + 50) / 720,
          (140 + row * 70) / 800
        ]
      }
    })
  )
  const page = {
    pageNumber: 1,
    width: 720,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 380, y: 350, width: 330, height: 10, fontSize: 10 }],
    graphicsBounds: images
  }
  expect(nativeRasterGrid(page, caption, [caption], [])?.rect).toEqual([400, 90, 690, 280])
})
it('recovers a strict 2x2 raster plate beside unrelated page content', () => {
  const fixture = rasterQuad()
  expect(
    nativeCaptionedRasterQuad(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([50.203125, 185.625, 296.4375, 340.3125])
  expect(associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect).toEqual([
    50.203125, 185.625, 296.4375, 340.3125
  ])
})
it('rejects the 2x2 raster plate when a table overlaps its image bounds', () => {
  const fixture = rasterQuad()
  expect(
    nativeCaptionedRasterQuad(
      fixture.page,
      fixture.caption,
      [fixture.caption],
      [[40, 100, 560, 345]]
    )
  ).toBeUndefined()
})
it('recovers a unique narrow-column raster with a moderate caption gap', () => {
  const fixture = rasterModerateGap()
  const match = nativeCaptionedRasterModerateGap(
    fixture.page,
    fixture.caption,
    [fixture.caption],
    []
  )
  expect(match?.rect[0]).toBeCloseTo(50.2)
  expect(match?.rect[1]).toBeCloseTo(451.7)
  expect(match?.rect[2]).toBeCloseTo(296.4)
  expect(match?.rect[3]).toBeCloseTo(535.2)
  const associated = associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect
  expect(associated?.[0]).toBeCloseTo(50.2)
  expect(associated?.[1]).toBeCloseTo(451.7)
})
it('rejects the moderate-gap raster when a competing image is present', () => {
  const fixture = rasterModerateGap()
  fixture.page.graphicsBounds.push({ kind: 'image', normalizedRect: [0.6, 0.2, 0.9, 0.4] })
  expect(
    nativeCaptionedRasterModerateGap(fixture.page, fixture.caption, [fixture.caption], [])
  ).toBeUndefined()
})
it('recovers a complete four-row dual-panel raster plate', () => {
  const fixture = dualPanelRasterGrid()
  const rect = nativeCaptionedRasterDualPanelGrid(
    fixture.page,
    fixture.caption,
    [fixture.caption],
    []
  )?.rect
  expect(rect?.slice(0, 2)).toEqual([90, 100])
  expect(rect?.[2]).toBeCloseTo(470)
  expect(rect?.[3]).toBe(325)
  const associated = associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect
  expect(associated?.slice(0, 2)).toEqual([90, 100])
  expect(associated?.[2]).toBeCloseTo(470)
  expect(associated?.[3]).toBe(325)
})
it('rejects a dual-panel raster plate when one row is incomplete', () => {
  const fixture = dualPanelRasterGrid()
  fixture.page.graphicsBounds = fixture.page.graphicsBounds.slice(0, -1)
  expect(
    nativeCaptionedRasterDualPanelGrid(fixture.page, fixture.caption, [fixture.caption], [])
  ).toBeUndefined()
})
const plate = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/unequal-lettered-raster-plate.jsonl'
    )
  )
it('owns every unequal raster and attached key under the centered caption', () => {
  const f = plate()
  const match = associateFigures(f.page, [f.caption], [], [], [], f.tokens)[0]
  expect(match.rect).toEqual([30, 120, 570, 485])
})
it('keeps a left-column vector figure when a right-column plot has its own caption', () => {
  const left = {
    page: 1,
    lines: ['Fig. C.2. Semantic preference simplex.'],
    rect: [50, 220, 300, 255]
  }
  const right = { page: 1, lines: ['Fig. D.1. Training behavior.'], rect: [310, 400, 560, 435] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: left.lines[0], x: 50, y: 220, width: 250, height: 10, fontSize: 10 },
      { text: right.lines[0], x: 310, y: 400, width: 250, height: 10, fontSize: 10 }
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [80 / 600, 60 / 800, 250 / 600, 205 / 800] },
      { kind: 'path', normalizedRect: [340 / 600, 150 / 800, 540 / 600, 370 / 800] }
    ]
  }
  const [figure] = associateFigures(page, [left, right], [], [], [], [])
  expect(figure.rect).toEqual([80, 60, 250, expect.closeTo(205)])
})
it('recovers a single chart tightly attached to a narrow-column caption', () => {
  const caption = {
    page: 1,
    lines: ['FIGURE 4: Experimentally characterized relationship.'],
    rect: [36, 408, 293, 430]
  }
  const page = {
    pageNumber: 1,
    width: 612,
    height: 792,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 36, y: 408, width: 257, height: 10, fontSize: 10 }],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [64 / 612, 233 / 792, 282 / 612, 405 / 792] },
      { kind: 'image', normalizedRect: [78 / 612, 461 / 792, 302 / 612, 660 / 792] }
    ]
  }
  expect(nativeCaptionedRaster(page, caption, [caption], [])?.rect).toEqual([
    64,
    expect.closeTo(233),
    282,
    405
  ])
})
it('recovers a wide raster chart when unrelated paths are elsewhere on the page', () => {
  const fixture = wideRasterWithUnrelatedPaths()
  expect(nativeCaptionedRaster(fixture.page, fixture.caption, [fixture.caption], [])?.rect).toEqual(
    [expect.closeTo(70), expect.closeTo(80), expect.closeTo(530), expect.closeTo(205)]
  )
})
it('keeps raster recovery deferred when a path touches the image', () => {
  const fixture = wideRasterWithUnrelatedPaths()
  fixture.page.graphicsBounds.push({
    kind: 'path',
    normalizedRect: [0.2, 0.15, 0.3, 0.2]
  })
  expect(
    nativeCaptionedRaster(fixture.page, fixture.caption, [fixture.caption], [])
  ).toBeUndefined()
})
const fragmentedPlate = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/fragmented-lettered-raster-plate.jsonl'
    )
  )
it('recovers a unique 2x2 raster plate when its Fig.2 prefix is split from the caption', () => {
  const f = fragmentedPlate()
  const match = nativeCaptionedRasterArrayFragment(f.page, f.caption, [f.caption], [])
  expect(match?.rect).toEqual([60, 40, 480, 400])
  expect(match?.caption).toBe(f.caption)
  expect(match?.captionLines?.[0]).toMatch(/^Fig\.2\./)
  expect(match?.captionRect).toEqual(expect.arrayContaining([f.caption.rect[0], f.caption.rect[1]]))
  expect(associateFigures(f.page, [f.caption], [], [], [], [])[0].rect).toEqual([60, 40, 480, 400])
})
it('does not apply fragmented raster recovery to an open vector plot', () => {
  const f = fragmentedPlate()
  f.page.graphicsBounds = [
    { kind: 'path', normalizedRect: [0.1, 0.1, 0.8, 0.6] },
    { kind: 'path', normalizedRect: [0.2, 0.2, 0.7, 0.5] }
  ]
  expect(nativeCaptionedRasterArrayFragment(f.page, f.caption, [f.caption], [])).toBeUndefined()
})
it('recovers a framed text figure when the body font is close to the caption font', () => {
  const caption = { page: 1, lines: ['Figure 8. Verification prompt.'], rect: [50, 295, 550, 325] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: caption.lines[0], x: 50, y: 295, width: 500, height: 10, fontSize: 10 },
      ...Array.from({ length: 4 }, (_, index) => ({
        text: `A framed verification instruction line ${index} with enough text to prove ownership.`,
        x: 80,
        y: 100 + index * 20,
        width: 420,
        height: 9,
        fontSize: 9
      }))
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [0.1, 0.1, 0.9, 0.35] },
      { kind: 'path', normalizedRect: [0.1, 0.12, 0.9, 0.35] }
    ]
  }
  expect(nativeCaptionedTextIllustration(page, caption, [caption], [])?.rect).toEqual([
    60, 80, 540, 280
  ])
})
it('recovers a text figure whose frame is drawn as four aligned segments', () => {
  const caption = { page: 1, lines: ['Figure 9. Constructed checks.'], rect: [50, 295, 550, 325] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: caption.lines[0], x: 50, y: 295, width: 500, height: 10, fontSize: 10 },
      ...Array.from({ length: 5 }, (_, index) => ({
        text: `A framed check line ${index} keeps enough explanatory text for ownership.`,
        x: 80,
        y: 100 + index * 20,
        width: 420,
        height: 10,
        fontSize: 10
      }))
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [60 / 600, 80 / 800, 540 / 600, 90 / 800] },
      { kind: 'path', normalizedRect: [60 / 600, 270 / 800, 540 / 600, 280 / 800] },
      { kind: 'path', normalizedRect: [60 / 600, 80 / 800, 70 / 600, 280 / 800] },
      { kind: 'path', normalizedRect: [530 / 600, 80 / 800, 540 / 600, 280 / 800] }
    ]
  }
  expect(nativeCaptionedTextIllustration(page, caption, [caption], [])?.rect).toEqual([
    60, 80, 540, 280
  ])
})
it('rejects a segmented frame that overlaps a table crop', () => {
  const caption = { page: 1, lines: ['Figure 10. Framed table.'], rect: [50, 295, 550, 325] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: caption.lines[0], x: 50, y: 295, width: 500, height: 10, fontSize: 10 },
      ...Array.from({ length: 5 }, (_, index) => ({
        text: `A framed table row ${index} with enough explanatory text for ownership.`,
        x: 80,
        y: 100 + index * 20,
        width: 420,
        height: 10,
        fontSize: 10
      }))
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [60 / 600, 80 / 800, 540 / 600, 90 / 800] },
      { kind: 'path', normalizedRect: [60 / 600, 270 / 800, 540 / 600, 280 / 800] },
      { kind: 'path', normalizedRect: [60 / 600, 80 / 800, 70 / 600, 280 / 800] },
      { kind: 'path', normalizedRect: [530 / 600, 80 / 800, 540 / 600, 280 / 800] }
    ]
  }
  expect(
    nativeCaptionedTextIllustration(page, caption, [caption], [[60, 80, 540, 280]])
  ).toBeUndefined()
})
it.each([
  'missing-key',
  'broken-key',
  'duplicate-key',
  'wrong-sequence',
  'foreign-prose',
  'table',
  'caption'
])('declines unproved lettered plates: %s', (reason) => {
  const f = plate(),
    tables: number[][] = [],
    captions = [f.caption]
  if (reason === 'missing-key') f.tokens.pop()
  if (reason === 'broken-key') f.tokens[2].baseline += 2
  if (reason === 'duplicate-key') f.tokens.push({ ...f.tokens.at(-1) })
  if (reason === 'wrong-sequence') f.caption.lines[0] = f.caption.lines[0].replace('(f)', '(g)')
  if (reason === 'foreign-prose')
    f.tokens.push({
      text: 'Independent source paragraph inside the crop area.',
      rect: [100, 260, 450, 270],
      horizontal: true,
      height: 10,
      baseline: 270
    })
  if (reason === 'table') tables.push([300, 300, 400, 400])
  if (reason === 'caption')
    captions.push({ page: 1, lines: ['Figure 2. Other.'], rect: [40, 300, 180, 310] })
  expect(nativeLetteredRasterArray(f.page, f.caption, captions, tables, f.tokens)).toBeUndefined()
})
const illustratedText = (): ReturnType<typeof JSON.parse> => {
  const caption = { page: 1, lines: ['Figure 2. Source illustration.'], rect: [50, 180, 550, 190] }
  return {
    caption,
    page: {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: [
        ...Array.from({ length: 7 }, (_, i) => ({
          text: `${i}: ${'Synthetic text '.repeat(6)}`,
          x: 80,
          y: 75 + i * 12,
          width: 430,
          height: 5,
          fontSize: 5
        })),
        { text: caption.lines[0], x: 50, y: 180, width: 500, height: 10, fontSize: 10 }
      ],
      graphicsBounds: [{ kind: 'path', normalizedRect: [50 / 600, 65 / 800, 550 / 600, 175 / 800] }]
    }
  }
}
it.each(['body-font', 'table', 'competing-caption', 'far-caption', 'incomplete-content'])(
  'declines an unproved text illustration: %s',
  (reason) => {
    const f = illustratedText(),
      tables: number[][] = [],
      captions = [f.caption]
    if (reason === 'body-font')
      f.page.lines.slice(0, 7).forEach((line: { fontSize?: number }) => (line.fontSize = 10))
    if (reason === 'table') tables.push([50, 80, 550, 150])
    if (reason === 'competing-caption')
      captions.push({ page: 1, lines: ['Figure 3. Other.'], rect: [60, 90, 200, 100] })
    if (reason === 'far-caption') f.caption.rect[1] = 230
    if (reason === 'incomplete-content') f.page.lines = f.page.lines.slice(-3)
    expect(nativeCaptionedTextIllustration(f.page, f.caption, captions, tables)).toBeUndefined()
  }
)
