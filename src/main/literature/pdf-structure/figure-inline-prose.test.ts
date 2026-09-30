import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
it('excludes a preceding paragraph split into native text runs around a superscript', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/figure-below-prose-with-inline-superscript.jsonl'
    )
  )
  const before = structuredClone(f)
  const [figure] = associateFigures(f.page, f.captions)
  expect(figure.rect[1]).toBeGreaterThan(473)
  expect(figure.rect[1]).toBeLessThan(483)
  expect(figure.rect[3]).toBeGreaterThan(690)
  expect(f).toEqual(before)
})
it('retains nearby titles without an independently established external paragraph', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/figure-below-prose-with-inline-superscript.jsonl'
    )
  )
  f.page.lines = f.page.lines.filter((l: { y: number }) => l.y >= 444)
  const [figure] = associateFigures(f.page, f.captions)
  expect(figure.rect[1]).toBeLessThan(447)
  expect(figure.rect[3]).toBeGreaterThan(690)
})
