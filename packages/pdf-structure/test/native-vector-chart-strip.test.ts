import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'

const {
  nativeCaptionedVectorChartStrip,
  nativeCaptionedVectorBarChart,
  nativeCaptionedVectorBarPanels
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-captioned-illustration.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)

const chartPage = (): ReturnType<typeof JSON.parse> => {
  const width = 612,
    height = 792,
    caption = {
      page: 1,
      lines: ['Figure 9: Query loss across similarity bins.'],
      rect: [108, 194, 504, 204]
    }
  const panelLefts = [141, 215, 292, 366, 442]
  const graphicsBounds = panelLefts.flatMap((left) => [
    [left, 112, left + 62, 118],
    [left, 130, left + 62, 136],
    [left, 148, left + 62, 154],
    [left, 112, left + 5, 161],
    [left, 155, left + 62, 161],
    [left + 10, 120, left + 50, 160],
    [left + 12, 126, left + 48, 160]
  ])
  graphicsBounds.push([230, 90, 240, 96], [300, 90, 310, 96], [350, 90, 360, 96])
  const numeric = panelLefts.flatMap((left, index) =>
    [0, 1, 2].map((offset) => ({
      text: `${index + offset / 10}`,
      x: left + 8,
      y: 118 + offset * 12,
      width: 16,
      height: 7,
      fontSize: 7
    }))
  )
  const titles = panelLefts.map((left, index) => ({
    text: `Task ${index + 1}`,
    x: left + 14,
    y: 98,
    width: 32,
    height: 9,
    fontSize: 9
  }))
  return {
    pageNumber: 1,
    width,
    height,
    invalidGraphicsBounds: 0,
    graphicsBounds: graphicsBounds.map((rect) => ({
      kind: 'path',
      normalizedRect: rect.map((value, index) => value / (index % 2 ? height : width))
    })),
    lines: [
      { ...caption, text: caption.lines[0], x: 108, y: 194, width: 396, height: 10, fontSize: 10 },
      ...numeric,
      ...titles,
      { text: 'LESSER LESS RDS+', x: 244, y: 86, width: 140, height: 9, fontSize: 8.5 },
      { text: 'Query similarity', x: 290, y: 169, width: 58, height: 8, fontSize: 8 }
    ],
    caption
  }
}

it('claims a complete native multi-panel chart strip', () => {
  const page = chartPage()
  const result = nativeCaptionedVectorChartStrip(page, page.caption, [page.caption], [])
  expect(result?.rect).toEqual([141, 86, 504, 177])
  expect(result?.graphicsCount).toBe(33)
  expect(associateFigures(page, [page.caption])[0].rect).toEqual([141, 86, 504, 177])
})

it('leaves a single native plot unresolved without repeated panel evidence', () => {
  const page = chartPage()
  page.graphicsBounds = page.graphicsBounds.slice(0, 5)
  expect(nativeCaptionedVectorChartStrip(page, page.caption, [page.caption], [])).toBeUndefined()
})

it('rejects a chart strip crossing a table region', () => {
  const page = chartPage()
  expect(
    nativeCaptionedVectorChartStrip(page, page.caption, [page.caption], [[136, 98, 509, 177]])
  ).toBeUndefined()
})

it('keeps a chart strip when a short caption gap contains body prose', () => {
  const page = chartPage()
  page.caption.rect = [108, 232, 504, 242]
  page.lines[0] = { ...page.lines[0], y: 232 }
  page.lines.push({
    text: 'The plotted values are discussed in the following paragraph before the caption.',
    x: 74,
    y: 190,
    width: 448,
    height: 10,
    fontSize: 10
  })
  const result = nativeCaptionedVectorChartStrip(page, page.caption, [page.caption], [])
  expect(result?.rect).toEqual([141, 86, 504, 177])
})

const closedRowBelowParagraph = (): ReturnType<typeof JSON.parse> => {
  const page = chartPage()
  page.graphicsBounds = page.graphicsBounds.slice(0, 28)
  page.lines = page.lines.filter((line: { text: string }) => !/^Task |^LESSER/u.test(line.text))
  const fontLines = [
    {
      text: 'An independently aligned body paragraph has a complete preceding source line.',
      x: 141,
      y: 64,
      width: 360,
      height: 12,
      fontSize: 12
    },
    {
      text: 'Its next complete source line remains prose above the independently closed plots.',
      x: 141,
      y: 78,
      width: 360,
      height: 12,
      fontSize: 12
    },
    { text: 'The final term (10', x: 141, y: 92, width: 62, height: 12, fontSize: 12 },
    { text: '-2', x: 203.1, y: 91, width: 9, height: 8, fontSize: 8 },
    { text: ').', x: 212.3, y: 92, width: 8, height: 12, fontSize: 12 }
  ]
  page.lines.push(...fontLines)
  const tokens = page.lines.map(
    (
      line: { text: string; x: number; y: number; width: number; height: number; fontSize: number },
      index: number
    ) => ({
      text: line.text,
      rect: [line.x, line.y, line.x + line.width, line.y + line.height],
      height: line.fontSize,
      baseline: line.y + line.height,
      horizontal: true,
      sourceItem: { pageNumber: 1, index, text: line.text }
    })
  )
  return { page, tokens, frames: [141, 215, 292, 366].map((left) => [left, 112, left + 62, 161]) }
}

