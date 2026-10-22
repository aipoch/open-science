import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'

const { associateFigures } = await import(
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
