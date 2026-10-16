import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { afterEach, expect, it } from 'vitest'
import { parsePdfStructureResult, type PdfStructureIdentity } from '../src/result.js'
import { readWorkerResult } from '../src/worker-result.js'
const { serializeWorkerResult } = await import(pathToFileURL(resolve('resources/scratch.mjs')).href)

const identity: PdfStructureIdentity = {
  extractionId: '00000000-0000-4000-8000-000000000001',
  engineFingerprint: 'b'.repeat(64),
  sourceChecksum: 'c'.repeat(64),
  sourceSizeBytes: 100,
  requestedPages: [1]
}
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
  'base64'
)
const rawFixture = {
  sourceSha256: identity.sourceChecksum,
  pageCount: 1,
  requestedPages: [1],
  processedPages: [1],
  pages: [{ page: 1, width: 100, height: 100, rotation: 0 }],
  figures: [],
  tables: [
    {
      id: 'table-1',
      page: 1,
      region: [0.1, 0.1, 0.9, 0.9],
      thumbnail: 'thumbnails/table-1.png',
      sourceViewport: { width: 100, height: 100 },
      grid: [['0.20', '0.20']],
      cells: [0, 1].map((column) => ({
        row: 0,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: '0.20',
        sourceRects: [[10 + column * 30, 10, 30 + column * 30, 20]],
        sourceSegments: [
          {
            pageNumber: 1,
            index: 3,
            text: '0.20 0.20',
            start: column * 5,
            end: column * 5 + 4,
            rect: [10 + column * 30, 10, 30 + column * 30, 20]
          }
        ]
      })),
      unassigned: [],
      issues: []
    }
  ],
  navigation: { entries: [] }
}
const raw = (): typeof rawFixture => structuredClone(rawFixture)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const read = async (value: unknown): ReturnType<typeof readWorkerResult> => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-source-segments-'))
  roots.push(root)
  await mkdir(join(root, 'thumbnails'))
  await writeFile(join(root, 'thumbnails/table-1.png'), png)
  await writeFile(join(root, 'structure.json'), JSON.stringify(value))
  return readWorkerResult(root, identity, new Map())
}

it('preserves measured offsets for repeated native text and separated regions through worker and cache decoding', async () => {
  const result = await read(raw())
  expect(result.elements[0].table!.cells).toMatchObject([
    {
      sourceSegments: [
        {
          pageNumber: 1,
          index: 3,
          text: '0.20 0.20',
          start: 0,
          end: 4,
          region: { page: 1, x: 0.1, y: 0.1, width: 0.19999999999999998, height: 0.1 }
        }
      ]
    },
    { sourceSegments: [{ pageNumber: 1, index: 3, text: '0.20 0.20', start: 5, end: 9 }] }
  ])
  expect(parsePdfStructureResult(result, identity)).toEqual(result)
})

it('rejects a whole native owner competing with a segment in another cell', async () => {
  const result = await read(raw()),
    cells = result.elements[0].table!.cells
  delete cells[1].sourceSegments
  cells[1].sourceItems = [{ pageNumber: 1, index: 3, text: '0.20 0.20' }]
  expect(() => parsePdfStructureResult(result, identity)).toThrow()
})

it.each([
  { start: -1 },
  { start: 0.5 },
  { end: 10 },
  { end: 0 },
  { start: 4, end: 4 },
  { index: Number.MAX_SAFE_INTEGER + 1 },
  { index: -1 },
  { pageNumber: 2 },
  { text: 'x'.repeat(9) },
  { start: 4, end: 5 },
  { text: '😀 0.20', start: 1, end: 2 },
  { text: '😀 0.20', start: 0, end: 1 },
  { opaque: true }
])('rejects invalid segment fields at worker and cache boundaries: %j', async (patch) => {
  const value = raw(),
    result = await read(raw())
  Object.assign(value.tables[0].cells[0].sourceSegments[0], patch)
  Object.assign(result.elements[0].table!.cells[0].sourceSegments![0], patch)
  await expect(read(value)).rejects.toThrow()
  expect(() => parsePdfStructureResult(result, identity)).toThrow()
})

