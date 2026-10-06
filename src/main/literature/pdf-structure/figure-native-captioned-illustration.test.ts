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
  nativeCaptionedVectorTableGrid,
  nativeCaptionedVectorBarChart,
  nativeCaptionedFramedRaster,
  nativeCaptionedFramedRasterTextPanel,
  nativeCaptionedRasterArrayFragment,
  nativeCaptionedRasterQuad,
  nativeCaptionedRasterHorizontalArray,
  nativeCaptionedRasterSideBySide,
  nativeCaptionedRasterCompositeGrid,
  nativeCaptionedRasterFullWidth,
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
const stackedVectorPlates = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/stacked-vector-plates.jsonl')
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

it('keeps a composite outer frame when an inset raster has its own border', () => {
  const caption = {
    page: 1,
    lines: ['Figure 12. Composite workflow panel.', 'The complete workflow is shown above.'],
    rect: [60, 480, 540, 520]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: 'Prompt', x: 90, y: 130, width: 100, height: 12, fontSize: 10 },
      { text: 'Input and output', x: 90, y: 220, width: 160, height: 12, fontSize: 10 },
      { text: 'Model response', x: 90, y: 260, width: 160, height: 12, fontSize: 10 },
      {
        text: 'Figure 12. Composite workflow panel.',
        x: 60,
        y: 480,
        width: 480,
        height: 12,
        fontSize: 10
      },
      {
        text: 'The complete workflow is shown above.',
        x: 60,
        y: 496,
        width: 420,
        height: 12,
        fontSize: 10
      }
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [60 / 600, 100 / 800, 540 / 600, 470 / 800] },
      { kind: 'image', normalizedRect: [90 / 600, 300 / 800, 300 / 600, 466 / 800] },
      { kind: 'path', normalizedRect: [90 / 600, 300 / 800, 300 / 600, 466 / 800] }
    ]
  }
  expect(nativeCaptionedFramedRaster(page, caption, [caption], [])).toBeUndefined()
  expect(nativeCaptionedFramedRasterTextPanel(page, caption, [caption], [])?.rect).toEqual([
    60, 100, 540, 470
  ])
  expect(associateFigures(page, [caption], [], [], [], [])[0].rect).toEqual([60, 100, 540, 470])
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

it('recovers a compact vector table diagram without an outer frame', () => {
  const caption = {
    page: 1,
    lines: ['Figure 8: Sample table diagram.'],
    rect: [60, 220, 540, 235]
  }
  const toNormalized = (rect: number[]): number[] =>
    rect.map((value, index) => value / (index % 2 ? 800 : 600))
  const paths = [
    [180, 110, 420, 116],
    [180, 140, 420, 146],
    [180, 170, 420, 176],
    [180, 200, 420, 206],
    ...[180, 240, 300, 360, 420].flatMap((x) => [
      [x, 110, x + 6, 146],
      [x, 140, x + 6, 176],
      [x, 170, x + 6, 206]
    ])
  ]
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: caption.lines[0], x: 60, y: 220, width: 280, height: 10, fontSize: 9 },
      { text: '(1, 1) (1, 2)', x: 190, y: 118, width: 100, height: 10, fontSize: 9 },
      { text: '(2, 1) (2, 2)', x: 190, y: 148, width: 100, height: 10, fontSize: 9 },
      { text: '(3, 1) (3, 2)', x: 190, y: 178, width: 100, height: 10, fontSize: 9 }
    ],
    graphicsBounds: paths.map((rect) => ({ kind: 'path', normalizedRect: toNormalized(rect) }))
  }
  const vectorRect = nativeCaptionedVectorTableGrid(page, caption, [caption], [])?.rect
  expect(vectorRect?.[0]).toBeCloseTo(180)
  expect(vectorRect?.[1]).toBeCloseTo(110)
  expect(vectorRect?.[2]).toBeCloseTo(426)
  expect(vectorRect?.[3]).toBeCloseTo(206)
  const associatedVectorRect = associateFigures(page, [caption], [], [], [], [])[0].rect
  expect(associatedVectorRect?.[0]).toBeCloseTo(180)
  expect(associatedVectorRect?.[1]).toBeCloseTo(110)
  expect(associatedVectorRect?.[2]).toBeCloseTo(426)
  expect(associatedVectorRect?.[3]).toBeCloseTo(206)
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

