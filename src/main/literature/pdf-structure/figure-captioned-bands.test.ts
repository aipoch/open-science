import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const {
  nativeCaptionedRepeatedRasterRows,
  nativeCaptionedRasterAnswerPlate,
  nativeCaptionedKeyedHeatmapStack,
  nativeCaptionedRasterTaskTimeline
} = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-figure-native-captioned-illustration.mjs')
  ).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`))
const comparison = (): ReturnType<typeof JSON.parse> => fixture('repeated-raster-comparison-bands')
const answers = (): ReturnType<typeof JSON.parse> => fixture('stacked-raster-answer-plates')

it('keeps all ten raster rows and their column headings without mutating source evidence', () => {
  const input = comparison()
  const before = structuredClone(input)
  const found = nativeCaptionedRepeatedRasterRows(input.page, input.captions[0], input.captions, [])
  expect(found?.rect[1]).toBeLessThan(90)
  expect(found?.rect[3]).toBeGreaterThan(640)
  expect(found?.graphicsCount).toBe(75)
  expect(input).toEqual(before)
  expect(associateFigures(input.page, input.captions)[0].rect).toEqual(found.rect)
})

it('keeps the same complete rows under a short continued caption', () => {
  const { page, captions } = comparison()
  captions[0].rect[0] = 255
  captions[0].rect[2] = 341
  captions[0].lines = ['Figure 1: (continued)']
  expect(nativeCaptionedRepeatedRasterRows(page, captions[0], captions, [])?.graphicsCount).toBe(75)
})

it.each(['table', 'paragraph', 'misaligned-row', 'detached-row'])(
  'declines repeated raster bands with %s ownership ambiguity',
  (failure) => {
    const { page, captions } = comparison()
    const tables: number[][] = []
    if (failure === 'table') tables.push([100, 320, 500, 400])
    if (failure === 'paragraph') {
      for (let index = 0; index < 2; index++)
        page.lines.push({
          text: 'An ordinary body paragraph explains the preceding experiment and continues on the next line.',
          x: 110,
          y: 195 + index * 12,
          width: 370,
          height: 10,
          fontSize: 10
        })
    }
    if (failure === 'misaligned-row') {
      for (const graphic of page.graphicsBounds)
        if (graphic.kind === 'image' && graphic.normalizedRect[1] < 0.2)
          graphic.normalizedRect = graphic.normalizedRect.map(
            (v: number, index: number) => v + (index % 2 ? 0 : 0.06)
          )
    }
    if (failure === 'detached-row') {
      for (const graphic of page.graphicsBounds)
        if (graphic.kind === 'image' && graphic.normalizedRect[1] < 0.13)
          graphic.normalizedRect = graphic.normalizedRect.map(
            (v: number, index: number) => v - (index % 2 ? 0.075 : 0)
          )
    }
    expect(nativeCaptionedRepeatedRasterRows(page, captions[0], captions, tables)).toBeUndefined()
  }
)

it('keeps only the repeated raster rows below an intervening caption', () => {
  const { page, captions } = comparison()
  captions.push({ page: 1, rect: [100, 320, 500, 335], lines: ['Figure 2. Separate plate.'] })
  expect(
    nativeCaptionedRepeatedRasterRows(page, captions[0], captions, [])?.rect[1]
  ).toBeGreaterThan(335)
})

it('assigns each stacked caption its own complete frame strip and answer plate', () => {
  const { page, captions } = answers()
  const matches = captions.map((caption: ReturnType<typeof JSON.parse>) =>
    nativeCaptionedRasterAnswerPlate(page, caption, captions, [])
  )
  expect(matches[0]?.rect[1]).toBeLessThan(80)
  expect(matches[0]?.rect[3]).toBeLessThan(captions[0].rect[1])
  expect(matches[1]?.rect[1]).toBeGreaterThan(captions[0].rect[3])
  expect(matches[1]?.rect[3]).toBeLessThan(captions[1].rect[1])
  const associated = associateFigures(page, captions)
  expect(associated.map((figure: ReturnType<typeof JSON.parse>) => figure.rect)).toEqual(
    matches.map((figure: ReturnType<typeof JSON.parse>) => figure.rect)
  )
})

it('preserves a no-crop result when the upper plate lacks proof instead of claiming the next figure', () => {
  const { page, captions } = answers()
  page.graphicsBounds = page.graphicsBounds.filter(
    (graphic: ReturnType<typeof JSON.parse>) => graphic.kind === 'image'
  )
  const associated = associateFigures(page, captions)
  expect(associated[0].rect).toBeUndefined()
  expect(associated[1].rect[1]).toBeGreaterThan(captions[0].rect[3])
})

it.each(['table', 'prose', 'no-frames', 'competing-caption'])(
  'declines a video strip with %s instead of expanding a figure by proximity',
  (failure) => {
    const { page, captions } = answers()
    const tables = failure === 'table' ? [[130, 210, 500, 255]] : []
    if (failure === 'prose')
      page.lines.push({
        text: 'Ordinary body prose between the video and the answer cards.',
        x: 145,
        y: 126,
        width: 330,
        height: 10,
        fontSize: 10
      })
    if (failure === 'no-frames')
      page.graphicsBounds = page.graphicsBounds.filter(
        (g: ReturnType<typeof JSON.parse>) => g.kind !== 'path'
      )
    if (failure === 'competing-caption')
      captions.push({ page: 1, rect: [100, 135, 500, 145], lines: ['Figure 3. Separate plate.'] })
    expect(nativeCaptionedRasterAnswerPlate(page, captions[0], captions, tables)).toBeUndefined()
  }
)

const keyedStack = (): ReturnType<typeof JSON.parse> => {
  const caption = {
    page: 1,
    rect: [80, 380, 350, 390],
    lines: ['Figure 1. A comparison of three models.']
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [{ text: caption.lines[0], x: 80, y: 380, width: 270, height: 10, fontSize: 10 }],
    graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
  }
  const graphic = (kind: string, rect: number[]): void => {
    page.graphicsBounds.push({
      kind,
      normalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600)),
      ...(kind === 'image' ? { imageHash: 'color-key' } : {})
    })
  }
  for (let panel = 0; panel < 3; panel++) {
    const y = 100 + panel * 90
    graphic('image', [310, y, 318, y + 60])
    graphic('path', [100, y, 300, y + 60])
    for (let row = 0; row < 6; row++)
      for (let column = 0; column < 8; column++)
        graphic('path', [100 + column * 25, y + row * 10, 125 + column * 25, y + row * 10 + 10])
    page.lines.push({
      text: `(${String.fromCharCode(97 + panel)}) Anonymous model`,
      x: 110,
      y: y + 72,
      width: 170,
      height: 8,
      fontSize: 8
    })
  }
  return { page, caption }
}

it('recovers every aligned heatmap and its raster color key rather than the last panel', () => {
  const { page, caption } = keyedStack()
  const found = nativeCaptionedKeyedHeatmapStack(page, caption, [caption], [])
  expect(found?.rect).toEqual([100, 100, 318, 362.5])
  expect(found?.reason).toBe('native-keyed-heatmap-stack')
})

it.each(['no-key', 'no-cells', 'mismatched-key', 'table', 'missing-panel-label', 'paragraph'])(
  'does not infer a heatmap stack from %s',
  (failure) => {
    const { page, caption } = keyedStack()
    if (failure === 'no-key')
      page.graphicsBounds = page.graphicsBounds.filter(
        (g: ReturnType<typeof JSON.parse>) => g.kind !== 'image'
      )
    if (failure === 'no-cells')
      page.graphicsBounds = page.graphicsBounds.filter(
        (g: ReturnType<typeof JSON.parse>) =>
          g.kind !== 'path' || (g.normalizedRect[2] - g.normalizedRect[0]) * 600 > 100
      )
    if (failure === 'mismatched-key') page.graphicsBounds[0].normalizedRect[0] -= 0.04
    if (failure === 'missing-panel-label') page.lines[1].text = 'Anonymous model'
    if (failure === 'paragraph')
      page.lines.push({
        text: 'An ordinary body paragraph occupies the gap between panels. '.repeat(3),
        x: 100,
        y: 168,
        width: 220,
        height: 10,
        fontSize: 10
      })
    expect(
      nativeCaptionedKeyedHeatmapStack(
        page,
        caption,
        [caption],
        failure === 'table' ? [[90, 185, 330, 240]] : []
      )
    ).toBeUndefined()
  }
)

const taskTimeline = (): ReturnType<typeof JSON.parse> => {
  const caption = {
    page: 1,
    rect: [100, 430, 400, 440],
    lines: ['Figure 1. Six tasks in a video timeline.']
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [{ text: caption.lines[0], x: 100, y: 430, width: 300, height: 10, fontSize: 10 }],
    graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
  }
  for (let panel = 0; panel < 5; panel++)
    page.graphicsBounds.push({
      kind: 'image',
      imageHash: `frame-${panel}`,
      normalizedRect: [100 + panel * 60, 70, 160 + panel * 60, 110].map(
        (v, i) => v / (i % 2 ? 800 : 600)
      )
    })
  for (let task = 0; task < 6; task++) {
    const y = 140 + task * 28
    page.lines.push({
      text: `${task + 1}. Anonymous task`,
      x: 110,
      y,
      width: 160,
      height: 6,
      fontSize: 6
    })
    page.graphicsBounds.push({
      kind: 'image',
      imageHash: 'shared-task-icon',
      normalizedRect: [300, y, 305, y + 5].map((v, i) => v / (i % 2 ? 800 : 600))
    })
  }
  return { page, caption, figure: { caption, rect: [100, 270, 400, 410] } }
}

it('includes the upper video strip and complete ordered task list with repeated raster icons', () => {
  const { page, caption, figure } = taskTimeline()
  expect(nativeCaptionedRasterTaskTimeline(page, figure, [caption], [])?.rect).toEqual([
    100, 70, 400, 410
  ])
})

it.each(['ordinary-list', 'missing-icon', 'wrong-order', 'prose', 'table'])(
  'requires a task timeline witness beyond %s',
  (failure) => {
    const { page, caption, figure } = taskTimeline()
    if (failure === 'ordinary-list') caption.lines = ['Figure 1. An ordinary photo.']
    if (failure === 'missing-icon')
      page.graphicsBounds = page.graphicsBounds.filter(
        (g: ReturnType<typeof JSON.parse>) => g.imageHash !== 'shared-task-icon'
      )
    if (failure === 'wrong-order') page.lines[3].text = '7. Anonymous task'
    if (failure === 'prose')
      page.lines.push({
        text: 'Ordinary article prose between the photo and its numbered list.',
        x: 110,
        y: 120,
        width: 280,
        height: 10,
        fontSize: 10
      })
    expect(
      nativeCaptionedRasterTaskTimeline(
        page,
        figure,
        [caption],
        failure === 'table' ? [[100, 200, 400, 220]] : []
      )
    ).toBeUndefined()
  }
)
