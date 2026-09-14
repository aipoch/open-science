import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parsePdfStructureResult, type PdfStructureResult } from '../../../shared/pdf-structure'

const { associateAdjacentFigure } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const target = {
  pageNumber: 2,
  width: 600,
  height: 800,
  rotation: 0,
  lines: [],
  invalidGraphicsBounds: 0,
  graphicsBounds: [{ normalizedRect: [0.08, 0.08, 0.9, 0.9] }]
}

it('resolves facing-page legends to the following plate rather than consuming the next spread legend', () => {
  const preceding = {
    page: 1,
    lines: ['Figure 1 (facing page). Results.'],
    rect: [40, 700, 540, 750]
  }
  const following = {
    page: 3,
    lines: ['Figure 2 (facing page). Other results.'],
    rect: [40, 700, 540, 750]
  }
  const source = { ...target, pageNumber: 1, graphicsBounds: [] }
  const next = { ...source, pageNumber: 3 }
  expect(
    associateAdjacentFigure(target, [source, target, next], [preceding, following])[0].caption
  ).toEqual(preceding)
})
const neighbor: typeof target = { ...target, pageNumber: 1, graphicsBounds: [] }
const before = { page: 1, lines: ['Figure 2. Full caption'], rect: [50, 600, 550, 730] }
it('associates an unmatched preceding-page caption while retaining its source coordinates', () => {
  const [result] = associateAdjacentFigure(target, [neighbor, target], [before])
  expect(result.caption).toEqual(before)
  expect(result.rect).toEqual([48, 64, 540, 720])
})
it('supports a caption at the top of the following page', () => {
  const after = { ...before, page: 3, rect: [50, 50, 550, 150] }
  expect(
    associateAdjacentFigure(target, [target, { ...neighbor, pageNumber: 3 }], [after])
  ).toHaveLength(1)
})
it('ignores an arrow-ended continuation rule beneath a following-page caption', () => {
  const after = { ...before, page: 3, rect: [36, 56, 550, 180] }
  const source = {
    ...neighbor,
    pageNumber: 3,
    lines: [{ text: 'The final caption line.', x: 36, y: 174, width: 200, height: 6 }],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [0.055, 0.224, 0.93, 0.244] },
      { kind: 'path', normalizedRect: [0.055, 0.224, 0.075, 0.244] }
    ]
  }
  const [result] = associateAdjacentFigure(target, [target, source], [after])
  expect(result.caption).toEqual(after)
  expect(result.rect).toEqual([48, 64, 540, 720])
})
it('does not turn separated small graphics into a full-page figure using their bounding union', () => {
  const sample = {
    ...target,
    graphicsBounds: [
      { normalizedRect: [0.08, 0.08, 0.25, 0.25] },
      { normalizedRect: [0.75, 0.75, 0.9, 0.9] }
    ]
  }
  expect(associateAdjacentFigure(sample, [neighbor, sample], [before])).toEqual([])
})
it.each(['competing', 'local', 'matched', 'distant', 'prose', 'small', 'rotated'])(
  'refuses uncertain cross-page ownership: %s',
  (kind) => {
    const page = structuredClone(target)
    const source = structuredClone(neighbor)
    const captions = [structuredClone(before)]
    if (kind === 'competing')
      captions.push({ ...before, lines: ['Figure 3. Other'], rect: [50, 740, 550, 780] })
    if (kind === 'local') captions.push({ ...before, page: 2 })
    if (kind === 'matched') source.graphicsBounds = [{ normalizedRect: [0.1, 0.2, 0.9, 0.7] }]
    if (kind === 'distant') {
      source.pageNumber = 4
      captions[0].page = 4
    }
    if (kind === 'small') page.graphicsBounds[0].normalizedRect = [0.1, 0.1, 0.3, 0.3]
    if (kind === 'rotated') source.rotation = 90
    const sample =
      kind === 'prose'
        ? {
            ...page,
            lines: [{ text: 'Paragraph text '.repeat(9), x: 48, y: 740, width: 490, height: 12 }]
          }
        : page
    expect(associateAdjacentFigure(sample, [source, sample], captions)).toEqual([])
  }
)