const horizontalRasterArray = (): ReturnType<typeof JSON.parse> => {
  const caption = {
    page: 1,
    lines: ['Figure 11. Four panel comparison.'],
    rect: [50, 280, 550, 295]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      {
        text: '(a) Original (b) Groundtruth (c) BERT (d) LayoutLM',
        x: 70,
        y: 257,
        width: 460,
        height: 8,
        fontSize: 8
      },
      { text: caption.lines[0], x: 50, y: 280, width: 500, height: 10, fontSize: 10 }
    ],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [60 / 600, 100 / 800, 170 / 600, 260 / 800] },
      { kind: 'image', normalizedRect: [180 / 600, 100 / 800, 290 / 600, 260 / 800] },
      { kind: 'image', normalizedRect: [300 / 600, 100 / 800, 410 / 600, 260 / 800] },
      { kind: 'image', normalizedRect: [420 / 600, 100 / 800, 530 / 600, 260 / 800] }
    ]
  }
  return { page, caption }
}

it('recovers every panel in a captioned horizontal raster strip', () => {
  const fixture = horizontalRasterArray()
  expect(
    nativeCaptionedRasterHorizontalArray(fixture.page, fixture.caption, [fixture.caption], [])?.rect
  ).toEqual([60, 100, 530, 260])
  expect(associateFigures(fixture.page, [fixture.caption], [], [], [], [])[0].rect).toEqual([
    60, 100, 530, 260
  ])
})

it('rejects a horizontal raster strip with a missing panel', () => {
  const fixture = horizontalRasterArray()
  fixture.page.graphicsBounds.pop()
  expect(
    nativeCaptionedRasterHorizontalArray(fixture.page, fixture.caption, [fixture.caption], [])
  ).toBeUndefined()
})

it('recovers a five-panel raster strip without requiring a four-panel legend', () => {
  const caption = {
    page: 1,
    lines: ['Figure 14: Sample misannotated tables.'],
    rect: [50, 230, 550, 245]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 50, y: 230, width: 500, height: 10, fontSize: 9 }],
    graphicsBounds: Array.from({ length: 5 }, (_, index) => ({
      kind: 'image',
      normalizedRect: [(60 + index * 105) / 600, 90 / 800, (145 + index * 105) / 600, 195 / 800]
    }))
  }
  expect(nativeCaptionedRasterHorizontalArray(page, caption, [caption], [])?.rect).toEqual([
    60, 90, 565, 195
  ])
  expect(associateFigures(page, [caption], [], [], [], [])[0].rect).toEqual([60, 90, 565, 195])
})

it('recovers a seven-panel raster strip below a preceding figure', () => {
  const upperCaption = {
      page: 1,
      lines: ['Figure 13. Upper raster plate.'],
      rect: [50, 230, 550, 245]
    },
    caption = {
      page: 1,
      lines: ['Figure 14. Visualizations at different time steps.'],
      rect: [50, 390, 550, 415]
    },
    page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: [
        { text: upperCaption.lines[0], x: 50, y: 230, width: 500, height: 10, fontSize: 9 },
        { text: caption.lines[0], x: 50, y: 390, width: 500, height: 10, fontSize: 9 }
      ],
      graphicsBounds: [
        ...Array.from({ length: 7 }, (_, index) => ({
          kind: 'image',
          normalizedRect: [(60 + index * 74) / 600, 80 / 800, (125 + index * 74) / 600, 155 / 800]
        })),
        ...Array.from({ length: 7 }, (_, index) => ({
          kind: 'image',
          normalizedRect: [(60 + index * 74) / 600, 300 / 800, (125 + index * 74) / 600, 375 / 800]
        }))
      ]
    }
  const result = nativeCaptionedRasterHorizontalArray(page, caption, [upperCaption, caption], [])
  expect(result?.rect).toEqual([60, 300, 569, 375])
  expect(result?.graphicsCount).toBe(7)
  expect(associateFigures(page, [upperCaption, caption], [], [], [], [])).toContainEqual(
    expect.objectContaining({ caption, rect: [60, 300, 569, 375] })
  )
})

