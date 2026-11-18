import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'

const { associateFigures, recoverNativePeerFigureBarrier } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { nativeCaptionedRasterVectorStrip } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-captioned-illustration.mjs')).href
)

const image = (rect: number[]): { kind: string; normalizedRect: number[] } => ({
  kind: 'image',
  normalizedRect: [rect[0] / 612, rect[1] / 792, rect[2] / 612, rect[3] / 792]
})
const path = (rect: number[]): { kind: string; normalizedRect: number[] } => ({
  kind: 'path',
  normalizedRect: [rect[0] / 612, rect[1] / 792, rect[2] / 612, rect[3] / 792]
})
const makePage = (
  caption: { lines: string[]; rect: number[] },
  graphics: unknown[]
): ReturnType<typeof JSON.parse> => ({
  pageNumber: 1,
  width: 612,
  height: 792,
  invalidGraphicsBounds: 0,
  lines: [
    {
      text: caption.lines[0],
      x: caption.rect[0],
      y: caption.rect[1],
      width: 400,
      height: 10,
      fontSize: 9
    }
  ],
  graphicsBounds: graphics
})

it('recovers a three-panel raster and vector comparison strip', () => {
  const caption = {
    page: 1,
    lines: ['Figure 7: Intervention comparison.'],
    rect: [108, 196, 506, 208]
  }
  const paths = Array.from({ length: 24 }, (_, index) =>
    path([
      275 + (index % 6) * 38,
      100 + Math.floor(index / 6) * 20,
      290 + (index % 6) * 38,
      116 + Math.floor(index / 6) * 20
    ])
  )
  const page = makePage(caption, [image([108, 92, 260, 173]), ...paths])
  expect(nativeCaptionedRasterVectorStrip(page, caption, [caption], [])?.rect).toEqual([
    108, 92, 480, 176
  ])
  expect(associateFigures(page, [caption])[0]).toMatchObject({
    reason: 'native-raster-vector-strip'
  })
})

it('keeps a framed raster workflow with adjacent vector panels', () => {
  const caption = {
    page: 1,
    lines: ['Figure 17: Workflow examples.'],
    rect: [179, 226, 416, 238]
  }
  const paths = [
    path([70, 115, 525, 227]),
    ...Array.from({ length: 20 }, (_, index) =>
      path([
        160 + (index % 5) * 60,
        145 + Math.floor(index / 5) * 16,
        185 + (index % 5) * 60,
        158 + Math.floor(index / 5) * 16
      ])
    )
  ]
  const page = makePage(caption, [image([77, 138, 151, 217]), ...paths])
  expect(nativeCaptionedRasterVectorStrip(page, caption, [caption], [])?.rect).toEqual([
    70, 115, 525, 227
  ])
})

it('keeps small raster panels inside a proved enclosing frame', () => {
  const caption = {
    page: 1,
    lines: ['Figure 18: Full workflow plate.'],
    rect: [179, 226, 416, 238]
  }
  const frame = path([70, 90, 525, 227])
  const paths = [
    frame,
    ...Array.from({ length: 20 }, (_, index) =>
      path([
        160 + (index % 5) * 60,
        145 + Math.floor(index / 5) * 16,
        185 + (index % 5) * 60,
        158 + Math.floor(index / 5) * 16
      ])
    )
  ]
  const page = makePage(caption, [
    image([77, 138, 151, 217]),
    image([90, 100, 100, 110]),
    image([105, 100, 115, 110]),
    ...paths
  ])
  expect(nativeCaptionedRasterVectorStrip(page, caption, [caption], [])?.rect).toEqual([
    70, 90, 525, 227
  ])
})

it('keeps both raster rows in a repeated workflow panel', () => {
  const caption = {
    page: 1,
    lines: ['Figure 11: Qualitative workflow results.'],
    rect: [186, 518, 409, 530]
  }
  const paths = [
    ...Array.from({ length: 8 }, (_, index) => {
      const row = Math.floor(index / 4)
      const column = index % 4
      return path([123 + column * 100, 319 + row * 100, 210 + column * 100, 410 + row * 100])
    }),
    ...Array.from({ length: 20 }, (_, index) =>
      path([
        140 + (index % 5) * 75,
        330 + Math.floor(index / 5) * 30,
        170 + (index % 5) * 75,
        350 + Math.floor(index / 5) * 30
      ])
    )
  ]
  const page = makePage(caption, [image([70, 339, 126, 398]), image([70, 431, 126, 490]), ...paths])
  expect(nativeCaptionedRasterVectorStrip(page, caption, [caption], [])?.rect).toEqual([
    70, 319, 510, 510
  ])
})