it('excludes complete body tails and their original raised fragments above a closed four-face row', () => {
  const { page, tokens, frames } = closedRowBelowParagraph()
  const legacy = nativeCaptionedVectorChartStrip(page, page.caption, [page.caption], [])
  const result = nativeCaptionedVectorChartStrip(
    page,
    page.caption,
    [page.caption],
    [],
    tokens,
    frames
  )
  expect(legacy?.rect[1]).toBe(92)
  expect(result?.rect[1]).toBe(112)
  expect(result?.excludedProseLines.map((line: { text: string }) => line.text)).toContain('-2')
  expect(result?.excludedProseLines.map((line: { text: string }) => line.text)).toContain(').')
  expect(result?.rect.slice(2)).toEqual(legacy?.rect.slice(2))
})

it.each(['missing original font', 'wrong source origin', 'open face', 'unaligned predecessor'])(
  'retains the legacy crop when paragraph exclusion lacks %s',
  (fault) => {
    const { page, tokens, frames } = closedRowBelowParagraph()
    if (fault === 'missing original font')
      tokens.splice(
        tokens.findIndex((t: { text: string }) => t.text.startsWith('The final')),
        1
      )
    if (fault === 'wrong source origin')
      tokens.find((t: { text: string }) => t.text.startsWith('The final')).sourceItem.text =
        'different'
    if (fault === 'open face') frames.pop()
    if (fault === 'unaligned predecessor')
      page.lines.find((l: { text: string }) => l.text.startsWith('Its next')).x += 40
    const result = nativeCaptionedVectorChartStrip(
      page,
      page.caption,
      [page.caption],
      [],
      tokens,
      frames
    )
    expect(result?.rect[1]).toBe(92)
  }
)

const ruledRowBelowParagraph = (): ReturnType<typeof JSON.parse> => {
  const { page, frames } = closedRowBelowParagraph()
  for (const [left] of frames) {
    page.lines.push({ text: '4', x: left + 8, y: 150, width: 16, height: 7, fontSize: 7 })
    page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [left + 8, 122, left + 55, 155].map(
        (v, n) => v / (n % 2 ? page.height : page.width)
      )
    })
  }
  const tokens = page.lines.map(
    (
      line: { text: string; x: number; y: number; width: number; height: number; fontSize: number },
      index: number
    ) => ({
      text: line.text,
      rect: [line.x, line.y, line.x + line.width, line.y + line.height],
      height: line.fontSize,
      baseline: line.y + line.height,
      horizontal: true,
      sourceItem: { pageNumber: 1, index, text: line.text }
    })
  )
  const rules = frames.flatMap(([left, top, right, bottom]: number[]) => [
    [left, top, right, top],
    [left, bottom, right, bottom],
    [left, top, left, bottom],
    [right, top, right, bottom]
  ])
  return { page, frames, rules, tokens }
}

it('keeps whole body tails excluded when native rule-frame completion runs after strip association', () => {
  const { page, frames, rules, tokens } = ruledRowBelowParagraph()
  const result = associateFigures(page, [page.caption], [], rules, frames, tokens)[0]
  expect(result.rect[1]).toBe(112)
  expect(result.rect[3]).toBe(177)
  expect(result.excludedProseLines.map((line: { text: string }) => line.text)).toContain('-2')
  expect(result.excludedProseLines.map((line: { text: string }) => line.text)).toContain(').')
})

it.each(['missing original font', 'wrong source origin', 'open face'])(
  'keeps rule-frame completion conservative without the paragraph proof: %s',
  (fault) => {
    const { page, frames, rules, tokens } = ruledRowBelowParagraph()
    const final = tokens.find((t: { text: string }) => t.text.startsWith('The final'))
    if (fault === 'missing original font') tokens.splice(tokens.indexOf(final), 1)
    if (fault === 'wrong source origin') final.sourceItem.text = 'different'
    if (fault === 'open face') frames.pop()
    const result = associateFigures(page, [page.caption], [], rules, frames, tokens)[0]
    expect(result.rect[1]).toBe(91)
    expect(
      (result.excludedProseLines ?? []).some((line: { text: string }) =>
        ['The final term (10', '-2', ').'].includes(line.text)
      )
    ).toBe(false)
  }
)

