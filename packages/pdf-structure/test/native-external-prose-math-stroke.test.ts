import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/native-external-prose-math-stroke.jsonl'))
it('keeps a remote shallow mathematical stroke and native formula heads in their prose column', () => {
  const { page, captions } = fixture(),
    before = structuredClone({ page, captions }),
    [figure] = associateFigures(page, captions, [])
  expect(figure.rect[0]).toBeLessThanOrEqual(35)
  expect(figure.rect[2]).toBeGreaterThanOrEqual(295)
  expect(figure.rect[2]).toBeLessThan(298)
  expect({ page, captions }).toEqual(before)
})
it.each([0.75, 1.7])(
  'preserves external prose ownership under scale %s and reversed source order',
  (scale) => {
    const { page, captions } = fixture()
    page.width *= scale
    page.height *= scale
    for (const l of page.lines)
      for (const k of ['x', 'y', 'width', 'height', 'fontSize']) l[k] *= scale
    for (const c of captions) c.rect = c.rect.map((v: number) => v * scale)
    page.lines.reverse()
    page.graphicsBounds.reverse()
    const before = structuredClone({ page, captions }),
      [figure] = associateFigures(page, captions, [])
    expect(figure.rect[2]).toBeGreaterThanOrEqual(295 * scale)
    expect(figure.rect[2]).toBeLessThan(298 * scale)
    expect({ page, captions }).toEqual(before)
  }
)
it.each([
  { missing: 'no upper prose', scale: 0.75 },
  { missing: 'no lower prose', scale: 1.7 },
  { missing: 'no independent column', scale: 0.75 },
  { missing: 'unmatched typography', scale: 1.7 }
])(
  'retains a remote native stroke without independent bracketed prose evidence: $missing at $scale',
  ({ missing, scale }) => {
    const { page, captions } = fixture()
    if (missing === 'no upper prose')
      page.lines = page.lines.filter((l: ReturnType<typeof JSON.parse>) => l.x < 300 || l.y > 195)
    if (missing === 'no lower prose')
      page.lines = page.lines.filter((l: ReturnType<typeof JSON.parse>) => l.x < 300 || l.y < 210)
    if (missing === 'no independent column') captions[0].rect[2] = 550
    if (missing === 'unmatched typography')
      for (const l of page.lines.filter((l: ReturnType<typeof JSON.parse>) => l.x > 300))
        l.fontSize += 2
    page.width *= scale
    page.height *= scale
    for (const line of page.lines)
      for (const key of ['x', 'y', 'width', 'height', 'fontSize']) line[key] *= scale
    for (const caption of captions) caption.rect = caption.rect.map((v: number) => v * scale)
    const before = structuredClone({ page, captions }),
      [figure] = associateFigures(page, captions, [])
    expect(figure.rect[2]).toBeGreaterThan(400 * scale)
    expect({ page, captions }).toEqual(before)
  }
)
it('preserves the same shallow native stroke inside the owned chart axes', () => {
  const { page, captions } = fixture(),
    bar = page.graphicsBounds.find(
      (g: ReturnType<typeof JSON.parse>) =>
        g.normalizedRect[0] > 0.54 &&
        g.normalizedRect[0] < 0.55 &&
        g.normalizedRect[1] > 0.24 &&
        g.normalizedRect[1] < 0.25
    )
  expect(bar).toBeDefined()
  bar.normalizedRect = bar.normalizedRect.map((v: number, i: number) => v - (i % 2 ? 0 : 0.35))
  const before = structuredClone({ page, captions }),
    [figure] = associateFigures(page, captions, [])
  expect(figure.graphicsCount).toBe(115)
  expect(figure.rect[2]).toBeLessThan(298)
  expect({ page, captions }).toEqual(before)
})
