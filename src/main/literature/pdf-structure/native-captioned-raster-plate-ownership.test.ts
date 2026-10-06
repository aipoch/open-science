import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { nativeCaptionedRasterVectorStrip, nativeCaptionedRasterHorizontalArray } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-figure-native-captioned-illustration.mjs')
  ).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-captioned-raster-plate-ownership.jsonl'
    )
  )

it('keeps a neighboring independently captioned vector chart outside a raster inset chart', () => {
  const { page, captions } = fixture().column
  const before = structuredClone({ page, captions })
  const ownCaption = captions.find((c: ReturnType<typeof JSON.parse>) => c.rect[0] < page.width / 2)
  const recovered = nativeCaptionedRasterVectorStrip(page, ownCaption, captions, [])
  if (recovered) expect(recovered.rect[2]).toBeLessThan(306)
  const figures = associateFigures(page, captions, [])
  const left = figures.find(
    (f: ReturnType<typeof JSON.parse>) => f.caption.rect[0] < page.width / 2
  )
  expect(left.rect).toBeDefined()
  expect(left.rect[0]).toBeLessThanOrEqual(47.8125)
  expect(left.rect[1]).toBeLessThanOrEqual(49.5)
  expect(left.rect[2]).toBeGreaterThanOrEqual(303.609375)
  expect(left.rect[2]).toBeLessThan(306)
  expect(left.rect[3]).toBeGreaterThanOrEqual(194.90625)
  expect({ page, captions }).toEqual(before)
})

it.each([0.75, 1.5])('preserves complete raster plate ownership at scale %s', (scale) => {
  const { page, captions } = fixture().rows
  page.width *= scale
  page.height *= scale
  for (const line of page.lines)
    for (const key of ['x', 'y', 'width', 'height', 'fontSize']) line[key] *= scale
  for (const caption of captions) caption.rect = caption.rect.map((v: number) => v * scale)
  page.lines.reverse()
  page.graphicsBounds.reverse()
  const before = structuredClone({ page, captions })
  const plate = nativeCaptionedRasterHorizontalArray(page, captions[0], captions, [])
  expect(plate.graphicsCount).toBe(20)
  expect(plate.rect[1]).toBeLessThanOrEqual(315.446596 * scale)
  expect(plate.rect[3]).toBeGreaterThanOrEqual(542.535383 * scale)
  expect(plate.rect[3]).toBeLessThan(captions[0].rect[1])
  expect({ page, captions }).toEqual(before)
})

it.each([
  'missing label',
  'duplicate label',
  'missing key',
  'prose',
  'table',
  'caption',
  'misaligned row',
  'nonfinite label'
])('does not join two raster rows without complete native ownership: %s', (change) => {
  const { page, captions } = fixture().rows
  const tables: number[][] = []
  const label = page.lines.find((line: ReturnType<typeof JSON.parse>) => /^\(a\)/u.test(line.text))
  if (change === 'missing label') page.lines = page.lines.filter((line: unknown) => line !== label)
  if (change === 'duplicate label') page.lines.push(structuredClone(label))
  if (change === 'missing key') page.graphicsBounds.splice(1, 1)
  if (change === 'prose')
    page.lines.push({
      text: 'An independent paragraph intervenes.',
      x: 100,
      y: 425,
      width: 300,
      height: 9,
      fontSize: 9
    })
  if (change === 'table') tables.push([70, 424, 527, 439])
  if (change === 'caption')
    captions.push({
      page: page.pageNumber,
      text: 'Figure 2: Independent results.',
      lines: ['Figure 2: Independent results.'],
      rect: [70, 424, 527, 439]
    })
  if (change === 'misaligned row')
    for (const graphic of page.graphicsBounds.slice(10))
      graphic.normalizedRect = graphic.normalizedRect.map(
        (v: number, i: number) => v + (i % 2 ? 0 : 0.02)
      )
  if (change === 'nonfinite label') label.x = Number.NaN
  const before = structuredClone({ page, captions, tables })
  const plate = nativeCaptionedRasterHorizontalArray(page, captions[0], captions, tables)
  expect(plate?.graphicsCount ?? 0).toBeLessThan(20)
  expect({ page, captions, tables }).toEqual(before)
})

it.each(['no neighboring caption', 'other page', 'shared native frame'])(
  'preserves the established full width strip when independent neighboring ownership is not proved: %s',
  (change) => {
    const { page, captions } = fixture().column
    const own = captions.find(
      (caption: ReturnType<typeof JSON.parse>) => caption.rect[0] < page.width / 2
    )
    const neighbor = captions.find((caption: ReturnType<typeof JSON.parse>) => caption !== own)
    if (change === 'no neighboring caption') captions.splice(captions.indexOf(neighbor), 1)
    if (change === 'other page') neighbor.page += 1
    if (change === 'shared native frame')
      page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.08, 0.06, 0.92, 0.22] })
    const before = structuredClone({ page, captions })
    const plate = nativeCaptionedRasterVectorStrip(page, own, captions, [])
    expect(plate.rect[2]).toBeGreaterThan(page.width * 0.85)
    expect({ page, captions }).toEqual(before)
  }
)

it('retains both lettered raster rows, every native color key and their labels', () => {
  const { page, captions } = fixture().rows
  const before = structuredClone({ page, captions })
  const [figure] = associateFigures(page, captions, [])
  expect(figure.rect).toBeDefined()
  for (const graphic of page.graphicsBounds) {
    const rect = graphic.normalizedRect.map(
      (v: number, i: number) => v * (i % 2 ? page.height : page.width)
    )
    expect(figure.rect[0]).toBeLessThanOrEqual(rect[0])
    expect(figure.rect[1]).toBeLessThanOrEqual(rect[1])
    expect(figure.rect[2]).toBeGreaterThanOrEqual(rect[2])
    expect(figure.rect[3]).toBeGreaterThanOrEqual(rect[3])
  }
  for (const line of page.lines.filter((l: ReturnType<typeof JSON.parse>) =>
    /^\([a-j]\)/u.test(l.text)
  )) {
    expect(figure.rect[0]).toBeLessThanOrEqual(line.x)
    expect(figure.rect[1]).toBeLessThanOrEqual(line.y)
    expect(figure.rect[2]).toBeGreaterThanOrEqual(line.x + line.width)
    expect(figure.rect[3]).toBeGreaterThanOrEqual(line.y + line.height)
  }
  expect(figure.rect[3]).toBeLessThan(captions[0].rect[1])
  expect({ page, captions }).toEqual(before)
})