const result = (): PdfStructureResult => ({
  schemaVersion: 1,
  extractionId: 'test',
  engineFingerprint: 'a'.repeat(64),
  sourceChecksum: 'b'.repeat(64),
  sourceSizeBytes: 100,
  pageCount: 4,
  requestedPages: [2],
  processedPages: [2],
  auxiliaryPages: [1, 3],
  pages: [1, 2, 3].map((page) => ({ page, width: 600, height: 800, rotation: 0 })),
  elements: [
    {
      id: 'figure-2',
      kind: 'figure',
      regions: [{ page: 2, x: 0, y: 0, width: 1, height: 1 }],
      caption: {
        text: 'Caption from page 1',
        regions: [{ page: 1, x: 0.1, y: 0.7, width: 0.8, height: 0.2 }]
      },
      issues: []
    }
  ],
  thumbnails: [],
  navigation: [],
  issues: []
})
it('accepts explicit adjacent provenance and historical results without auxiliary pages', () => {
  const value = result()
  expect(parsePdfStructureResult(value, value)).toEqual(value)
  delete value.auxiliaryPages
  value.pages = value.pages.filter((p) => p.page === 2)
  value.elements[0].caption!.regions[0].page = 2
  expect(parsePdfStructureResult(value, value)).toEqual(value)
})
it('permits a declared distant figure legend but never a distant image or table caption', () => {
  const value = result()
  value.auxiliaryPages = [1, 3, 4]
  value.pages.push({ page: 4, width: 600, height: 800, rotation: 0 })
  value.elements[0].caption!.regions[0].page = 4
  expect(parsePdfStructureResult(value, value)).toEqual(value)
  value.elements[0].regions[0].page = 4
  expect(() => parsePdfStructureResult(value, value)).toThrow()
  value.elements[0].regions[0].page = 2
  value.elements[0].kind = 'table'
  expect(() => parsePdfStructureResult(value, value)).toThrow()
})
it.each([
  'undeclared',
  'distant',
  'duplicate',
  'requested',
  'missing-dimensions',
  'image',
  'cell',
  'note'
])('rejects invalid auxiliary-page use: %s', (kind) => {
  const value = result()
  const region = { page: 1, x: 0, y: 0, width: 1, height: 1 }
  if (kind === 'undeclared') delete value.auxiliaryPages
  if (kind === 'distant') {
    value.auxiliaryPages = [1, 3, 4]
    value.pages.push({ page: 4, width: 600, height: 800, rotation: 0 })
  }
  if (kind === 'duplicate') value.auxiliaryPages = [1, 1, 3]
  if (kind === 'requested') value.auxiliaryPages = [1, 2, 3]
  if (kind === 'missing-dimensions') value.pages.shift()
  if (kind === 'image') value.elements[0].regions = [region]
  if (kind === 'cell' || kind === 'note') {
    value.elements[0].kind = 'table'
    value.elements[0].table = {
      rowCount: 1,
      columnCount: 1,
      cells: [],
      unassignedText: [],
      issues: []
    }
    if (kind === 'cell')
      value.elements[0].table.cells.push({
        row: 0,
        column: 0,
        rowSpan: 1,
        columnSpan: 1,
        text: 'x',
        regions: [region]
      })
    else value.elements[0].table.notes = [{ text: 'Note', regions: [region] }]
  }
  expect(() => parsePdfStructureResult(value, value)).toThrow()
})

it('selects the main legend before supplemental legends on a manuscript legend page', () => {
  const source = {
    ...neighbor,
    lines: [{ text: 'LEGENDS', x: 50, y: 330, width: 100, height: 10, fontSize: 10 }]
  }
  const main = { page: 1, lines: ['FIGURE 1: Main results'], rect: [50, 360, 550, 420] }
  const supplement = {
    page: 1,
    lines: ['SUPPLEMENTARY FIGURE 1: Metabolic pathway'],
    rect: [50, 600, 550, 650]
  }
  expect(associateAdjacentFigure(target, [source, target], [main, supplement])[0]?.caption).toEqual(
    main
  )
  const secondMain = { ...supplement, lines: ['FIGURE 2: Other main results'] }
  expect(associateAdjacentFigure(target, [source, target], [main, secondMain])).toEqual([])
})
