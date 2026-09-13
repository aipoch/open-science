import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultFileDurability } from '../../storage/file-durability'
import { PdfStructureCache } from './cache'
import type { PdfStructureResult } from './result'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
  'base64'
)
const hash = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')
const result = (extractionId = 'one', page = 1): PdfStructureResult => ({
  schemaVersion: 1,
  extractionId,
  engineFingerprint: 'b'.repeat(64),
  sourceChecksum: 'c'.repeat(64),
  sourceSizeBytes: 100,
  pageCount: 10,
  requestedPages: [page],
  processedPages: [page],
  pages: [{ page, width: 600, height: 800, rotation: 0 }],
  elements: [
    {
      id: 'figure-1',
      kind: 'figure',
      thumbnailId: 'image-1',
      regions: [{ page, x: 0, y: 0, width: 0.5, height: 0.5 }],
      caption: {
        text: 'Figure 1. Original caption.',
        regions: [{ page, x: 0, y: 0.5, width: 0.5, height: 0.1 }]
      },
      issues: []
    }
  ],
  thumbnails: [
    {
      id: 'image-1',
      mimeType: 'image/png',
      width: 1,
      height: 1,
      sizeBytes: png.length,
      sha256: hash(png)
    }
  ],
  navigation: [],
  issues: []
})
const images = (): Map<string, Uint8Array> => new Map([['image-1', Buffer.from(png)]])
const entryPath = (root: string, entry: PdfStructureResult): string =>
  join(
    root,
    'pdf-structure',
    'v1',
    'entries',
    entry.engineFingerprint,
    entry.sourceChecksum,
    hash(JSON.stringify(entry.requestedPages))
  )
const bytes = (entry: PdfStructureResult): number =>
  Buffer.byteLength(JSON.stringify(entry)) + png.length
