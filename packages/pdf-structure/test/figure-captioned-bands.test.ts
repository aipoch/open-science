import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const {
  nativeCaptionedRepeatedRasterRows,
  nativeCaptionedRasterAnswerPlate,
  nativeCaptionedKeyedHeatmapStack,
  nativeCaptionedRasterTaskTimeline
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-captioned-illustration.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`test/fixtures/source-grids/${name}.jsonl`))
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
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const { collectClosedFigureFrames } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const { nativeCaptionedPlotBand } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-bands.mjs')).href
)
const closedSixFaces = (): ReturnType<typeof JSON.parse> => {
  const page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: [] as ReturnType<typeof JSON.parse>[],
      graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
    },
    operators: ReturnType<typeof JSON.parse> = { fnArray: [], argsArray: [] },
    viewport = { width: 600, height: 800, rotation: 0, transform: [1, 0, 0, -1, 0, 800] },
    tokens: ReturnType<typeof JSON.parse>[] = [],
    add = (op: number, args: ReturnType<typeof JSON.parse>): void => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    },
    paint = (points: number[], op = OPS.stroke): void => {
      const xs: number[] = [],
        ys: number[] = []
      for (let n = 0; n < points.length;) {
        const command = points[n++],
          count = command === 4 ? 0 : 2
        for (let i = 0; i < count; i += 2) {
          xs.push(points[n + i])
          ys.push(points[n + i + 1])
        }
        n += count
      }
      const extra = op === OPS.stroke ? 0.5 : 0,
        rect = [
          Math.min(...xs) - extra,
          800 - Math.max(...ys) - extra,
          Math.max(...xs) + extra,
          800 - Math.min(...ys) + extra
        ]
      page.graphicsBounds.push({
        kind: 'path',
        operationIndex: operators.fnArray.length,
        normalizedRect: rect.map(
          (v, n) =>
            ((n < 2 ? Math.floor : Math.ceil)((v * 256) / (n % 2 ? 800 : 600)) + (n < 2 ? 0 : 1)) /
            256
        )
      })
      add(OPS.constructPath, [
        op,
        [new Float32Array(points)],
        new Float32Array([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])
      ])
    },
    frame = (r: number[]): void => {
      const [l, t, x, b] = r
      paint([0, l, 800 - b, 1, x, 800 - b, 1, x, 800 - t, 1, l, 800 - t, 4], OPS.fillStroke)
    },
    text = (str: string, left: number, top: number, font: number, rotated = false): void => {
      const width = str.length * font * 0.5,
        rect = rotated
          ? [left, top, left + font, top + width]
          : [left, top, left + width, top + font],
        baseline = rect[3],
        token = {
          text: str,
          rect,
          baseline,
          height: font,
          horizontal: !rotated,
          sourceItem: { pageNumber: 1, index: tokens.length, text: str }
        }
      tokens.push(token)
      if (!rotated)
        page.lines.push({ text: str, x: left, y: top, width, height: font, fontSize: font })
      add(OPS.beginText, null)
      add(OPS.setFont, ['anonymous-font', font])
      add(OPS.setTextMatrix, [
        new Float32Array(
          rotated ? [0, 1, -1, 0, left + font, 800 - baseline] : [1, 0, 0, 1, left, 800 - baseline]
        )
      ])
      add(OPS.showText, [
        [...str].map((c) => ({
          originalCharCode: c.charCodeAt(0),
          fontChar: c,
          unicode: c,
          width: 500,
          isSpace: c === ' ',
          isInFont: true
        }))
      ])
      add(OPS.endText, null)
    }
  add(OPS.setLineWidth, [1])
  for (let row = 0; row < 2; row++)
    for (let column = 0; column < 3; column++) {
      const left = 90 + column * 160,
        top = 80 + row * 155,
        right = left + 100,
        bottom = top + 100
      frame([left, top, right, bottom])
      text(`Panel ${row * 3 + column + 1}`, left + 32.5, top - 20, 10)
      for (let n = 0; n < 3; n++) {
        text(String(n), left + 15 + n * 30, bottom + 5, 6)
        text(String(n), left - 12, top + 10 + n * 30, 6)
        paint([0, left + 10, 800 - top - 20 - n * 15, 1, right - 10, 800 - top - 35 - n * 15])
      }
      text('rate', left - 25, top + 25, 6, true)
    }
  const caption = {
    page: 1,
    lines: ['Figure 1: Complete native plate.'],
    rect: [60, 355, 220, 365]
  }
  text(caption.lines[0], 60, 355, 10)
  const frames = collectClosedFigureFrames(operators, viewport)
  return {
    page,
    caption,
    captions: [caption],
    frames,
    tokens,
    rules: [],
    context: { operators, viewport }
  }
}
const sixFaceProof = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  nativeCaptionedPlotBand(
    f.page,
    f.caption,
    f.captions,
    [],
    f.rules,
    f.frames,
    f.tokens,
    undefined,
    f.context
  )

