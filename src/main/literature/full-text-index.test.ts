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
