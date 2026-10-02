import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/unframed-outline-flowchart-beside-caption.jsonl'
    )
  )
it('follows a connected outlined allocation tree beside its caption through every branch', () => {
  const { page, caption, tableCaption } = fixture(),
    result = associateFigures(page, [caption, tableCaption])
  expect(result).toHaveLength(1)
  expect(result[0].rect[0]).toBeLessThan(page.width * 0.3)
  expect(result[0].rect[2]).toBeGreaterThan(page.width * 0.92)
  expect(result[0].rect[3]).toBeGreaterThan(page.height * 0.23)
})
it('does not borrow disconnected boxes from a separate drawing', () => {
  const { page, caption, tableCaption } = fixture()
  page.graphicsBounds = page.graphicsBounds.slice(0, 15)
  const result = associateFigures(page, [caption, tableCaption])
  expect(result[0]?.graphicsCount ?? 0).toBeLessThan(15)
})
it('excludes paired publisher masthead images from independent figure panels beneath the journal homepage', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/paired-masthead-images-above-independent-figure-panels.jsonl'
    )
  )
  const result = associateFigures(f.page, f.captions)
  expect(result).toHaveLength(2)
  expect(result[0].rect[1]).toBeGreaterThan(f.page.height * 0.23)
  expect(result[0].rect[2]).toBeLessThan(f.page.width * 0.88)
  expect(result[0].graphicsCount).toBe(1)
})
