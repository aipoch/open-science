import { mkdtemp, mkdir, writeFile, rm, symlink, unlink, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PdfStructureCache } from './cache'
import { readWorkerResult } from './worker-result'
import type { PdfStructureIdentity } from './result'

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
const { inspectScratch } = await import(
  pathToFileURL(resolve('resources/pdf-structure/scratch.mjs')).href
)
const raw = (): Record<string, unknown> => ({
  sourceSha256: identity.sourceChecksum,
  pageCount: 1,
  requestedPages: [1],
  processedPages: [1],
  pages: [{ page: 1, width: 600, height: 800, rotation: 0 }],
  figures: [
    {
      id: 'p1-figure-1',
      page: 1,
      region: [0.1, 0.1, 0.5, 0.5],
      thumbnail: 'thumbnails/p1-figure-1.png',
      caption: { text: 'Full caption\nsecond line', rect: [60, 400, 300, 480] }
    }
  ],
  tables: [],
  navigation: { entries: [] }
})
let root: string
const save = async (value: unknown): Promise<void> => {
  await writeFile(join(root, 'structure.json'), JSON.stringify(value))
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pdf-worker-result-'))
  await mkdir(join(root, 'thumbnails'))
  await writeFile(join(root, 'thumbnails/p1-figure-1.png'), png)
  await save(raw())
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
describe('worker result boundary', () => {
  it('persists one parent table with independent part grids and shared notes', async () => {
    const parts = [5, 7].map((columns, index) => ({
      title: index ? 'B. Dewa data' : 'A. Tricco data',
      sourceViewport: { width: 900, height: 1200 },
      grid: [Array<string>(columns).fill('Value')],
      cells: Array.from({ length: columns }, (_, column) => ({
        row: 0,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: 'Value',
        sourceRects: [[90, 120, 100, 130]]
      })),
      unassigned: [],
      issues: ['candidate-results']
    }))
    const group = {
      id: 'p1-figure-1',
      page: 1,
      region: [0.1, 0.1, 0.8, 0.9],
      thumbnail: 'thumbnails/p1-figure-1.png',
      caption: { text: 'Table 1. Sample data.', rect: [60, 80, 300, 90] },
      notes: [{ text: 'Shared note', rect: [60, 700, 300, 710] }],
      parts
    }
    await save({ ...raw(), figures: [], tables: [group] })
    const images = new Map<string, Uint8Array>()
    const result = await readWorkerResult(root, identity, images)
    expect(result.elements).toHaveLength(1)
    expect(result.elements[0].table).toBeUndefined()
    expect(
      result.elements[0].tableParts?.map((part) => [part.title, part.table.columnCount])
    ).toEqual([
      ['A. Tricco data', 5],
      ['B. Dewa data', 7]
    ])
    expect(result.elements[0].tableNotes?.[0].text).toBe('Shared note')
    expect(result.thumbnails).toHaveLength(1)
    const cache = new PdfStructureCache({ dataRoot: () => join(root, 'cache') })
    await mkdir(join(root, 'cache'))
    await cache.publish(result, images, new AbortController().signal)
    await expect(cache.read(identity)).resolves.toEqual(result)
    await save({ ...raw(), figures: [], tables: [{ ...group, caption: undefined }] })
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow()
    await save({
      ...raw(),
      figures: [],
      tables: [{ ...group, parts: [{ ...parts[0], grid: [] }, parts[1]] }]
    })
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow()
  })
  it('accounts for and cleans algorithm thumbnails while retaining unexpected scratch files', async () => {
    const originalBytes = await inspectScratch(root)
    await writeFile(join(root, 'thumbnails/p1-algorithm-1.png'), png)
    expect(await inspectScratch(root)).toBe(originalBytes + png.length)
    await writeFile(join(root, 'thumbnails/unowned.png'), png)
    await expect(inspectScratch(root)).rejects.toThrow('Unexpected PDF scratch')
    await unlink(join(root, 'thumbnails/unowned.png'))
    expect(await inspectScratch(root, true)).toBe(originalBytes + png.length)
    expect(await inspectScratch(root)).toBe(0)
  })
  it('persists algorithms as image regions without manufacturing table cells', async () => {
    await save({
      ...raw(),
      figures: [],
      algorithms: [
        {
          id: 'p1-figure-1',
          page: 1,
          region: [0.1, 0.1, 0.5, 0.5],
          thumbnail: 'thumbnails/p1-figure-1.png',
          caption: { text: 'Algorithm 1 Search', rect: [60, 80, 300, 90] }
        }
      ]
    })
    const images = new Map<string, Uint8Array>()
    const result = await readWorkerResult(root, identity, images)
    expect(result.elements[0].kind).toBe('algorithm')
    expect(result.elements[0].table).toBeUndefined()
    expect(result.elements[0].caption?.text).toBe('Algorithm 1 Search')
    const cache = new PdfStructureCache({ dataRoot: () => join(root, 'cache') })
    await mkdir(join(root, 'cache'))
    await cache.publish(result, images, new AbortController().signal)
    await expect(cache.read(identity)).resolves.toEqual(result)
    await expect(
      cache.readThumbnail(identity, identity.extractionId, 'p1-figure-1')
    ).resolves.toEqual(png)
  })
  it('normalizes an adjacent caption using its own page and preserves provenance through cache', async () => {
    const value = raw()
    await save({
      ...value,
      pageCount: 2,
      auxiliaryPages: [2],
      pages: [
        { page: 1, width: 600, height: 800, rotation: 0 },
        { page: 2, width: 300, height: 400, rotation: 0 }
      ],
      figures: [
        {
          id: 'p1-figure-1',
          page: 1,
          region: [0.1, 0.1, 0.5, 0.5],
          thumbnail: 'thumbnails/p1-figure-1.png',
          caption: { text: 'Following page caption', page: 2, rect: [30, 40, 270, 80] }
        }
      ]
    })
    const images = new Map<string, Uint8Array>()
    const result = await readWorkerResult(root, identity, images)
    expect(result.processedPages).toEqual([1])
    expect(result.auxiliaryPages).toEqual([2])
    expect(result.elements[0].caption?.regions[0]).toMatchObject({
      page: 2,
      x: 0.1,
      y: 0.1,
      width: 0.8,
      height: 0.1
    })
    const cache = new PdfStructureCache({ dataRoot: () => join(root, 'cache') })
    await mkdir(join(root, 'cache'))
    await cache.publish(result, images, new AbortController().signal)
    await expect(cache.read(identity)).resolves.toEqual(result)
  })
  it('rejects a caption whose declared page has no geometry', async () => {
    await save({
      ...raw(),
      pageCount: 2,
      figures: [
        {
          id: 'p1-figure-1',
          page: 1,
          region: [0.1, 0.1, 0.5, 0.5],
          thumbnail: 'thumbnails/p1-figure-1.png',
          caption: { text: 'Missing source', page: 2, rect: [30, 40, 270, 80] }
        }
      ]
    })
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow('caption page')
  })
  it('publishes and reopens high-resolution crops without changing image bytes or source regions', async () => {
    const image = await sharp({
      create: { width: 2400, height: 1800, channels: 3, background: '#fff' }
    })
      .png()
      .toBuffer()
    await writeFile(join(root, 'thumbnails/p1-figure-1.png'), image)
    const images = new Map<string, Uint8Array>()
    const result = await readWorkerResult(root, identity, images)
    expect(result.thumbnails[0]).toMatchObject({ width: 2400, height: 1800 })
    const cache = new PdfStructureCache({ dataRoot: () => join(root, 'cache') })
    await mkdir(join(root, 'cache'))
    await cache.publish(result, images, new AbortController().signal)
    await expect(cache.read(identity)).resolves.toEqual(result)
    await expect(
      cache.readThumbnail(identity, identity.extractionId, 'p1-figure-1')
    ).resolves.toEqual(image)
  })
  it.each([
    [2401, 1],
    [2400, 2401]
  ])('rejects crops beyond the edge or pixel budget (%i × %i)', async (width, height) => {
    const image = await sharp({
      create: { width, height, channels: 3, background: '#fff' }
    })
      .png()
      .toBuffer()
    await writeFile(join(root, 'thumbnails/p1-figure-1.png'), image)
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow()
  })
  it('accepts a bounded page result from a document longer than 100 pages', async () => {
    await save({ ...raw(), pageCount: 101 })
    expect((await readWorkerResult(root, identity, new Map())).pageCount).toBe(101)
  })
  it('preserves separate notes and their page regions while accepting historical tables without notes', async () => {
    const table = {
      id: 'p1-figure-1',
      page: 1,
      region: [0.1, 0.1, 0.5, 0.5],
      thumbnail: 'thumbnails/p1-figure-1.png',
      sourceViewport: { width: 900, height: 1200 },
      grid: [['Value']],
      cells: [
        {
          row: 0,
          column: 0,
          rowSpan: 1,
          colSpan: 1,
          text: 'Value',
          sourceRects: [[90, 120, 450, 600]]
        }
      ],
      unassigned: [],
      issues: []
    }
    await save({ ...raw(), figures: [], tables: [table] })
    expect(
      (await readWorkerResult(root, identity, new Map())).elements[0].table?.notes
    ).toBeUndefined()
    await save({
      ...raw(),
      figures: [],
      tables: [{ ...table, notes: [{ text: '* Original note.', rect: [60, 410, 300, 430] }] }]
    })
    const notes = (await readWorkerResult(root, identity, new Map())).elements[0].table?.notes
    expect(notes?.[0].text).toBe('* Original note.')
    expect(notes?.[0].regions[0]).toMatchObject({ page: 1, x: 0.1, y: 410 / 800, width: 0.4 })
    const textRuns = [
      { text: 'Value', position: 'normal' },
      { text: '*', position: 'superscript' }
    ]
    await save({
      ...raw(),
      figures: [],
      tables: [
        { ...table, grid: [['Value*']], cells: [{ ...table.cells[0], text: 'Value*', textRuns }] }
      ]
    })
    expect(
      (await readWorkerResult(root, identity, new Map())).elements[0].table?.cells[0].textRuns
    ).toEqual(textRuns)
    await save({
      ...raw(),
      figures: [],
      tables: [{ ...table, cells: [{ ...table.cells[0], textRuns }] }]
    })
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow()
  })
  it('preserves full captions, normalized crop bounds and exact image bytes', async () => {
    const images = new Map<string, Uint8Array>()
    const result = await readWorkerResult(root, identity, images)
    expect(result.elements[0].caption?.text).toBe('Full caption\nsecond line')
    expect(result.elements[0].regions[0]).toEqual({
      page: 1,
      x: 0.1,
      y: 0.1,
      width: 0.4,
      height: 0.4
    })
    expect(images.get('p1-figure-1')).toEqual(png)
    expect(result.issues[0].code).toBe('candidate-results')
  })
  it('rejects manifest and thumbnail-directory links before reading contents', async () => {
    const outside = join(root, 'outside.json')
    await writeFile(outside, 'this would fail JSON decoding')
    await unlink(join(root, 'structure.json'))
    await symlink(outside, join(root, 'structure.json'))
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow(
      'Unsafe PDF output manifest'
    )
    await unlink(join(root, 'structure.json'))
    await save(raw())
    await rm(join(root, 'thumbnails'), { recursive: true })
    await mkdir(join(root, 'outside'))
    await symlink(
      join(root, 'outside'),
      join(root, 'thumbnails'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow(
      'Unsafe PDF output directory'
    )
  })
  it('rejects excessive JSON and changed coverage before image decoding', async () => {
    await save({ ...raw(), ignored: Array(9000).fill(0) })
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow('decoding budget')
    await save({ ...raw(), processedPages: [2] })
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow('coverage mismatch')
    await save(raw())
    await truncate(join(root, 'thumbnails/p1-figure-1.png'), 5 * 1024 ** 2)
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow('decoding budget')
  })
})
