import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const fixture = (name: string): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/${name}.jsonl`))

it('keeps the upper raster plate when a lower raster row owns its fused panel key band', () => {
  const f = fixture('adjacent-raster-plates-with-fused-panel-keys')
  const result = associateFigures(f.page, f.captions, f.tableRects)
  expect(result[0].rect).toEqual([
    109.87704009965597, 83.35547999999996, 502.7048560000001, 246.42999999999995
  ])
  expect(result[1].rect).toEqual([107.578125, 290.8125, 506.8125, 372.373])
  expect(result[1].graphicsCount).toBe(4)
})

it('includes the outside native title above both uniform vector grids', () => {
  const f = fixture('paired-vector-grids-with-outside-native-titles')
  const title = f.page.lines.find((line: { text: string }) =>
    line.text.startsWith('First arrangement')
  )
  const result = associateFigures(f.page, f.captions, f.tableRects)
  expect(result[0].rect[1]).toBeLessThanOrEqual(title.y)
})

it.each(['foreign title', 'missing marker', 'missing grid cells', 'distant title'])(
  'does not extend the vector crop with %s',
  (variant) => {
    const f = fixture('paired-vector-grids-with-outside-native-titles')
    const title = f.page.lines.find((line: { text: string }) =>
      line.text.startsWith('First arrangement')
    )
    if (variant === 'foreign title')
      f.page.lines.push({
        ...title,
        text: 'An independent note',
        x: 180,
        width: 30,
        y: 236,
        height: 6,
        fontSize: 6
      })
    if (variant === 'missing marker')
      f.page.lines = f.page.lines.filter((line: { text: string }) => line.text !== '(b)')
    if (variant === 'missing grid cells')
      f.page.graphicsBounds = f.page.graphicsBounds.filter(
        (g: { normalizedRect: number[] }) => g.normalizedRect[0] > 0.5 || g.normalizedRect[1] > 0.39
      )
    if (variant === 'distant title') title.y -= 30
    const result = associateFigures(f.page, f.captions, f.tableRects)
    expect(result[0].rect?.[1] ?? Infinity).toBeGreaterThan(title.y)
  }
)

const { ownedRasterKeyBand } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-panel-labels.mjs')).href
)
it.each(['prose', 'repeated key', 'distant label', 'missing key', 'competing caption'])(
  'rejects raster key ownership with %s',
  (variant) => {
    const f = fixture('adjacent-raster-plates-with-fused-panel-keys')
    const line = f.page.lines.find((l: { text: string }) => l.text.includes('(d)'))
    if (variant === 'prose')
      line.text = 'A long independent paragraph about several unrelated groups'
    if (variant === 'repeated key') line.text = line.text.replace('(b)', '(a)')
    if (variant === 'distant label') line.y += 25
    if (variant === 'missing key') line.text = line.text.slice(0, line.text.indexOf('(d)'))
    if (variant === 'competing caption') f.captions.push(structuredClone(f.captions[1]))
    expect(ownedRasterKeyBand(line, f.page, f.captions)).toBe(false)
  }
)