it.each([
  { tableOwnsRaster: false, captionOverlap: false },
  { tableOwnsRaster: true, captionOverlap: false },
  { tableOwnsRaster: false, captionOverlap: true }
])(
  'preserves only an independently owned mixed plate clear of the caption (%j)',
  ({ tableOwnsRaster, captionOverlap }) => {
    const caption = {
      page: 1,
      lines: ['Figure 1: Mixed panel comparison.'],
      rect: [70, 350, 530, 360]
    }
    const page = makePage(caption, [image([80, 80, 220, 190])])
    page.lines[0] = { ...page.lines[0], width: 460, fontSize: 10 }
    const rules: number[][] = []
    for (const left of [80, 330]) {
      rules.push(
        [left, 220, left + 170, 220],
        [left, 320, left + 170, 320],
        [left, 220, left, 320],
        [left + 170, 220, left + 170, 320]
      )
      page.graphicsBounds.push(path([left, 220, left + 170, 320]))
      for (let i = 0; i < 6; i++)
        page.graphicsBounds.push(
          path([left + 10 + i * 2, 230 + i * 3, left + 150 - i * 2, 310 - i * 2])
        )
      for (let i = 0; i < 5; i++)
        page.lines.push({
          text: String(i),
          x: left - 15,
          y: 230 + i * 16,
          width: 8,
          height: 8,
          fontSize: 8
        })
    }
    const tables = tableOwnsRaster ? [[80, 80, 220, 190]] : []
    if (captionOverlap) page.graphicsBounds.push(path([80, 220, 500, 355]))
    const before = structuredClone(page)
    // The closed lower axes remain useful for label completion, but cannot
    // erase the separately proved upper plate or claim an independently owned table.
    expect(associateFigures(page, [caption], tables, rules)[0].rect).toEqual([
      65,
      tableOwnsRaster || captionOverlap ? 220 : 80,
      500,
      320
    ])
    expect(page).toEqual(before)
  }
)

it.each([
  { proof: 'independent frames', keepStrip: false },
  { proof: 'unproved peer caption', keepStrip: true },
  { proof: 'drawing across the gutter', keepStrip: true }
])('keeps frame ownership in a staggered two-column layout ($proof)', ({ proof, keepStrip }) => {
  const caption = {
    page: 1,
    lines: ['Figure 1: Thermal profile.'],
    rect: [60, 260, 295, 325]
  }
  const peer = {
    page: 1,
    lines: ['Figure 2: Response curves.'],
    rect: [325, 420, 560, 440]
  }
  const leftPaths = Array.from({ length: 12 }, (_, i) =>
    path([80 + i * 4, 90 + i * 5, 220, 110 + i * 5])
  )
  const graphics = [
    path([60, 50, 295, 250]),
    image([250, 80, 275, 220]),
    ...leftPaths,
    path([325, 245, 560, 410]),
    path([370, 250, 450, 256])
  ]
  if (proof === 'drawing across the gutter') graphics.push(path([260, 248, 355, 258]))
  const page = makePage(
    caption,
    graphics.map((g, operationIndex) => ({ ...g, operationIndex }))
  )
  const tokens = [caption, peer]
    .filter((c) => proof !== 'unproved peer caption' || c !== peer)
    .map((c, index) => ({
      text: c.lines[0],
      sourceItem: { pageNumber: 1, index, text: c.lines[0] },
      horizontal: true,
      height: 9,
      rect: [c.rect[0], c.rect[1], c.rect[2], c.rect[1] + 9]
    }))
  const strip = nativeCaptionedRasterVectorStrip(page, caption, [caption, peer], [], [], tokens)
  expect(strip?.reason).toEqual(keepStrip ? 'native-raster-vector-strip' : undefined)
})