it('recovers all six independently closed faces with whole-font matrices and complete paint indices', () => {
  const f = closedSixFaces(),
    before = structuredClone(f),
    proof = sixFaceProof(f)
  expect(proof?.graphicsCount).toBe(6)
  expect(proof?.rect[1]).toBe(60)
  expect(proof?.rect[3]).toBeGreaterThan(340)
  expect(f).toEqual(before)
})
it('preserves an already complete owner of the six-face source', () => {
  const f = closedSixFaces()
  expect(
    nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      [],
      f.rules,
      f.frames,
      f.tokens,
      [50, 50, 550, 350],
      f.context
    )
  ).toBeUndefined()
})
it('accounts for every independently clipped empty paint without a page-count exemption', () => {
  const f = closedSixFaces(),
    o = f.context.operators
  o.fnArray.push(OPS.save, OPS.clip, OPS.constructPath, OPS.constructPath, OPS.restore)
  o.argsArray.push(
    null,
    null,
    [
      OPS.endPath,
      [new Float32Array([0, 90, 620, 1, 190, 620, 1, 190, 720, 1, 90, 720, 4])],
      new Float32Array([90, 620, 190, 720])
    ],
    [
      OPS.stroke,
      [new Float32Array([0, 100, 570, 1, 180, 590])],
      new Float32Array([100, 570, 180, 590])
    ],
    null
  )
  f.page.invalidGraphicsBounds = 1
  expect(sixFaceProof(f)?.graphicsCount).toBe(6)
  f.page.invalidGraphicsBounds = 0
  expect(sixFaceProof(f)?.graphicsCount).not.toBe(6)
})
it.each([
  'missing-font',
  'wrong-origin',
  'wrong-height',
  'wrong-baseline',
  'moved-matrix',
  'nested-text-state',
  'missing-glyph',
  'shifted-paint-index',
  'missing-paint',
  'changed-paint-box',
  'changed-source-paint-box',
  'open-face',
  'duplicate-caption',
  'foreign-prose',
  'alpha',
  'curved-clip'
])('refuses incomplete six-face source proof: %s', (reason) => {
  const f = closedSixFaces(),
    o = f.context.operators,
    at = o.fnArray.indexOf(OPS.setTextMatrix)
  if (reason === 'missing-font') f.tokens.splice(1, 1)
  if (reason === 'wrong-origin') f.tokens[1].sourceItem.text = 'Different'
  if (reason === 'wrong-height') f.tokens[1].height -= 1
  if (reason === 'wrong-baseline') f.tokens[1].baseline -= 1
  if (reason === 'moved-matrix') o.argsArray[at][0][4] += 1
  if (reason === 'nested-text-state') {
    o.fnArray.splice(at, 0, OPS.save, OPS.restore)
    o.argsArray.splice(at, 0, null, null)
    f.page.graphicsBounds = f.page.graphicsBounds.map((g) => ({
      ...g,
      operationIndex: g.operationIndex >= at ? g.operationIndex + 2 : g.operationIndex
    }))
  }
  if (reason === 'missing-glyph') o.argsArray[o.fnArray.indexOf(OPS.showText)][0].pop()
  if (reason === 'shifted-paint-index') f.page.graphicsBounds[0].operationIndex++
  if (reason === 'missing-paint') f.page.graphicsBounds.pop()
  if (reason === 'changed-paint-box') f.page.graphicsBounds[0].normalizedRect[0] += 0.01
  if (reason === 'changed-source-paint-box')
    o.argsArray[o.fnArray.indexOf(OPS.constructPath)][2][0] += 1
  if (reason === 'open-face') f.frames.pop()
  if (reason === 'duplicate-caption') f.page.lines.push({ ...f.page.lines.at(-1) })
  if (reason === 'foreign-prose') {
    const t = f.tokens[1]
    t.text = 'A foreign paragraph.'
    t.sourceItem.text = t.text
  }
  if (reason === 'alpha') {
    o.fnArray.push(OPS.setGState)
    o.argsArray.push([[['ca', 0.5]]])
  }
  if (reason === 'curved-clip') {
    o.fnArray.push(OPS.clip, OPS.constructPath)
    o.argsArray.push(null, [
      OPS.endPath,
      [new Float32Array([0, 90, 700, 2, 100, 700, 190, 700, 190, 720, 4])],
      new Float32Array([90, 700, 190, 720])
    ])
  }
  expect(sixFaceProof(f)?.graphicsCount).not.toBe(6)
})