const signal = (): AbortSignal => new AbortController().signal
let root: string
let cache: PdfStructureCache
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pdf-structure-cache-'))
  cache = new PdfStructureCache({ dataRoot: () => root })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('PDF structure result cache', () => {
  it.each([false, true])(
    'reopens table notes without migration (notes present: %s)',
    async (withNotes) => {
      const original = result()
      original.elements[0].kind = 'table'
      original.elements[0].table = {
        rowCount: 1,
        columnCount: 1,
        cells: [{ row: 0, column: 0, rowSpan: 1, columnSpan: 1, text: 'Value', regions: [] }],
        unassignedText: [],
        issues: [],
        ...(withNotes
          ? {
              notes: [
                {
                  text: '* Original note.',
                  regions: [{ page: 1, x: 0, y: 0.6, width: 0.5, height: 0.1 }]
                }
              ]
            }
          : {})
      }
      await cache.publish(original, images(), signal())
      cache = new PdfStructureCache({ dataRoot: () => root })
      expect(await cache.read(original)).toEqual(original)
    }
  )
  it('publishes complete JSON and thumbnails, reopens without a DB and reads exact references', async () => {
    const original = result()
    await expect(cache.read(original)).resolves.toBeUndefined()
    await cache.publish(original, images(), signal())
    cache = new PdfStructureCache({ dataRoot: () => root })
    await expect(cache.read(original)).resolves.toEqual(original)
    await expect(cache.readThumbnail(original, 'one', 'image-1')).resolves.toEqual(png)
    await expect(
      cache.readThumbnail(original, 'another-extraction', 'image-1')
    ).resolves.toBeUndefined()
    await expect(cache.readThumbnail(original, 'one', '../outside')).resolves.toBeUndefined()
    expect(await readdir(join(root, 'pdf-structure', 'v1', 'staging'))).toEqual([])
  })

  it('reuses a valid immutable entry without replacing its extraction identity', async () => {
    const original = result()
    await cache.publish(original, images(), signal())
    const next = result('two')
    await expect(cache.publish(next, images(), signal())).resolves.toEqual(original)
    await expect(cache.read(original)).resolves.toEqual(original)
  })

  it.each(['missing', 'checksum'] as const)(
    'retires a recognized entry with %s thumbnail data before rebuilding',
    async (kind) => {
      const original = result()
      await cache.publish(original, images(), signal())
      const imagePath = join(entryPath(root, original), 'thumbnails', 'image-1.png')
      if (kind === 'missing') await rm(imagePath)
      else await writeFile(imagePath, Buffer.alloc(png.length))
      await expect(cache.read(original)).resolves.toBeUndefined()
      expect(await readdir(join(root, 'pdf-structure', 'v1', 'retired'))).toHaveLength(1)
      const replacement = result('two')
      await expect(cache.publish(replacement, images(), signal())).resolves.toEqual(replacement)
      expect(await readdir(join(root, 'pdf-structure', 'v1', 'retired'))).toEqual([])
      await expect(cache.readThumbnail(original, 'one', 'image-1')).resolves.toBeUndefined()
      await expect(cache.readThumbnail(replacement, 'two', 'image-1')).resolves.toEqual(png)
    }
  )

  it.each(['json', 'newer', 'extra'] as const)(
    'preserves %s ownership barriers while clearing other recognized entries',
    async (kind) => {
      const original = result()
      const other = result('two', 2)
      await cache.publish(original, images(), signal())
      await cache.publish(other, images(), signal())
      const directory = entryPath(root, original)
      const manifest = join(directory, 'structure.json')
      if (kind === 'json') await writeFile(manifest, '{broken')
      if (kind === 'newer')
        await writeFile(manifest, JSON.stringify({ ...original, schemaVersion: 2 }))
      if (kind === 'extra') await writeFile(join(directory, 'keep.txt'), 'user file')
      const before = await readFile(manifest)
      await expect(cache.read(original)).rejects.toThrow()
      const cleared = await cache.clear()
      expect(cleared.removedBytes).toBe(bytes(other))
      expect(cleared.retained).toHaveLength(1)
      expect(await readFile(manifest)).toEqual(before)
      expect(await readFile(join(directory, 'thumbnails', 'image-1.png'))).toEqual(png)
      await expect(cache.publish(result('new', 3), images(), signal())).rejects.toThrow(
        'repair is required'
      )
    }
  )

  it('evicts the least recently read entry at capacity and counts JSON plus images', async () => {
    const one = result('one', 1)
    const two = result('two', 2)
    const three = result('tri', 3)
    cache = new PdfStructureCache({ dataRoot: () => root, maxBytes: bytes(one) + bytes(two) })
    await cache.publish(one, images(), signal())
    await cache.publish(two, images(), signal())
    await utimes(entryPath(root, one), new Date(1000), new Date(1000))
    await utimes(entryPath(root, two), new Date(2000), new Date(2000))
    await cache.read(one)
    await cache.publish(three, images(), signal())
    await expect(cache.read(one)).resolves.toEqual(one)
    await expect(cache.read(two)).resolves.toBeUndefined()
    await expect(cache.read(three)).resolves.toEqual(three)
    await expect(cache.clear()).resolves.toEqual({
      removedBytes: bytes(one) + bytes(three),
      retained: []
    })
    await expect(cache.clear()).resolves.toEqual({ removedBytes: 0, retained: [] })
  })

  it('rejects an undecodable PNG even when its header, size and checksum agree', async () => {
    const original = result()
    const truncated = png.subarray(0, 33)
    original.thumbnails[0].sizeBytes = truncated.length
    original.thumbnails[0].sha256 = hash(truncated)
    await expect(
      cache.publish(original, new Map([['image-1', truncated]]), signal())
    ).rejects.toThrow('thumbnail bytes')
    const valid = result()
    await cache.publish(valid, images(), signal())
    await writeFile(join(entryPath(root, valid), 'structure.json'), JSON.stringify(original))
    await writeFile(join(entryPath(root, valid), 'thumbnails', 'image-1.png'), truncated)
    await expect(cache.readThumbnail(valid, 'one', 'image-1')).resolves.toBeUndefined()
    await expect(cache.read(valid)).resolves.toBeUndefined()
    await expect(cache.clear()).resolves.toMatchObject({ retained: [] })
  })

  it('reclaims empty hash parents during eviction and clear without removing siblings', async () => {
    const one = result('one')
    const two = { ...result('two'), sourceChecksum: 'd'.repeat(64) }
    const three = { ...result('tri'), engineFingerprint: 'e'.repeat(64) }
    cache = new PdfStructureCache({ dataRoot: () => root, maxBytes: bytes(one) + bytes(two) })
    await cache.publish(one, images(), signal())
    await cache.publish(two, images(), signal())
    await utimes(entryPath(root, one), new Date(1000), new Date(1000))
    await utimes(entryPath(root, two), new Date(2000), new Date(2000))
    await cache.publish(three, images(), signal())
    const entries = join(root, 'pdf-structure', 'v1', 'entries')
    expect(await readdir(join(entries, one.engineFingerprint))).toEqual([two.sourceChecksum])
    await expect(cache.read(two)).resolves.toEqual(two)
    await cache.clear()
    expect(await readdir(entries)).toEqual([])
    const unknown = join(entries, one.engineFingerprint, one.sourceChecksum)
    await mkdir(unknown, { recursive: true })
    await writeFile(join(unknown, 'keep.txt'), 'user file')
    const cleared = await cache.clear()
    expect(cleared.retained).toHaveLength(1)
    expect(await readFile(join(unknown, 'keep.txt'), 'utf8')).toBe('user file')
  })

  it('rejects an oversized single entry before evicting existing results', async () => {
    const one = result()
    cache = new PdfStructureCache({ dataRoot: () => root, maxBytes: bytes(one) })
    await cache.publish(one, images(), signal())
    const oversized = result('oversized', 2)
    await expect(cache.publish(oversized, images(), signal())).rejects.toThrow('capacity')
    await expect(cache.read(one)).resolves.toEqual(one)
  })

  it.each(['hash', 'inventory', 'dimensions', 'png', 'identifier'] as const)(
    'rejects invalid %s before writing',
    async (kind) => {
      const original = result()
      const data = images()
      if (kind === 'hash') data.set('image-1', Buffer.alloc(png.length))
      if (kind === 'inventory') data.set('unreferenced', png)
      if (kind === 'dimensions') original.thumbnails[0].width = 1201
      if (kind === 'png') {
        data.set('image-1', Buffer.alloc(png.length))
        original.thumbnails[0].sha256 = hash(data.get('image-1')!)
      }
      if (kind === 'identifier') {
        original.thumbnails[0].id = '../image'
        original.elements[0].thumbnailId = '../image'
      }
      await expect(cache.publish(original, data, signal())).rejects.toThrow()
      expect(await readdir(root)).toEqual([])
    }
  )

  it('does not follow a linked cache parent', async () => {
    const outside = join(root, 'unrelated')
    await mkdir(outside)
    await writeFile(join(outside, 'keep'), 'outside')
    await symlink(outside, join(root, 'pdf-structure'), 'junction')
    await expect(cache.publish(result(), images(), signal())).rejects.toThrow(
      'Unsafe PDF cache directory'
    )
    await expect(cache.read(result())).rejects.toThrow('Unsafe PDF cache directory')
    expect(await readdir(outside)).toEqual(['keep'])
  })

  it('serializes clear behind publication and exposes no partially published result', async () => {
    let continueSync!: () => void
    const gate = new Promise<void>((resolve) => {
      continueSync = resolve
    })
    let syncing = false
    const syncFile = defaultFileDurability.syncFile
    vi.spyOn(defaultFileDurability, 'syncFile').mockImplementationOnce(async (path) => {
      syncing = true
      await gate
      await syncFile(path)
    })
    const original = result()
    const publication = cache.publish(original, images(), signal())
    await vi.waitFor(() => expect(syncing).toBe(true))
    let cleared = false
    const clear = cache.clear().then((report) => {
      cleared = true
      return report
    })
    try {
      await expect(
        readFile(join(entryPath(root, original), 'structure.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(cleared).toBe(false)
    } finally {
      continueSync()
    }
    await publication
    await expect(clear).resolves.toEqual({ removedBytes: bytes(original), retained: [] })
    await expect(cache.read(original)).resolves.toBeUndefined()
  })

  it('cancels before atomic publication and removes only its known staging inventory', async () => {
    const controller = new AbortController()
    const syncDirectory = defaultFileDurability.syncDirectory
    vi.spyOn(defaultFileDurability, 'syncDirectory').mockImplementation(async (path) => {
      await syncDirectory(path)
      if (path.includes('publish-') && !path.endsWith('thumbnails')) controller.abort()
    })
    await expect(cache.publish(result(), images(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    await expect(cache.read(result())).resolves.toBeUndefined()
    expect(await readdir(join(root, 'pdf-structure', 'v1', 'staging'))).toEqual([])
  })

  it('retains uncertain staging and reports it instead of claiming a complete clear', async () => {
    const staging = join(root, 'pdf-structure', 'v1', 'staging', 'job-unknown')
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'input.pdf'), 'original')
    const report = await cache.clear()
    expect(report.removedBytes).toBe(0)
    expect(report.retained).toHaveLength(1)
    expect(await readFile(join(staging, 'input.pdf'), 'utf8')).toBe('original')
  })
})