it('claims a framed native bar chart immediately before its caption', () => {
  const width = 600
  const height = 800
  const caption = {
    page: 1,
    lines: ['Figure 4: Test error by method.'],
    rect: [100, 520, 500, 530]
  }
  const rects = [
    [120, 300, 480, 500],
    [120, 300, 126, 500],
    [120, 300, 480, 306],
    [160, 320, 200, 410],
    [230, 320, 270, 445],
    [300, 320, 340, 390],
    [370, 320, 410, 460],
    [440, 320, 470, 430]
  ]
  const page = {
    pageNumber: 1,
    width,
    height,
    invalidGraphicsBounds: 0,
    graphicsBounds: rects.map((rect) => ({
      kind: 'path',
      normalizedRect: rect.map((value, index) => value / (index % 2 ? height : width))
    })),
    lines: [
      { text: caption.lines[0], x: 100, y: 520, width: 300, height: 10, fontSize: 10 },
      ...['0.00', '0.02', '0.04', '0.06', '0.08'].map((text, index) => ({
        text,
        x: 126,
        y: 320 + index * 35,
        width: 18,
        height: 8,
        fontSize: 8
      })),
      {
        text: 'Alpha Beta Gamma Delta Epsilon',
        x: 160,
        y: 485,
        width: 210,
        height: 8,
        fontSize: 8
      },
      { text: 'Test error', x: 128, y: 350, width: 35, height: 8, fontSize: 8 },
      { text: 'Method', x: 290, y: 470, width: 35, height: 8, fontSize: 8 }
    ],
    caption
  }
  const result = nativeCaptionedVectorBarChart(page, caption, [caption], [])
  expect(result?.rect).toEqual([120, 300, 480, 500])
  expect(result?.graphicsCount).toBe(8)
  expect(associateFigures(page, [caption])[0].rect).toEqual([120, 300, 480, 500])
})

it('claims a compact framed native plot when its ticks and legend are complete', () => {
  const width = 612
  const height = 792
  const caption = {
    page: 1,
    lines: ['Figure 6: Relative error by neighborhood size.'],
    rect: [318, 334, 506, 344]
  }
  const frame = [356, 229, 502, 309]
  const paths = [
    frame,
    [356, 229, 502, 235],
    [356, 303, 502, 309],
    [356, 229, 362, 309],
    [496, 229, 502, 309],
    [370, 248, 378, 256],
    [390, 260, 398, 268],
    [410, 272, 418, 280],
    [430, 284, 438, 292],
    [450, 292, 458, 300],
    [470, 292, 478, 300],
    [490, 292, 498, 300]
  ]
  const page = {
    pageNumber: 1,
    width,
    height,
    invalidGraphicsBounds: 0,
    graphicsBounds: paths.map((rect) => ({
      kind: 'path',
      normalizedRect: rect.map((value, index) => value / (index % 2 ? height : width))
    })),
    lines: [
      { text: caption.lines[0], x: 318, y: 334, width: 188, height: 10, fontSize: 10 },
      ...['0.01', '0.03', '0.10', '0.30'].map((text, index) => ({
        text,
        x: 345,
        y: 244 + index * 14,
        width: 20,
        height: 8,
        fontSize: 8
      })),
      { text: 'Number of anchors', x: 384, y: 298, width: 80, height: 8, fontSize: 8 },
      { text: 'Model A', x: 424, y: 238, width: 36, height: 8, fontSize: 8 },
      { text: 'Model B', x: 424, y: 246, width: 36, height: 8, fontSize: 8 }
    ],
    caption
  }
  const result = nativeCaptionedVectorBarChart(page, caption, [caption], [])
  expect(result?.reason).toBe('native-vector-bar-chart')
  expect(result?.rect).toEqual([345, 229, 502, 309])
  expect(associateFigures(page, [caption])[0].rect).toEqual([345, 229, 502, 309])
})

it('claims adjacent unframed native bar panels immediately before their caption', () => {
  const width = 600
  const height = 800
  const caption = {
    page: 1,
    lines: ['Figure 5: Modalities across experts.'],
    rect: [110, 520, 490, 530]
  }
  const bars = [
    ...[150, 165, 180, 195, 210, 225].map((left, index) => [
      left,
      360 + (index % 3) * 20,
      left + 10,
      500
    ]),
    ...[300, 315, 330, 345, 360, 375].map((left, index) => [
      left,
      350 + (index % 3) * 25,
      left + 10,
      500
    ])
  ]
  const page = {
    pageNumber: 1,
    width,
    height,
    invalidGraphicsBounds: 0,
    graphicsBounds: bars.map((rect) => ({
      kind: 'path',
      normalizedRect: rect.map((value, index) => value / (index % 2 ? height : width))
    })),
    lines: [
      { text: caption.lines[0], x: 110, y: 520, width: 280, height: 10, fontSize: 10 },
      { text: 'Text', x: 170, y: 345, width: 25, height: 8, fontSize: 8 },
      { text: 'Image', x: 320, y: 335, width: 30, height: 8, fontSize: 8 },
      { text: '0% 25% 50% 75% 100%', x: 120, y: 505, width: 100, height: 8, fontSize: 8 }
    ],
    caption
  }
  const result = nativeCaptionedVectorBarPanels(page, caption, [caption], [])
  expect(result?.reason).toBe('native-vector-bar-panels')
  expect(result?.graphicsCount).toBe(12)
  expect(result?.rect[0]).toBeLessThanOrEqual(140)
  expect(result?.rect[2]).toBeGreaterThanOrEqual(390)
  expect(associateFigures(page, [caption])[0].reason).toBe('native-vector-bar-panels')
})