it('recovers a strictly aligned two-panel raster plate', () => {
  const caption = {
    page: 1,
    lines: ['Figure 15: Side-by-side comparison.'],
    rect: [50, 520, 550, 550]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 50, y: 520, width: 500, height: 10, fontSize: 10 }],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [90 / 600, 180 / 800, 285 / 600, 440 / 800] },
      { kind: 'image', normalizedRect: [310 / 600, 182 / 800, 505 / 600, 442 / 800] }
    ]
  }
  expect(nativeCaptionedRasterSideBySide(page, caption, [caption], [])?.rect).toEqual([
    90, 180, 505, 442
  ])
  expect(associateFigures(page, [caption], [], [], [], [])[0]).toMatchObject({
    rect: [90, 180, 505, 442],
    reason: 'native-raster-side-by-side'
  })
})

it('rejects a side-by-side plate when a third image shares the caption band', () => {
  const caption = {
    page: 1,
    lines: ['Figure 16: Side-by-side comparison.'],
    rect: [50, 520, 550, 550]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 50, y: 520, width: 500, height: 10, fontSize: 10 }],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [90 / 600, 180 / 800, 285 / 600, 440 / 800] },
      { kind: 'image', normalizedRect: [310 / 600, 182 / 800, 505 / 600, 442 / 800] },
      { kind: 'image', normalizedRect: [20 / 600, 180 / 800, 180 / 600, 420 / 800] }
    ]
  }
  expect(nativeCaptionedRasterSideBySide(page, caption, [caption], [])).toBeUndefined()
})

it('separates a lower raster grid after an intervening figure caption', () => {
  const upperCaption = {
      page: 1,
      lines: ['Figure 20. Upper plate.'],
      rect: [50, 225, 550, 245]
    },
    lowerCaption = {
      page: 1,
      lines: ['Figure 21. Lower plate.'],
      rect: [50, 445, 550, 465]
    },
    page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: [
        { text: upperCaption.lines[0], x: 50, y: 225, width: 500, height: 10, fontSize: 9 },
        { text: lowerCaption.lines[0], x: 50, y: 445, width: 500, height: 10, fontSize: 9 }
      ],
      graphicsBounds: Array.from({ length: 12 }, (_, index) => {
        const plate = index < 6 ? 0 : 1
        const local = index % 6
        const row = Math.floor(local / 3)
        const column = local % 3
        return {
          kind: 'image',
          normalizedRect: [
            (80 + column * 135) / 600,
            (80 + plate * 220 + row * 70) / 800,
            (190 + column * 135) / 600,
            (135 + plate * 220 + row * 70) / 800
          ]
        }
      })
    },
    match = associateFigures(page, [upperCaption, lowerCaption], [], [], [], []).find(
      (candidate: { caption: unknown }) => candidate.caption === lowerCaption
    )

  expect(match?.rect?.[0]).toBeCloseTo(80)
  expect(match?.rect?.[1]).toBeCloseTo(300)
  expect(match?.rect?.[2]).toBeCloseTo(460)
  expect(match?.rect?.[3]).toBeCloseTo(425)
})

