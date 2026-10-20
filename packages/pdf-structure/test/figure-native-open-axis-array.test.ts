import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { nativeOpenAxisArray } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-open-axis-array.mjs')).href
)
const input = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/repeated-open-axes-with-isolated-native-labels.jsonl'))
const mixedInput = (): ReturnType<typeof JSON.parse> => {
  const page: ReturnType<typeof JSON.parse> = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds: [
      {
        kind: 'image',
        operationIndex: 1,
        normalizedRect: [100 / 600, 400 / 800, 220 / 600, 510 / 800]
      }
    ]
  }
  const rules: number[][] = []
  let operationIndex = 2
  for (const x of [100, 250, 400]) {
    rules.push([x, 550, x, 640], [x, 640, x + 120, 640])
    for (const [dx, dy] of [
      [10, 10],
      [40, 40]
    ])
      page.graphicsBounds.push({
        kind: 'path',
        operationIndex: operationIndex++,
        normalizedRect: [
          (x + dx) / 600,
          (550 + dy) / 800,
          (x + dx + 15) / 600,
          (550 + dy + 15) / 800
        ]
      })
    for (const y of [550, 580])
      page.lines.push({ text: '1', fontSize: 6, x: x - 8, y, width: 4, height: 6 })
  }
  return {
    page,
    rules,
    captions: [{ page: 1, lines: ['Figure 1: Example panels.'], rect: [70, 670, 550, 700] }]
  }
}
it('keeps an upper raster when open axes describe only the lower part of a mixed figure', () => {
  const f = mixedInput()
  expect(nativeOpenAxisArray(f.page, f.captions, [], f.rules)).toBeUndefined()
  const result = associateFigures(f.page, f.captions, [], f.rules)
  expect(result).toHaveLength(1)
  expect(result[0].rect[1]).toBeLessThanOrEqual(400)
  expect(result[0].rect[2]).toBeGreaterThanOrEqual(520)
  expect(result[0].rect[3]).toBeGreaterThanOrEqual(640)
})
it.each(['prose', 'short-prose', 'table', 'corridor-table', 'beside-table'])(
  'keeps independently separated upper %s content outside the vector crop',
  (kind) => {
    const f = mixedInput()
    const tables =
      kind === 'table'
        ? [[90, 390, 230, 520]]
        : kind === 'corridor-table'
          ? [[95, 515, 225, 540]]
          : kind === 'beside-table'
            ? [[300, 450, 350, 480]]
            : []
    if (kind === 'prose' || kind === 'short-prose')
      f.page.lines.push({
        text:
          kind === 'short-prose'
            ? 'This is an independent paragraph.'
            : 'An independent paragraph separates the preceding image from the following plots.',
        fontSize: 10,
        x: 70,
        y: 520,
        width: 480,
        height: 12
      })
    const result = associateFigures(f.page, f.captions, tables, f.rules)
    expect(result).toHaveLength(1)
    expect(result[0].rect).toEqual([92, 550, 520, 640])
  }
)
it('keeps an independently captioned upper image separate from the lower vector panels', () => {
  const f = mixedInput()
  f.captions.unshift({
    page: 1,
    lines: ['Figure 2: Independent image.'],
    rect: [70, 515, 550, 535]
  })
  const result = associateFigures(f.page, f.captions, [], f.rules)
  expect(result).toHaveLength(2)
  expect(result[0].rect[3]).toBeLessThanOrEqual(510)
  expect(result[1].rect[1]).toBeGreaterThanOrEqual(550)
})
it.each(['table', 'prose'])(
  'rejects a generic expansion that crosses independent %s beyond the local raster corridor',
  (kind) => {
    const f = mixedInput()
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex: 99,
      normalizedRect: [100 / 600, 10 / 800, 220 / 600, 100 / 800]
    })
    const tables = kind === 'table' ? [[95, 200, 225, 300]] : []
    if (kind === 'prose')
      f.page.lines.push({
        text: 'Independent earlier discussion.',
        fontSize: 10,
        x: 70,
        y: 250,
        width: 480,
        height: 12
      })
    expect(associateFigures(f.page, f.captions, tables, f.rules)[0].rect).toEqual([
      92, 550, 520, 640
    ])
  }
)
it.each(['no-raster', 'beside-array', 'inside-face', 'distant-raster'])(
  'preserves the complete vector crop with %s content',
  (kind) => {
    const f = mixedInput()
    if (kind === 'no-raster') f.page.graphicsBounds.shift()
    if (kind === 'beside-array')
      f.page.graphicsBounds[0].normalizedRect = [0, 400 / 800, 50 / 600, 510 / 800]
    if (kind === 'inside-face')
      f.page.graphicsBounds[0].normalizedRect = [110 / 600, 560 / 800, 160 / 600, 600 / 800]
    if (kind === 'distant-raster')
      f.page.graphicsBounds[0].normalizedRect = [100 / 600, 10 / 800, 220 / 600, 100 / 800]
    expect(associateFigures(f.page, f.captions, [], f.rules)[0].rect).toEqual([92, 550, 520, 640])
  }
)
it('does not use prose outside the complete figure column to discard a mixed panel', () => {
  const f = mixedInput()
  f.page.lines.push({
    text: 'An independent paragraph in another column cannot separate these two panels.',
    fontSize: 10,
    x: 550,
    y: 520,
    width: 40,
    height: 12
  })
  expect(nativeOpenAxisArray(f.page, f.captions, [], f.rules)).toBeUndefined()
})
it('preserves a raster extending above a vector face and the complete native axes', () => {
  const f = mixedInput()
  f.page.graphicsBounds[0].normalizedRect = [100 / 600, 500 / 800, 220 / 600, 570 / 800]
  const result = associateFigures(f.page, f.captions, [], f.rules)
  expect(result[0].rect[1]).toBeLessThanOrEqual(500)
  expect(result[0].rect[2]).toBeGreaterThanOrEqual(520)
  expect(result[0].rect[3]).toBeGreaterThanOrEqual(640)
})
it('recovers all populated open axes and the native marker legend', () => {
  const f = input()
  const result = associateFigures(f.page, f.captions, [], f.rules)
  expect(result[0].rect).toBeDefined()
  expect(result[0].rect[1]).toBeLessThan(220)
  expect(result[0].rect[3]).toBeGreaterThanOrEqual(522)
})
it.each(['missing-axis', 'foreign-prose', 'competing-caption', 'missing-ink', 'foreign-table'])(
  'rejects incomplete native array proof: %s',
  (reason) => {
    const f = input()
    if (reason === 'missing-axis') f.rules = f.rules.filter((r: number[]) => r[0] !== r[2])
    if (reason === 'foreign-prose')
      f.page.lines.push({
        text: 'Independent sentence. '.repeat(5),
        x: 110,
        y: 235,
        width: 400,
        height: 10,
        fontSize: 10
      })
    if (reason === 'competing-caption')
      f.captions.push({ page: 1, lines: ['Figure 2: Another panel.'], rect: [72, 510, 520, 524] })
    if (reason === 'missing-ink') f.page.graphicsBounds = []
    expect(
      nativeOpenAxisArray(
        f.page,
        f.captions,
        reason === 'foreign-table' ? [[110, 240, 180, 260]] : [],
        f.rules
      )
    ).toBeUndefined()
  }
)

