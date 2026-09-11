import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { SessionReproducibilityStore } from './session-reproducibility-store'
import { SessionReproducibilityBatches } from './session-reproducibility'
import type { SessionReproducibilityBatch } from '../../shared/session-reproducibility'

it('recovers fixed versions and completed rows without automatically resuming interrupted checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-check-store-'))
  try {
    const store = new SessionReproducibilityStore(root)
    const batch: SessionReproducibilityBatch = {
      batchId: 'batch',
      projectId: 'p',
      appSessionId: 's',
      status: 'running',
      createdAt: new Date().toISOString(),
      targets: [
        { artifactId: 'a', versionId: 'v', name: 'x.csv', status: 'matched' },
        { artifactId: 'b', versionId: 'v2', name: 'y.csv', status: 'running' }
      ]
    }
    await store.save(batch)
    const batches = new SessionReproducibilityBatches({
      store,
      preflight: async () => {
        throw new Error('must not preflight')
      },
      run: async () => {
        throw new Error('must not run')
      },
      cancel: () => {}
    })
    const restored = await batches.command({ action: 'get', projectId: 'p', appSessionId: 's' }, 99)
    expect(restored).toMatchObject({
      status: 'cancelled',
      targets: [
        { versionId: 'v', status: 'matched' },
        { versionId: 'v2', status: 'cancelled' }
      ]
    })
    await expect(
      batches.command({ action: 'start', projectId: 'p', appSessionId: 's', batchId: 'batch' }, 99)
    ).rejects.toThrow('Prepare')
    const file = join(root, 'artifacts/p/s/.reproducibility/latest.json')
    await writeFile(file, JSON.stringify({ schemaVersion: 1, state: batch, checksum: 'corrupt' }))
    await expect(store.load(batch)).rejects.toThrow()
    await expect(store.load({ projectId: '../escape', appSessionId: 's' })).rejects.toThrow()
    await rm(file)
    const outside = join(root, 'outside.json')
    await writeFile(outside, '{}')
    await symlink(outside, file)
    await expect(store.save(batch)).rejects.toThrow('Invalid Session check file')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
