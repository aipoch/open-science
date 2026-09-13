import { mkdtemp, mkdir, writeFile, rm, symlink, unlink, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