it.each([
  { numberedDisplay: true, crossGutter: false, keepStrip: false },
  { numberedDisplay: false, crossGutter: false, keepStrip: true },
  { numberedDisplay: true, crossGutter: true, keepStrip: true }
])('excludes the opposite numbered equation from a raster figure (%j)', (test) => {
  const caption = { page: 1, lines: ['Figure 2. Optical apparatus.'], rect: [318, 435, 565, 447] }
  const opposite = [path([95, 303, 145, 310]), path([130, 350, 170, 357])]
  const own = Array.from({ length: 12 }, (_, i) => path([354 + i * 12, 302, 360 + i * 12, 414]))
  const bridge = test.crossGutter ? [path([285, 330, 359, 340])] : []
  const page = makePage(caption, [image([352, 297, 526, 429]), ...own, ...opposite, ...bridge])
  page.lines.push(
    {
      text: 'The wave equation can be written as follows',
      x: 45,
      y: 280,
      width: 245,
      height: 9,
      fontSize: 9
    },
    {
      text: test.numberedDisplay ? '(1)' : 'Chamber',
      x: 280,
      y: 319,
      width: 10,
      height: 9,
      fontSize: 9
    },
    {
      text: 'The terms denote the parameters of the model',
      x: 45,
      y: 365,
      width: 239,
      height: 9,
      fontSize: 9
    }
  )
  expect(Boolean(nativeCaptionedRasterVectorStrip(page, caption, [caption], []))).toBe(
    test.keepStrip
  )
})

it.each([false, true])(
  'keeps opposite captioned figures separate only across an empty gutter (%s)',
  (crosses) => {
    const left = { page: 1, lines: ['Figure 1. Phase data.'], rect: [50, 385, 287, 430] }
    const right = { page: 1, lines: ['Figure 2. Response data.'], rect: [318, 369, 573, 408] }
    const plots = Array.from({ length: 30 }, (_, i) => {
      const x = 325 + (i % 6) * 28,
        y = 68 + Math.floor(i / 6) * 55
      return path([x, y, x + 20, y + 25])
    })
    const page = makePage(left, [
      image([60, 60, 280, 260]),
      path([45, 285, 292, 380]),
      path([318, 60, 575, 365]),
      ...plots,
      ...(crosses ? [path([275, 120, 335, 148])] : [])
    ])
    page.lines = [left, right].map(({ rect, lines }) => ({
      text: lines[0],
      x: rect[0],
      y: rect[1],
      width: rect[2] - rect[0],
      height: 10,
      fontSize: 10
    }))
    const wide = [45, 35, 575, 365]
    const peer = [45, 60, 292, 380]
    const [a, b] = recoverNativePeerFigureBarrier(
      page,
      [left, right],
      [
        { caption: right, rect: wide, graphicsCount: 30 },
        { caption: left, rect: peer, graphicsCount: 2 }
      ]
    )
    expect(a.rect.map((v: number) => Math.round(v))).toEqual(crosses ? wide : [318, 60, 575, 365])
    expect(b.rect).toEqual(peer)
  }
)

it.each(['stack', 'frame gap', 'intervening prose'] as const)(
  'keeps all three proved panels next to a side caption (%s)',
  (variant) => {
    const caption = {
      page: 1,
      lines: ['Figure 3. a: Signal. b: Contrast. c: Residual.'],
      rect: [394, 329, 572, 382]
    }
    const frames = [
      [64, 130, 376, variant === 'frame gap' ? 207 : 210],
      [64, 210, 376, 290],
      [64, 290, 376, 370]
    ]
    const paint = frames.flatMap(([left, top, right, bottom]) => [
      path([left, top, right, top + 3]),
      path([left, bottom - 3, right, bottom]),
      path([left, top, left + 3, bottom]),
      path([right - 3, top, right, bottom]),
      ...Array.from({ length: 24 }, (_, index) => {
        const x = left + 25 + index * 11
        const y = top + 33 + (index % 4) * 6
        return path([x, y, x + 8, y + 12])
      })
    ])
    const page = makePage(caption, paint)
    page.lines[0].width = 178
    if (variant === 'intervening prose') {
      page.lines.push({
        text: 'A full paragraph must stay separate from the neighboring figure in every reading mode.',
        x: 76,
        y: 156,
        width: 272,
        height: 10,
        fontSize: 9
      })
    }
    const [figure] = associateFigures(page, [caption], [], [], frames)
    expect(figure.rect).toEqual(variant === 'stack' ? [64, 130, 376, 370] : [64, 130, 376, 293])
  }
)
