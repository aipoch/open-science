import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { nativeCaptionedAlignedRasterPair } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-figure-native-captioned-illustration.mjs')
  ).href
)
const { associateFigures, associatePreviousPageRasterFigure } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-raster-pairs-following-caption.jsonl'
    )
  )

it.each([0, 1, 2])('restores both independently hashed source panels in layout %i', (index) => {
  const { page, captions } = fixture().pairs[index]
  const before = structuredClone({ page, captions })
  const found = nativeCaptionedAlignedRasterPair(page, captions.at(-1), captions, [])
  expect(found?.graphicsCount).toBe(2)
  const images = page.graphicsBounds.filter((g: ReturnType<typeof JSON.parse>) => g.imageHash)
  for (const image of images) {
    const rect = (image.paintedNormalizedRect ?? image.normalizedRect).map(
      (value: number, i: number) => value * (i % 2 ? page.height : page.width)
    )
    expect(found.rect[0]).toBeLessThanOrEqual(rect[0])
    expect(found.rect[1]).toBeLessThanOrEqual(rect[1])
    expect(found.rect[2]).toBeGreaterThanOrEqual(rect[2])
    expect(found.rect[3]).toBeGreaterThanOrEqual(Math.min(rect[3], captions.at(-1).rect[1] - 0.5))
  }
  expect(found.rect[3]).toBeLessThan(captions.at(-1).rect[1])
  expect(associateFigures(page, captions).at(-1).rect).toEqual(found.rect)
  expect({ page, captions }).toEqual(before)
})

it.each([
  'hash',
  'duplicate-hash',
  'misalignment',
  'third-image',
  'caption',
  'prose',
  'table',
  'owner',
  'nonfinite',
  'invalid-painted'
])('declines an aligned raster pair with %s ambiguity', (failure) => {
  const { page, captions } = fixture().pairs[0]
  const caption = captions.at(-1)
  const images = page.graphicsBounds.filter((g: ReturnType<typeof JSON.parse>) => g.imageHash)
  const tables: number[][] = [],
    owners: number[][] = []
  if (failure === 'hash') delete images[0].imageHash
  if (failure === 'duplicate-hash') images[0].imageHash = images[1].imageHash
  if (failure === 'misalignment') images[0].paintedNormalizedRect[0] += 0.08
  if (failure === 'third-image') page.graphicsBounds.push({ ...images[0], imageHash: 'third' })
  if (failure === 'nonfinite') images[0].normalizedRect[0] = Number.NaN
  if (failure === 'invalid-painted') images[0].paintedNormalizedRect[0] = -0.1
  if (failure === 'caption')
    captions.push({ page: 1, rect: [54, 375, 294, 388], lines: ['Figure 3. Separate panel.'] })
  if (failure === 'prose')
    page.lines.push({
      text: 'An independent source paragraph separates the two panels.',
      fontSize: 9,
      x: 54,
      y: 375,
      width: 239,
      height: 10
    })
  if (failure === 'table') tables.push([54, 375, 294, 388])
  if (failure === 'owner') owners.push([54, 175, 294, 372])
  expect(nativeCaptionedAlignedRasterPair(page, caption, captions, tables, owners)).toBeUndefined()
})

it.each([0, 1])(
  'preserves preceding owners when the terminal raster caption is on the next page %i',
  (index) => {
    const { pages, captions } = fixture().split[index]
    const before = structuredClone({ pages, captions })
    const owned = associateFigures(pages[0], captions)
    const found = associatePreviousPageRasterFigure(pages[0], pages, captions, [], owned)
    expect(found).toHaveLength(1)
    expect(found[0].caption.page).toBe(2)
    expect(found[0].caption.lines[0]).toBe('Figure 2. Anonymous raster plate.')
    expect(found[0].graphicsCount).toBe(index ? 3 : 1)
    expect(found[0].rect[1]).toBeGreaterThan(owned[0].rect[3])
    expect(associateFigures(pages[1], captions).at(-1).caption.lines[0]).toBe(
      'Figure 3. Anonymous raster plate.'
    )
    expect({ pages, captions }).toEqual(before)
  }
)

it.each([
  'hash',
  'number',
  'top-prose',
  'terminal-prose',
  'caption',
  'table',
  'owner',
  'extra-image',
  'duplicate-title'
])('does not borrow a previous-page raster with %s ambiguity', (failure) => {
  const { pages, captions } = fixture().split[0]
  const source = pages[0],
    next = pages[1]
  const target = source.graphicsBounds.find(
    (g: ReturnType<typeof JSON.parse>) => g.imageHash && g.normalizedRect[1] > 0.5
  )
  const tables: number[][] = []
  const owned = associateFigures(source, captions)
  const rect = [126, 452, 486, 701]
  if (failure === 'hash') delete target.imageHash
  if (failure === 'number')
    captions.find((c: ReturnType<typeof JSON.parse>) => c.page === 2).lines[0] =
      'Figure 8. Anonymous raster plate.'
  if (failure === 'top-prose')
    next.lines.push({
      text: 'An independent source paragraph precedes the caption.',
      fontSize: 11,
      x: 100,
      y: 40,
      width: 400,
      height: 11
    })
  if (failure === 'terminal-prose')
    source.lines.push({
      text: 'An independent discussion follows the raster.',
      fontSize: 11,
      x: 126,
      y: 708,
      width: 360,
      height: 11
    })
  if (failure === 'caption')
    captions.push({ page: 1, rect: [126, 600, 486, 614], lines: ['Figure 7. Different plate.'] })
  if (failure === 'table') tables.push(rect)
  if (failure === 'owner') owned.push({ rect, caption: captions[0] })
  if (failure === 'extra-image') source.graphicsBounds.push({ ...target, imageHash: 'another' })
  if (failure === 'duplicate-title')
    captions.push(
      structuredClone(captions.find((c: ReturnType<typeof JSON.parse>) => c.page === 2))
    )
  expect(associatePreviousPageRasterFigure(source, pages, captions, tables, owned)).toEqual([])
})