it('prioritizes a complete horizontal strip over a later single-panel figure', () => {
  const fixture = horizontalRasterArray()
  const lowerCaption = {
    page: 1,
    lines: ['Figure 12. Physical execution.'],
    rect: [50, 510, 320, 525]
  }
  fixture.page.lines.push({
    text: lowerCaption.lines[0],
    x: 50,
    y: 510,
    width: 270,
    height: 10,
    fontSize: 9
  })
  fixture.page.graphicsBounds.push(
    { kind: 'image', normalizedRect: [60 / 600, 300 / 800, 300 / 600, 500 / 800] },
    { kind: 'path', normalizedRect: [60 / 600, 300 / 800, 300 / 600, 500 / 800] }
  )
  const matches = associateFigures(fixture.page, [fixture.caption, lowerCaption], [], [], [], [])
  expect(
    matches.find((match: { caption: unknown }) => match.caption === fixture.caption)?.rect
  ).toEqual([60, 100, 530, 260])
})

it('recovers a multi-row raster composite without dropping its upper panels', () => {
  const caption = {
    page: 1,
    lines: ['Figure 15. Composite dataset overview.'],
    rect: [50, 690, 550, 710]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 50, y: 690, width: 500, height: 10, fontSize: 9 }],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [90 / 600, 120 / 800, 250 / 600, 250 / 800] },
      { kind: 'image', normalizedRect: [270 / 600, 120 / 800, 430 / 600, 250 / 800] },
      { kind: 'image', normalizedRect: [90 / 600, 280 / 800, 230 / 600, 410 / 800] },
      { kind: 'image', normalizedRect: [245 / 600, 280 / 800, 385 / 600, 410 / 800] },
      { kind: 'image', normalizedRect: [90 / 600, 435 / 800, 430 / 600, 650 / 800] }
    ]
  }
  expect(nativeCaptionedRasterCompositeGrid(page, caption, [caption], [])?.rect).toEqual([
    90, 120, 430, 650
  ])
  expect(associateFigures(page, [caption], [], [], [], [])[0].rect).toEqual([90, 120, 430, 650])
})

it('recovers a two-row three-column raster composite', () => {
  const caption = {
    page: 1,
    lines: ['Figure 16. Three-column comparison.'],
    rect: [50, 510, 550, 530]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 50, y: 510, width: 500, height: 10, fontSize: 9 }],
    graphicsBounds: Array.from({ length: 6 }, (_, index) => {
      const row = Math.floor(index / 3)
      const column = index % 3
      return {
        kind: 'image',
        normalizedRect: [
          (80 + column * 145) / 600,
          (170 + row * 180) / 800,
          (210 + column * 145) / 600,
          (320 + row * 180) / 800
        ]
      }
    })
  }
  const rasterRect = nativeCaptionedRasterCompositeGrid(page, caption, [caption], [])?.rect
  expect(rasterRect?.[0]).toBeCloseTo(80)
  expect(rasterRect?.[1]).toBeCloseTo(170)
  expect(rasterRect?.[2]).toBeCloseTo(500)
  expect(rasterRect?.[3]).toBeCloseTo(500)
  const associatedRasterRect = associateFigures(page, [caption], [], [], [], [])[0].rect
  expect(associatedRasterRect?.[0]).toBeCloseTo(80)
  expect(associatedRasterRect?.[1]).toBeCloseTo(170)
  expect(associatedRasterRect?.[2]).toBeCloseTo(500)
  expect(associatedRasterRect?.[3]).toBeCloseTo(500)
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
it('separates stacked vector plates at the upper caption boundary', () => {
  const fixture = stackedVectorPlates()
  const matches = associateFigures(fixture.page, fixture.captions, [], [], [], [])
  expect(matches).toHaveLength(2)
  expect(matches[0].rect?.[1]).toBeCloseTo(136.1, 0)
  expect(matches[0].rect?.[3]).toBeCloseTo(272.3, 0)
  expect(matches[1].rect?.[1]).toBeCloseTo(464.1, 0)
  expect(matches[1].rect?.[3]).toBeCloseTo(600.2, 0)
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
it('recovers a full-width raster above a lower competing region', () => {
  const caption = {
    page: 1,
    lines: ['Figure 15. Time-frequency representation.'],
    rect: [50, 300, 550, 315]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 50, y: 300, width: 500, height: 10, fontSize: 10 }],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [60 / 600, 80 / 800, 540 / 600, 292 / 800] },
      { kind: 'image', normalizedRect: [60 / 600, 350 / 800, 270 / 600, 500 / 800] },
      { kind: 'path', normalizedRect: [330 / 600, 350 / 800, 540 / 600, 500 / 800] }
    ]
  }
  expect(nativeCaptionedRasterFullWidth(page, caption, [caption], [])?.rect).toEqual([
    60, 80, 540, 292
  ])
  expect(associateFigures(page, [caption], [], [], [], [])[0]).toMatchObject({
    rect: [60, 80, 540, 292],
    reason: 'native-raster-full-width'
  })
})

