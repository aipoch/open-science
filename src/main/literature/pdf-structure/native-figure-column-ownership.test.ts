import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { associateFigures, findAlgorithmCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { nativeAttachedPlotLabels } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-native-plot-labels.mjs'))
    .href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-figure-column-ownership.jsonl'
    )
  )

it.each([0, 1])(
  'keeps an independent left-column owner outside right-column figures %i',
  (index) => {
    const { page, captions } = fixture().figures[index]
    const before = structuredClone({ page, captions })
    const figures = associateFigures(page, captions)
    const right = figures.filter(
      (f: ReturnType<typeof JSON.parse>) => f.caption.rect[0] > page.width / 2
    )
    expect(right).toHaveLength(index ? 2 : 1)
    for (const figure of right) {
      expect(figure.rect).toBeDefined()
      expect(figure.rect[0]).toBeGreaterThan(page.width / 2)
      expect(figure.rect[2]).toBeGreaterThan(page.width * 0.85)
    }
    if (index) {
      const left = figures.find(
        (f: ReturnType<typeof JSON.parse>) => f.caption.rect[0] < page.width / 2
      )
      for (const image of page.graphicsBounds.filter(
        (g: ReturnType<typeof JSON.parse>) => g.kind === 'image'
      )) {
        const rect = image.normalizedRect.map(
          (v: number, i: number) => v * (i % 2 ? page.height : page.width)
        )
        expect(left.rect[1]).toBeLessThanOrEqual(rect[1])
        expect(left.rect[3]).toBeGreaterThanOrEqual(rect[3])
      }
    }
    expect({ page, captions }).toEqual(before)
  }
)

it.each([0.75, 1.5])('preserves source ownership under scale %s and input reversal', (scale) => {
  for (const { page, captions } of fixture().figures) {
    const before = associateFigures(page, captions)
    page.width *= scale
    page.height *= scale
    for (const line of page.lines)
      for (const key of ['x', 'y', 'width', 'height', 'fontSize']) line[key] *= scale
    for (const caption of captions) caption.rect = caption.rect.map((v: number) => v * scale)
    page.graphicsBounds.reverse()
    page.lines.reverse()
    captions.reverse()
    const after = associateFigures(page, captions)
    for (const original of before) {
      const found = after.find(
        (f: ReturnType<typeof JSON.parse>) => f.caption.lines[0] === original.caption.lines[0]
      )
      expect(found?.rect).toBeDefined()
      if (found.caption.rect[0] > page.width / 2)
        expect(found.rect[0]).toBeGreaterThan(page.width / 2)
      else
        for (const image of page.graphicsBounds.filter(
          (g: ReturnType<typeof JSON.parse>) => g.kind === 'image'
        )) {
          const rect = image.normalizedRect.map(
            (v: number, i: number) => v * (i % 2 ? page.height : page.width)
          )
          expect(found.rect[1]).toBeLessThanOrEqual(rect[1])
          expect(found.rect[3]).toBeGreaterThanOrEqual(rect[3])
        }
    }
  }
})

it('requires a surrounding native prose column before excluding a detached path', () => {
  const { page, captions } = fixture().figures[0]
  page.lines = page.lines.slice(0, 2)
  expect(associateFigures(page, captions)[0].rect[0]).toBeLessThan(page.width / 2)
})

it('keeps a short source rotated axis label bracketed between repeated native ticks', () => {
  const { page, figure, tokens } = fixture().axis
  const before = structuredClone({ page, figure, tokens })
  const found = nativeAttachedPlotLabels(page, figure, [], [], [], tokens)
  expect(found.rect[0]).toBeLessThanOrEqual(
    tokens.find((t: ReturnType<typeof JSON.parse>) => t.text === 'Q').rect[0]
  )
  expect({ page, figure, tokens }).toEqual(before)
})

it.each(['rotation', 'unobserved-rotation', 'unbracketed', 'other-column', 'caption', 'table'])(
  'requires source ownership before extending a rotated axis label: %s',
  (missing) => {
    const { page, figure, tokens } = fixture().axis
    const captions: ReturnType<typeof JSON.parse>[] = [],
      tables: number[][] = []
    if (missing === 'rotation') for (const token of tokens) token.horizontal = true
    if (missing === 'unobserved-rotation') for (const token of tokens) delete token.horizontal
    if (missing === 'unbracketed')
      for (const token of tokens.filter((t: ReturnType<typeof JSON.parse>) => !t.horizontal))
        token.rect = [token.rect[0], 230, token.rect[2], 236]
    if (missing === 'other-column')
      for (const token of tokens.filter((t: ReturnType<typeof JSON.parse>) => !t.horizontal))
        token.rect = [200, token.rect[1], 210, token.rect[3]]
    if (missing === 'caption') captions.push({ page: 1, rect: [320, 135, 345, 151] })
    if (missing === 'table') tables.push([320, 135, 345, 151])
    expect(nativeAttachedPlotLabels(page, figure, captions, tables, [], tokens)).toEqual(figure)
  }
)

it('recognizes an explicitly titled ruled numbered loop with a terminal return', () => {
  const page = fixture().procedure
  const before = structuredClone(page)
  const algorithms = findAlgorithmCandidates(page)
  expect(algorithms).toHaveLength(1)
  expect(algorithms[0].caption.lines).toEqual(['Algorithm 1 UPDATE(S, b)'])
  expect(algorithms[0].rect[1]).toBeLessThan(page.lines[0].y)
  expect(algorithms[0].rect[3]).toBeGreaterThan(page.lines.at(-1).y + page.lines.at(-1).height)
  expect(page).toEqual(before)
})

it.each([
  'title',
  'opening',
  'separator',
  'closing',
  'ordinal',
  'loop',
  'assignment',
  'return',
  'alignment'
])('requires complete native procedure proof with %s intact', (missing) => {
  const page = fixture().procedure
  if (missing === 'title') page.lines[0].text = 'Table 1 UPDATE(S, b)'
  if (missing === 'opening') page.graphicsBounds.shift()
  if (missing === 'separator') page.graphicsBounds.splice(1, 1)
  if (missing === 'closing') page.graphicsBounds.pop()
  if (missing === 'ordinal') page.lines[2].text = '5: result ← SELECT(S, b, h)'
  if (missing === 'loop') page.lines[1].text = '1: Ordinary measurement heading'
  if (missing === 'assignment') page.lines[2].text = '2: Ordinary numbered explanation'
  if (missing === 'return') page.lines[4].text = '4: Ordinary concluding paragraph'
  if (missing === 'alignment') page.lines[2].x -= 40
  expect(findAlgorithmCandidates(page)).toEqual([])
})