it('preserves the complete native border of an annotation predominantly inside one owned face', () => {
  const f = input()
  f.page.graphicsBounds.push({
    kind: 'path',
    normalizedRect: [
      483.66175 / f.page.width,
      220.3383984375 / f.page.height,
      525.51709375 / f.page.width,
      249.93609375 / f.page.height
    ]
  })
  expect(nativeOpenAxisArray(f.page, f.captions, [], f.rules).rect[2]).toBeGreaterThanOrEqual(
    525.51709375
  )
})

it('declines replacement when an external native raster legend is not owned by an axis face', () => {
  const f = input(),
    r = nativeOpenAxisArray(f.page, f.captions, [], f.rules).rect
  f.page.graphicsBounds.push({
    kind: 'image',
    normalizedRect: [
      r[0] / f.page.width,
      (r[3] + 2) / f.page.height,
      (r[0] + 60) / f.page.width,
      (r[3] + 6) / f.page.height
    ]
  })
  expect(nativeOpenAxisArray(f.page, f.captions, [], f.rules)).toBeUndefined()
})
it('declines replacement when repeated native top titles would be dropped', () => {
  const f = input()
  const axes = f.rules.filter((r: number[]) => r[0] === r[2] && r[3] - r[1] >= 35)
  const y = Math.min(...axes.map((r: number[]) => r[1]))
  for (const r of axes.filter((r: number[]) => Math.abs(r[1] - y) < 0.05))
    f.page.lines.push({
      text: 'Panel title',
      x: r[0] + 10,
      y: y - 16,
      width: 50,
      height: 14,
      fontSize: 14
    })
  expect(nativeOpenAxisArray(f.page, f.captions, [], f.rules)).toBeUndefined()
})
