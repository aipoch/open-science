import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { associateRasterTables } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/raster-table-with-embedded-title.jsonl'
    )
  )

it('preserves an embedded table title and raster records without inventing cell text', () => {
  const { page, tables } = load()
  const result = associateRasterTables(page, tables)
  expect(result).toHaveLength(1)
  expect(result[0].rect).toEqual(
    page.graphicsBounds
      .find((g: { kind: string }) => g.kind === 'image')
      .normalizedRect.map((v: number, i: number) => v * (i % 2 ? page.height : page.width))
  )
  expect(result[0].caption).toBeUndefined()
  expect(result[0].grid).toBeUndefined()
  expect(associateRasterTables(page, [...tables, ...tables])).toHaveLength(1)
  expect(associateRasterTables(page, tables, [result[0].rect])).toEqual([])
})

it('retains wrapped criteria when structure evidence supports only one column', () => {
  const { page, tables } = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/raster-table-with-wrapped-criteria.jsonl'
    )
  )
  expect(associateRasterTables(page, tables)).toHaveLength(1)
})

it.each([
  'weak-detection',
  'missing-structure',
  'missing-columns',
  'whole-page-scan',
  'native-prose',
  'small-region'
])('does not promote an ambiguous image with %s', (variant) => {
  const { page, tables } = load()
  if (variant === 'weak-detection') tables[0].detection.score = 0.8
  if (variant === 'missing-structure') tables[0].structure.objects = []
  if (variant === 'missing-columns')
    tables[0].structure.objects = tables[0].structure.objects.filter(
      (o: { label: string }) => o.label !== 'table column'
    )
  if (variant === 'whole-page-scan')
    page.graphicsBounds.find((g: { kind: string }) => g.kind === 'image').normalizedRect = [
      0, 0, 1, 1
    ]
  if (variant === 'native-prose')
    page.lines.push({
      x: 200,
      y: 200,
      width: 300,
      height: 12,
      text: 'Native prose within a scanned region'
    })
  if (variant === 'small-region') tables[0].cropRect = [300, 300, 500, 500]
  expect(associateRasterTables(page, tables)).toEqual([])
})
