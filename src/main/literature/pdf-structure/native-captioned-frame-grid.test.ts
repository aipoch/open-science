import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { nativeCaptionedFramedVectorQuad } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-figure-native-captioned-illustration.mjs')
  ).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)

const page = (): ReturnType<typeof JSON.parse> => {
  const width = 600,
    height = 800
  const rects = [
    [50, 80, 280, 85],
    [50, 295, 280, 300],
    [50, 80, 55, 300],
    [275, 80, 280, 300],
    [320, 80, 550, 85],
    [320, 295, 550, 300],
    [320, 80, 325, 300],
    [545, 80, 550, 300],
    [50, 315, 280, 320],
    [50, 530, 280, 535],
    [50, 315, 55, 535],
    [275, 315, 280, 535],
    [320, 315, 550, 320],
    [320, 530, 550, 535],
    [320, 315, 325, 535],
    [545, 315, 550, 535]
  ]
  const caption = {
    page: 1,
    lines: ['Figure A.2: Four example pages. Upper pair and lower pair.'],
    rect: [100, 540, 500, 550]
  }
  return {
    pageNumber: 1,
    invalidGraphicsBounds: 0,
    width,
    height,
    lines: [
      {
        text: caption.lines[0],
        x: caption.rect[0],
        y: caption.rect[1],
        width: caption.rect[2] - caption.rect[0],
        height: 10,
        fontSize: 10
      }
    ],
    graphicsBounds: [
      ...rects.map((rect) => ({
        kind: 'path',
        normalizedRect: [rect[0] / width, rect[1] / height, rect[2] / width, rect[3] / height]
      })),
      { kind: 'image', normalizedRect: [60 / width, 90 / height, 270 / width, 290 / height] }
    ],
    caption
  }
}

it('unites four framed panels when only one panel has raster content', () => {
  const fixture = page()
  const result = nativeCaptionedFramedVectorQuad(fixture, fixture.caption, [fixture.caption], [])
  expect(result?.rect).toEqual([50, 80, 550, 535])
  expect(result?.graphicsCount).toBe(4)
  expect(associateFigures(fixture, [fixture.caption])[0].rect).toEqual([50, 80, 550, 535])
})

it('rejects a framed quad claimed by a table', () => {
  const fixture = page()
  expect(
    nativeCaptionedFramedVectorQuad(
      fixture,
      fixture.caption,
      [fixture.caption],
      [[50, 80, 550, 535]]
    )
  ).toBeUndefined()
})

it('rejects a competing caption between the framed panels', () => {
  const fixture = page()
  const other = { page: 1, lines: ['Figure 2. Separate panel.'], rect: [40, 200, 340, 210] }
  expect(
    nativeCaptionedFramedVectorQuad(fixture, fixture.caption, [fixture.caption, other], [])
  ).toBeUndefined()
})

it('ignores captions and tables embedded inside a framed panel', () => {
  const fixture = page()
  const embeddedCaption = {
    page: 1,
    lines: ['Figure 7. Embedded screenshot label.'],
    rect: [330, 480, 520, 490]
  }
  const embeddedTable = [340, 470, 520, 500]
  const result = nativeCaptionedFramedVectorQuad(
    fixture,
    fixture.caption,
    [fixture.caption, embeddedCaption],
    [embeddedTable]
  )
  expect(result?.rect).toEqual([50, 80, 550, 535])
})

it('allows captions and table regions fully contained inside a panel frame', () => {
  const fixture = page()
  const nestedCaption = {
    page: 1,
    lines: ['Figure 5: Screenshot detail.'],
    rect: [350, 350, 470, 360]
  }
  const nestedTable = [335, 365, 535, 470]
  const result = nativeCaptionedFramedVectorQuad(
    fixture,
    fixture.caption,
    [fixture.caption, nestedCaption],
    [nestedTable]
  )
  expect(result?.rect).toEqual([50, 80, 550, 535])
})

it('rejects a panel whose frame is missing one edge', () => {
  const fixture = page()
  fixture.graphicsBounds.splice(15, 1)
  expect(
    nativeCaptionedFramedVectorQuad(fixture, fixture.caption, [fixture.caption], [])
  ).toBeUndefined()
})

it('rejects unequal panel sizes instead of joining unrelated frames', () => {
  const fixture = page()
  for (const graphic of fixture.graphicsBounds.slice(12, 16)) {
    graphic.normalizedRect[0] = 490 / fixture.width
    graphic.normalizedRect[2] = Math.max(495 / fixture.width, graphic.normalizedRect[2])
  }
  expect(
    nativeCaptionedFramedVectorQuad(fixture, fixture.caption, [fixture.caption], [])
  ).toBeUndefined()
})

it('keeps a purely vector grid on the existing no-crop path', () => {
  const fixture = page()
  fixture.graphicsBounds.pop()
  expect(
    nativeCaptionedFramedVectorQuad(fixture, fixture.caption, [fixture.caption], [])
  ).toBeUndefined()
})
