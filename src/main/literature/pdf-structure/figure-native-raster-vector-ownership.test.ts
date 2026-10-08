import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)

const image = (rect: number[]): { kind: string; normalizedRect: number[] } => ({
  kind: 'image',
  normalizedRect: [rect[0] / 612, rect[1] / 792, rect[2] / 612, rect[3] / 792]
})
const path = (rect: number[]): { kind: string; normalizedRect: number[] } => ({
  kind: 'path',
  normalizedRect: [rect[0] / 612, rect[1] / 792, rect[2] / 612, rect[3] / 792]
})

it('unites a raster panel grid with the adjacent vector plots', () => {
  const caption = {
    page: 1,
    lines: ['FIG. 2. Noise robustness achieved by optical signal processing.'],
    rect: [54, 328, 562, 427]
  }
  const graphics = []
  for (const y of [72, 133, 198, 263]) {
    for (const x of [86, 158, 227, 296]) graphics.push(image([x, y, x + 48, y + 50]))
  }
  for (let i = 0; i < 24; i++) {
    const x = 357 + (i % 6) * 30
    const y = 60 + Math.floor(i / 6) * 50
    graphics.push(path([x, y, x + 18, y + 20]))
  }
  const page = {
    pageNumber: 1,
    width: 612,
    height: 792,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 54, y: 328, width: 508, height: 9, fontSize: 9 }],
    graphicsBounds: graphics
  }
  expect(associateFigures(page, [caption])[0]).toMatchObject({
    rect: [86, 60, 525, 313],
    reason: 'native-raster-vector-composite-grid'
  })
})

it.each([false, true])(
  'merges explicitly labelled horizontal panels using painted bounds: %s',
  (clipped) => {
    const caption = {
      page: 1,
      lines: ['Figure 3: (a) Original (b) Without critic (c) With critic.'],
      rect: [54, 300, 558, 340]
    }
    const graphics = [
      image([72, 100, 220, 180]),
      image([230, 100, 378, 180]),
      image([388, 100, 536, 180])
    ]
    const page = {
      pageNumber: 1,
      width: 612,
      height: 792,
      invalidGraphicsBounds: 0,
      lines: [{ text: caption.lines[0], x: 54, y: 300, width: 504, height: 9, fontSize: 9 }],
      graphicsBounds: clipped
        ? graphics.map((graphic) => ({
            ...graphic,
            normalizedRect: [0.05, 0.08, 0.95, 0.25],
            paintedNormalizedRect: graphic.normalizedRect
          }))
        : graphics
    }
    expect(associateFigures(page, [caption])[0]).toMatchObject({
      rect: [72, 100, 536, 180],
      graphicsCount: 3
    })
  }
)

it('does not merge an unrelated row across a stacked caption', () => {
  const first = {
    page: 1,
    lines: ['Figure 1: (a) Input (b) Result (c) Reference.'],
    rect: [54, 200, 558, 220]
  }
  const second = { page: 1, lines: ['Figure 2: A single panel.'], rect: [54, 400, 558, 420] }
  const page = {
    pageNumber: 1,
    width: 612,
    height: 792,
    invalidGraphicsBounds: 0,
    lines: [
      {
        text: 'original without filter with filter',
        x: 72,
        y: 72,
        width: 464,
        height: 10,
        fontSize: 10
      },
      { text: first.lines[0], x: 54, y: 200, width: 504, height: 10, fontSize: 10 },
      { text: second.lines[0], x: 54, y: 400, width: 504, height: 10, fontSize: 10 }
    ],
    graphicsBounds: [
      image([72, 100, 220, 180]),
      image([230, 100, 378, 180]),
      image([388, 100, 536, 180]),
      image([72, 300, 220, 380])
    ]
  }
  const matches = associateFigures(page, [first, second])
  expect(matches.find((match: { caption: unknown }) => match.caption === second)).toMatchObject({
    rect: [72, 300, 220, 380],
    graphicsCount: 1
  })
})

it('does not reuse an earlier vector bar panel for a later workflow caption', () => {
  const first = { page: 1, lines: ['Figure 9. Summary bars.'], rect: [50, 145, 545, 176] }
  const second = { page: 1, lines: ['Figure 10. Workflow pipeline.'], rect: [196, 333, 398, 342] }
  const graphics = [
    path([50, 72, 120, 124]),
    path([130, 72, 200, 124]),
    path([210, 72, 280, 124]),
    path([290, 72, 360, 124]),
    path([370, 72, 440, 124]),
    path([450, 72, 540, 124]),
    image([48, 223, 112, 288]),
    image([483, 223, 547, 288]),
    ...Array.from({ length: 24 }, (_, index) => {
      const x = 80 + (index % 8) * 55
      const y = 186 + Math.floor(index / 8) * 47
      return path([x, y, x + 20, y + 45])
    })
  ]
  const page = {
    pageNumber: 1,
    width: 612,
    height: 792,
    invalidGraphicsBounds: 0,
    lines: [
      { text: first.lines[0], x: 50, y: 145, width: 495, height: 9, fontSize: 9 },
      { text: second.lines[0], x: 196, y: 333, width: 202, height: 9, fontSize: 9 }
    ],
    graphicsBounds: graphics
  }
  const matches = associateFigures(page, [first, second])
  expect(matches.find((match: { caption: unknown }) => match.caption === second)).toMatchObject({
    rect: [48, 186, 547, 325],
    reason: 'native-mixed-workflow-panel'
  })
})

it('keeps a pipe-delimited narrow-column chart with its own frame', () => {
  const caption = {
    page: 1,
    lines: ['Figure 4 | Column comparison.'],
    rect: [62, 239, 250, 251]
  }
  const bars = Array.from({ length: 8 }, (_, index) =>
    path([90 + index * 16, 130 + (index % 3) * 12, 100 + index * 16, 232])
  )
  const page = {
    pageNumber: 1,
    width: 612,
    height: 792,
    invalidGraphicsBounds: 0,
    lines: [
      { text: caption.lines[0], x: 62, y: 239, width: 188, height: 10, fontSize: 9 },
      ...['0', '25', '50', '75'].map((text, index) => ({
        text,
        x: 68,
        y: 220 - index * 35,
        width: 12,
        height: 9,
        fontSize: 9
      })),
      ...['A', 'B', 'C'].map((text, index) => ({
        text,
        x: 100 + index * 36,
        y: 235,
        width: 12,
        height: 9,
        fontSize: 9
      }))
    ],
    graphicsBounds: [
      path([60, 82, 253, 237]),
      ...bars,
      path([360, 82, 540, 237]),
      ...Array.from({ length: 8 }, (_, index) =>
        path([390 + index * 14, 130 + (index % 2) * 14, 400 + index * 14, 232])
      )
    ]
  }
  const match = associateFigures(page, [caption])[0]
  expect(match).toMatchObject({ reason: 'native-vector-bar-chart' })
  expect(match.rect[0]).toBe(60)
  expect(match.rect[1]).toBe(82)
  expect(match.rect[2]).toBeCloseTo(253)
  expect(match.rect[3]).toBeGreaterThanOrEqual(237)
})
