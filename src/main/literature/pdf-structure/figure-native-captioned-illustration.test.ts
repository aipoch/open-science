import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { nativeCaptionedTextIllustration, nativeLetteredRasterArray } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-figure-native-captioned-illustration.mjs')
  ).href
)
const plate = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/unequal-lettered-raster-plate.jsonl'
    )
  )
it('owns every unequal raster and attached key under the centered caption', () => {
  const f = plate()
  const match = associateFigures(f.page, [f.caption], [], [], [], f.tokens)[0]
  expect(match.rect).toEqual([30, 120, 570, 485])
})
it.each([
  'missing-key',
  'broken-key',
  'duplicate-key',
  'wrong-sequence',
  'foreign-prose',
  'table',
  'caption'
])('declines unproved lettered plates: %s', (reason) => {
  const f = plate(),
    tables: number[][] = [],
    captions = [f.caption]
  if (reason === 'missing-key') f.tokens.pop()
  if (reason === 'broken-key') f.tokens[2].baseline += 2
  if (reason === 'duplicate-key') f.tokens.push({ ...f.tokens.at(-1) })
  if (reason === 'wrong-sequence') f.caption.lines[0] = f.caption.lines[0].replace('(f)', '(g)')
  if (reason === 'foreign-prose')
    f.tokens.push({
      text: 'Independent source paragraph inside the crop area.',
      rect: [100, 260, 450, 270],
      horizontal: true,
      height: 10,
      baseline: 270
    })
  if (reason === 'table') tables.push([300, 300, 400, 400])
  if (reason === 'caption')
    captions.push({ page: 1, lines: ['Figure 2. Other.'], rect: [40, 300, 180, 310] })
  expect(nativeLetteredRasterArray(f.page, f.caption, captions, tables, f.tokens)).toBeUndefined()
})
const illustratedText = (): ReturnType<typeof JSON.parse> => {
  const caption = { page: 1, lines: ['Figure 2. Source illustration.'], rect: [50, 180, 550, 190] }
  return {
    caption,
    page: {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: [
        ...Array.from({ length: 7 }, (_, i) => ({
          text: `${i}: ${'Synthetic text '.repeat(6)}`,
          x: 80,
          y: 75 + i * 12,
          width: 430,
          height: 5,
          fontSize: 5
        })),
        { text: caption.lines[0], x: 50, y: 180, width: 500, height: 10, fontSize: 10 }
      ],
      graphicsBounds: [{ kind: 'path', normalizedRect: [50 / 600, 65 / 800, 550 / 600, 175 / 800] }]
    }
  }
}
it.each(['body-font', 'table', 'competing-caption', 'far-caption', 'incomplete-content'])(
  'declines an unproved text illustration: %s',
  (reason) => {
    const f = illustratedText(),
      tables: number[][] = [],
      captions = [f.caption]
    if (reason === 'body-font') f.page.lines[0].fontSize = 10
    if (reason === 'table') tables.push([50, 80, 550, 150])
    if (reason === 'competing-caption')
      captions.push({ page: 1, lines: ['Figure 3. Other.'], rect: [60, 90, 200, 100] })
    if (reason === 'far-caption') f.caption.rect[1] = 230
    if (reason === 'incomplete-content') f.page.lines = f.page.lines.slice(-3)
    expect(nativeCaptionedTextIllustration(f.page, f.caption, captions, tables)).toBeUndefined()
  }
)