const upperRasterPanelPage = (): ReturnType<typeof JSON.parse> => {
  const caption = {
    page: 1,
    lines: ['Figure 1. Composite response panels.'],
    rect: [50, 268, 550, 282]
  }
  const upper = {
    kind: 'image',
    imageHash: 'anonymous-upper-panel',
    normalizedRect: [60 / 600, 20 / 800, 220 / 600, 55 / 800]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 50, y: 268, width: 500, height: 10, fontSize: 10 }],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [60 / 600, 60 / 800, 540 / 600, 260 / 800] },
      upper
    ]
  }
  return { page, caption, upper }
}

it.each([
  ['full-width', nativeCaptionedRasterFullWidth],
  ['ordinary', nativeCaptionedRaster]
] as const)('preserves a connected upper panel in the %s raster matcher', (_name, match) => {
  const { page, caption } = upperRasterPanelPage()
  expect(match(page, caption, [caption], [])).toMatchObject({
    rect: [60, 20, 540, 260],
    graphicsCount: 2
  })
})

it.each([
  ['full-width', nativeCaptionedRasterFullWidth],
  ['ordinary', nativeCaptionedRaster]
] as const)('excludes independent upper images in the %s raster matcher', (_name, match) => {
  for (const barrier of [
    'detached',
    'misaligned',
    'prose',
    'table',
    'caption',
    'margin',
    'ambiguous'
  ]) {
    const { page, caption, upper } = upperRasterPanelPage()
    const tables = barrier === 'table' ? [[60, 55, 220, 60]] : []
    const captions =
      barrier === 'caption'
        ? [caption, { page: 1, lines: ['Figure 2. Independent panel.'], rect: [60, 55, 220, 60] }]
        : [caption]
    const source = {
      ...page,
      ...(barrier === 'margin' ? { marginRuleBounds: [[0.1, 0.07, 0.9, 0.071]] } : {}),
      lines:
        barrier === 'prose'
          ? [
              ...page.lines,
              {
                text: 'Independent running header',
                x: 60,
                y: 55,
                width: 160,
                height: 5,
                fontSize: 5
              }
            ]
          : page.lines,
      graphicsBounds: [
        page.graphicsBounds[0],
        {
          ...upper,
          normalizedRect:
            barrier === 'detached'
              ? [30 / 600, 8 / 800, 120 / 600, 30 / 800]
              : barrier === 'misaligned'
                ? [90 / 600, 20 / 800, 250 / 600, 55 / 800]
                : upper.normalizedRect
        },
        ...(barrier === 'ambiguous'
          ? [
              {
                ...upper,
                imageHash: 'another-upper-panel',
                normalizedRect: [380 / 600, 20 / 800, 540 / 600, 55 / 800]
              }
            ]
          : [])
      ]
    }
    expect(match(source, caption, captions, tables), barrier).toMatchObject({
      rect: [60, 60, 540, 260],
      graphicsCount: 1
    })
  }
})

it('uses painted bounds when proving an upper raster panel', () => {
  const { page, caption, upper } = upperRasterPanelPage()
  const source = {
    ...page,
    graphicsBounds: [
      page.graphicsBounds[0],
      {
        ...upper,
        normalizedRect: [0, 0, 0.9, 55 / 800],
        paintedNormalizedRect: upper.normalizedRect
      }
    ]
  }
  expect(nativeCaptionedRasterFullWidth(source, caption, [caption], [])?.rect).toEqual([
    60, 20, 540, 260
  ])
})

