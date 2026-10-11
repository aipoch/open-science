import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PdfStructureCache } from './cache'
import { type PdfStructureIdentity } from '@aipoch/pdf-structure/result'
import { readWorkerResult } from '@aipoch/pdf-structure'

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
describe('worker result cache integration', () => {
  it('round trips grouped tables, shared notes and provenance through the host cache', async () => {
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
    const cache = new PdfStructureCache({ dataRoot: () => join(root, 'cache') })
    await mkdir(join(root, 'cache'))
    await cache.publish(result, images, new AbortController().signal)
    await expect(cache.read(identity)).resolves.toEqual(result)
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
})