it.each([
  'overlap',
  'duplicate',
  'unsorted',
  'mixed',
  'extra-region',
  'missing-region',
  'wrong-region',
  'empty'
] as const)('rejects %s segment ownership at both boundaries', async (kind) => {
  const value = raw(),
    table = value.tables[0]
  const result = await read(raw()),
    cells = result.elements[0].table!.cells
  if (kind === 'overlap') {
    table.cells[1].sourceSegments[0].start = 3
    cells[1].sourceSegments![0].start = 3
  } else if (kind === 'duplicate' || kind === 'unsorted') {
    table.cells[0].sourceSegments.push(
      structuredClone(table.cells[kind === 'duplicate' ? 0 : 1].sourceSegments[0])
    )
    table.cells[0].sourceRects.push(
      structuredClone(table.cells[kind === 'duplicate' ? 0 : 1].sourceRects[0])
    )
    cells[0].sourceSegments!.push(
      structuredClone(cells[kind === 'duplicate' ? 0 : 1].sourceSegments![0])
    )
    cells[0].regions.push(structuredClone(cells[kind === 'duplicate' ? 0 : 1].regions[0]))
    if (kind === 'unsorted') {
      table.cells[0].sourceSegments.reverse()
      cells[0].sourceSegments!.reverse()
    }
  } else if (kind === 'mixed') {
    const origins = [{ pageNumber: 1, index: 3, text: '0.20 0.20' }]
    Object.assign(table.cells[0], { sourceItems: origins })
    cells[0].sourceItems = origins
  } else if (kind === 'extra-region') {
    table.cells[0].sourceRects.push([70, 10, 80, 20])
    cells[0].regions.push({ page: 1, x: 0.7, y: 0.1, width: 0.1, height: 0.1 })
  } else if (kind === 'missing-region') {
    table.cells[0].sourceRects = []
    cells[0].regions = []
  } else if (kind === 'wrong-region') {
    table.cells[0].sourceSegments[0].rect[0] += 1
    cells[0].sourceSegments![0].region.x += 0.01
  } else {
    table.cells[0].sourceSegments = []
    cells[0].sourceSegments = []
  }
  await expect(read(value)).rejects.toThrow()
  expect(() => parsePdfStructureResult(result, identity)).toThrow()
})

it('accepts several ordered pieces of one native item in the same cell without filling their physical gap', async () => {
  const value = raw(),
    table = value.tables[0]
  table.cells[0].sourceSegments.push(table.cells[1].sourceSegments[0])
  table.cells[0].sourceRects.push(table.cells[1].sourceRects[0])
  table.cells[0].text = '0.20 0.20'
  table.cells.pop()
  const result = await read(value)
  expect(result.elements[0].table!.cells[0].sourceSegments).toHaveLength(2)
  expect(result.elements[0].table!.cells[0].regions).toHaveLength(2)
  expect(parsePdfStructureResult(result, identity)).toEqual(result)
})

it('strips both optional ownership protocols together before writing an oversized manifest', () => {
  const value = raw()
  Object.assign(value.tables[0].cells[1], {
    sourceItems: [{ pageNumber: 1, index: 4, text: 'whole' }]
  })
  value.tables[0].cells[0].sourceSegments[0].text = '中'.repeat(3 * 1024 ** 2)
  const serialized = serializeWorkerResult(value)
  expect(serialized.includes('sourceSegments')).toBe(false)
  expect(serialized.includes('sourceItems')).toBe(false)
})

it.each(['nodes', 'text'] as const)(
  'drops both optional source kinds on the %s decoding budget without relaxing content limits',
  async (kind) => {
    const value = raw(),
      table = value.tables[0]
    table.cells[0].sourceSegments = Array.from(
      { length: kind === 'nodes' ? 3000 : 12 },
      (_, index) => ({
        pageNumber: 1,
        index: index + 10,
        text: kind === 'nodes' ? 'x' : 'x'.repeat(190000),
        start: 0,
        end: 1,
        rect: [10, 10, 20, 20]
      })
    )
    Reflect.deleteProperty(table.cells[1], 'sourceSegments')
    Object.assign(table.cells[1], { sourceItems: [{ pageNumber: 1, index: 4, text: 'whole' }] })
    const result = await read(value)
    expect(
      result.elements[0].table!.cells.every((cell) => !cell.sourceSegments && !cell.sourceItems)
    ).toBe(true)
    table.cells[1].text = 'x'.repeat(262145)
    await expect(read(value)).rejects.toThrow('budget')
  }
)

it.each([
  [-1, 10, 30, 20],
  [10, 10, 101, 20],
  [10, 10, 10, 20],
  [10, 20, 30, 10]
])('rejects invalid raw measured geometry without clamping it: %j', async (...rect) => {
  const value = raw()
  value.tables[0].cells[0].sourceSegments[0].rect = rect
  await expect(read(value)).rejects.toThrow()
})

it('rejects mismatching segment and region pages independently of cell page coverage', async () => {
  const result = await read(raw())
  result.elements[0].table!.cells[0].sourceSegments![0].region.page = 2
  expect(() => parsePdfStructureResult(result, identity)).toThrow()
})

it('accepts a complete astral character using UTF-16 offsets', async () => {
  const value = raw()
  for (const [index, cell] of value.tables[0].cells.entries()) {
    Object.assign(cell.sourceSegments[0], {
      text: '😀 x',
      start: index ? 3 : 0,
      end: index ? 4 : 2
    })
    cell.text = index ? 'x' : '😀'
  }
  const result = await read(value)
  expect(result.elements[0].table!.cells[0].sourceSegments![0].end).toBe(2)
  expect(parsePdfStructureResult(result, identity)).toEqual(result)
})

it('keeps legacy results without ownership evidence readable', async () => {
  const value = raw()
  for (const cell of value.tables[0].cells) Reflect.deleteProperty(cell, 'sourceSegments')
  const result = await read(value)
  expect(result.elements[0].table!.cells.every((cell) => !cell.sourceSegments)).toBe(true)
  expect(parsePdfStructureResult(result, identity)).toEqual(result)
})
