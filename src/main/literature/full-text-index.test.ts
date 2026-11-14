import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { literatureIndex } from './full-text-index'
it('composes one index owner per data root and persists independently of application tables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'index-host-'))
  const owner = literatureIndex(root)
  expect(literatureIndex(root)).toBe(owner)
  let db = await owner.open()
  try {
    await db.replace({
      extractionId: 'document',
      documentChecksum: 'a'.repeat(64),
      extractorFingerprint: 'b'.repeat(64),
      chunks: [{ pageStart: 1, pageEnd: 1, textStart: 0, textEnd: 8, content: 'evidence' }]
    })
    await db.close()
    db = await owner.open()
    expect(await db.search({ extractionIds: ['document'], query: 'evidence' })).toEqual([
      expect.objectContaining({ content: 'evidence', pageStart: 1 })
    ])
    await owner.flushPendingAccesses()
  } finally {
    await db.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('does not create a missing index through the cached-only opener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'missing-index-host-'))
  try {
    expect(await literatureIndex(root).openExisting()).toBeUndefined()
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('queries existing evidence read-only without recording accesses or mutating index bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'readonly-index-host-'))
  const owner = literatureIndex(root)
  try {
    const writer = await owner.open()
    await writer.replace({
      extractionId: 'cached-document',
      documentChecksum: 'a'.repeat(64),
      extractorFingerprint: 'b'.repeat(64),
      chunks: [{ pageStart: 2, pageEnd: 2, textStart: 10, textEnd: 18, content: 'evidence' }]
    })
    await writer.close()
    const { readFile } = await import('node:fs/promises')
    const { literatureIndexPath } = await import('./full-text-index')
    const before = await readFile(literatureIndexPath(root))
    const cached = await owner.openExisting()
    expect(cached).toBeDefined()
    try {
      expect(await cached!.findExtraction('a'.repeat(64), 'b'.repeat(64))).toBe('cached-document')
      expect(
        await cached!.search({ extractionIds: ['cached-document'], query: 'evidence' })
      ).toMatchObject([{ pageStart: 2 }])
      await expect(cached!.deleteExtraction('cached-document')).rejects.toThrow('read-only')
    } finally {
      await cached!.close()
    }
    expect(owner.pendingAccesses.size).toBe(0)
    expect(await readFile(literatureIndexPath(root))).toEqual(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