it.each([
  ['full-width', nativeCaptionedRasterFullWidth],
  ['ordinary', nativeCaptionedRaster]
] as const)('keeps a substantial leading inset in the %s raster matcher', (_name, match) => {
  const { page, caption, upper } = upperRasterPanelPage()
  const source = {
    ...page,
    graphicsBounds: [
      page.graphicsBounds[0],
      {
        ...upper,
        normalizedRect: [35 / 600, 5 / 800, 175 / 600, 35 / 800]
      }
    ]
  }
  expect(match(source, caption, [caption], [])).toMatchObject({
    rect: [35, 5, 540, 260],
    graphicsCount: 2
  })
  for (const barrier of ['too small', 'insufficient containment', 'large gap', 'body text']) {
    const blocked = {
      ...source,
      lines:
        barrier === 'body text'
          ? [
              ...page.lines,
              { text: 'Independent header', x: 60, y: 40, width: 115, height: 10, fontSize: 10 }
            ]
          : page.lines,
      graphicsBounds: [
        page.graphicsBounds[0],
        {
          ...upper,
          normalizedRect:
            barrier === 'too small'
              ? [35 / 600, 5 / 800, 145 / 600, 35 / 800]
              : barrier === 'insufficient containment'
                ? [30 / 600, 5 / 800, 145 / 600, 35 / 800]
                : barrier === 'large gap'
                  ? [35 / 600, 0, 175 / 600, 28 / 800]
                  : source.graphicsBounds[1].normalizedRect
        }
      ]
    }
    expect(match(blocked, caption, [caption], []), barrier).toMatchObject({
      rect: [60, 60, 540, 260],
      graphicsCount: 1
    })
  }
})

it('recovers a narrow vector bar chart with an unpunctuated figure label', () => {
  const caption = {
    page: 1,
    lines: ['Figure 3 Expert-relative performance.'],
    rect: [330, 305, 545, 320]
  }
  const bars = Array.from({ length: 10 }, (_, index) => ({
    kind: 'path',
    normalizedRect: [
      (380 + index * 14) / 600,
      (150 + (index % 4) * 15) / 800,
      (390 + index * 14) / 600,
      280 / 800
    ]
  }))
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      { text: caption.lines[0], x: 330, y: 305, width: 215, height: 10, fontSize: 10 },
      ...['0', '50', '100', '150'].map((text, index) => ({
        text,
        x: 355,
        y: 270 - index * 35,
        width: 18,
        height: 10,
        fontSize: 10
      })),
      ...['Model A', 'Model B', 'Model C'].map((text, index) => ({
        text,
        x: 390 + index * 45,
        y: 285,
        width: 35,
        height: 10,
        fontSize: 10
      }))
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [330 / 600, 100 / 800, 540 / 600, 280 / 800] },
      ...bars
    ]
  }
  expect(nativeCaptionedVectorBarChart(page, caption, [caption], [])?.rect).toEqual([
    330, 100, 540, 295
  ])
  expect(associateFigures(page, [caption], [], [], [], [])[0]).toMatchObject({
    reason: 'native-vector-bar-chart',
    graphicsCount: 11
  })
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
it('recovers a text-only figure bounded by two aligned horizontal rules', () => {
  const caption = { page: 1, lines: ['Figure 11: Prompt template.'], rect: [50, 295, 550, 325] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      ...Array.from({ length: 5 }, (_, index) => ({
        text: `Prompt instruction line ${index} contains enough monospaced text to prove the bounded figure body.`,
        x: 80,
        y: 100 + index * 30,
        width: 420,
        height: 10,
        fontSize: 10
      })),
      { text: caption.lines[0], x: 50, y: 295, width: 500, height: 10, fontSize: 10 }
    ],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [60 / 600, 80 / 800, 540 / 600, 90 / 800] },
      { kind: 'path', normalizedRect: [60 / 600, 270 / 800, 540 / 600, 280 / 800] }
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
