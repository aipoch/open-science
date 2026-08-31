import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deleteSources } from './data-migration'
import { DataRootCleanupJournal } from './data-root-cleanup'
import { readMigrationMarker, scanInventory, writeMigrationMarker } from './migration-marker'

let root: string
let configRoot: string
let source: string
let target: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'data-root-cleanup-'))
  configRoot = join(root, 'config')
  source = join(root, 'old-root')
  target = join(root, 'new-root')
  await mkdir(join(source, 'artifacts'), { recursive: true })
  await mkdir(join(target, 'artifacts'), { recursive: true })
  await writeFile(join(source, 'artifacts', 'result.txt'), 'preserved')
  await writeFile(join(target, 'artifacts', 'result.txt'), 'preserved')
  await writeMigrationMarker(target, {
    version: 1,
    token: 'cleanup-token',
    source,
    target,
    createdAt: 1,
    status: 'verified',
    migratedDirs: ['artifacts'],
    inventory: await scanInventory(target, ['artifacts'])
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('DataRootCleanupJournal', () => {
  it('removes copied legacy Notebook evidence through the durable cleanup journal', async () => {
    const legacyDirectory = 'notebook-file-evidence'
    await mkdir(join(source, legacyDirectory, 'project-1'), { recursive: true })
    await mkdir(join(target, legacyDirectory, 'project-1'), { recursive: true })
    await writeFile(join(source, legacyDirectory, 'project-1', 'evidence.json'), 'legacy')
    await writeFile(join(target, legacyDirectory, 'project-1', 'evidence.json'), 'legacy')
    await writeMigrationMarker(target, {
      version: 1,
      token: 'cleanup-token',
      source,
      target,
      createdAt: 1,
      status: 'verified',
      migratedDirs: [legacyDirectory],
      inventory: await scanInventory(target, [legacyDirectory])
    })
    const journal = new DataRootCleanupJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: [legacyDirectory],
      createdAt: 1
    })
    await journal.markCommitted('cleanup-token')

    await expect(journal.recover(target, deleteSources)).resolves.toEqual({
      pending: false,
      failureCount: 0
    })
    await expect(
      readFile(join(source, legacyDirectory, 'project-1', 'evidence.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(join(target, legacyDirectory, 'project-1', 'evidence.json'), 'utf8')
    ).resolves.toBe('legacy')
  })

  it('uses a legacy migration marker inventory as its cleanup authority', async () => {
    const legacyDirectory = 'notebook-file-evidence'
    await mkdir(join(source, legacyDirectory, 'project-1'), { recursive: true })
    await mkdir(join(target, legacyDirectory, 'project-1'), { recursive: true })
    await writeFile(join(source, legacyDirectory, 'project-1', 'evidence.json'), 'legacy')
    await writeFile(join(target, legacyDirectory, 'project-1', 'evidence.json'), 'legacy')
    await writeMigrationMarker(target, {
      version: 1,
      token: 'cleanup-token',
      source,
      target,
      createdAt: 1,
      status: 'verified',
      inventory: await scanInventory(target, [legacyDirectory])
    })
    const journal = new DataRootCleanupJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: [legacyDirectory],
      createdAt: 1
    })
    await journal.markCommitted('cleanup-token')

    await expect(journal.recover(target, deleteSources)).resolves.toEqual({
      pending: false,
      failureCount: 0
    })
    await expect(
      readFile(join(source, legacyDirectory, 'project-1', 'evidence.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(join(target, legacyDirectory, 'project-1', 'evidence.json'), 'utf8')
    ).resolves.toBe('legacy')
  })

  it('does not let absent new directories block cleanup from a legacy marker', async () => {
    await writeMigrationMarker(target, {
      version: 1,
      token: 'cleanup-token',
      source,
      target,
      createdAt: 1,
      status: 'verified',
      inventory: await scanInventory(target, ['artifacts'])
    })
    const journal = new DataRootCleanupJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: ['artifacts', 'notebook-file-evidence'],
      createdAt: 1
    })
    await journal.markCommitted('cleanup-token')

    await expect(journal.recover(target, deleteSources)).resolves.toEqual({
      pending: false,
      failureCount: 0
    })
    await expect(readFile(join(source, 'artifacts', 'result.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('does not extend a legacy marker beyond its verified inventory', async () => {
    const legacyDirectory = 'notebook-file-evidence'
    await mkdir(join(source, legacyDirectory, 'project-1'), { recursive: true })
    await mkdir(join(target, legacyDirectory, 'project-1'), { recursive: true })
    await writeFile(join(source, legacyDirectory, 'project-1', 'evidence.json'), 'source legacy')
    await writeFile(join(target, legacyDirectory, 'project-1', 'evidence.json'), 'target legacy')
    await writeMigrationMarker(target, {
      version: 1,
      token: 'cleanup-token',
      source,
      target,
      createdAt: 1,
      status: 'verified',
      inventory: await scanInventory(target, ['artifacts'])
    })
    const journal = new DataRootCleanupJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: ['artifacts', legacyDirectory],
      createdAt: 1
    })
    await journal.markCommitted('cleanup-token')

    await expect(journal.recover(target, deleteSources)).resolves.toEqual({
      pending: true,
      failureCount: 0
    })
    await expect(readFile(join(source, 'artifacts', 'result.txt'), 'utf8')).resolves.toBe(
      'preserved'
    )
    await expect(
      readFile(join(source, legacyDirectory, 'project-1', 'evidence.json'), 'utf8')
    ).resolves.toBe('source legacy')
  })

  it('does not recover a committed intent outside the live cleanup chain', async () => {
    const journal = new DataRootCleanupJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: ['artifacts'],
      createdAt: 1
    })
    await journal.markCommitted('cleanup-token')
    const otherSource = join(root, 'other-old-root')
    const otherTarget = join(root, 'other-new-root')
    await mkdir(join(otherSource, 'artifacts'), { recursive: true })
    await mkdir(join(otherTarget, 'artifacts'), { recursive: true })
    await writeFile(join(otherSource, 'artifacts', 'other.txt'), 'other source')

    await journal.stage({
      token: 'other-token',
      source: otherSource,
      target: otherTarget,
      dirs: ['artifacts'],
      createdAt: 2
    })

    await expect(journal.recover(otherTarget, deleteSources)).resolves.toEqual({
      pending: true,
      failureCount: 0
    })
    await expect(readFile(join(source, 'artifacts', 'result.txt'), 'utf8')).resolves.toBe(
      'preserved'
    )
    await expect(readFile(join(otherSource, 'artifacts', 'other.txt'), 'utf8')).resolves.toBe(
      'other source'
    )
    await expect(journal.hasPending()).resolves.toBe(true)
  })

  it('preserves cleanup authority across a later migration until the earlier source is removed', async () => {
    const journal = new DataRootCleanupJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: ['artifacts'],
      createdAt: 1
    })
    await journal.markCommitted('cleanup-token')

    const latestTarget = join(root, 'latest-root')
    await mkdir(join(latestTarget, 'artifacts'), { recursive: true })
    await writeFile(join(latestTarget, 'artifacts', 'result.txt'), 'preserved')
    await writeMigrationMarker(latestTarget, {
      version: 1,
      token: 'later-token',
      source: target,
      target: latestTarget,
      createdAt: 2,
      status: 'verified',
      migratedDirs: ['artifacts'],
      inventory: await scanInventory(latestTarget, ['artifacts'])
    })
    await journal.stage({
      token: 'later-token',
      source: target,
      target: latestTarget,
      dirs: ['artifacts'],
      createdAt: 2
    })
    await expect(journal.markCommitted('later-token')).resolves.toBe(true)

    const failEarlierCleanup = vi
      .fn<Parameters<typeof journal.recover>[1]>()
      .mockResolvedValueOnce({
        deleted: [],
        failed: [{ dir: 'artifacts', error: 'busy' }]
      })
      .mockImplementation(deleteSources)
    await expect(journal.recover(latestTarget, failEarlierCleanup)).resolves.toEqual({
      pending: true,
      failureCount: 1
    })
    await expect(readFile(join(target, 'artifacts', 'result.txt'), 'utf8')).resolves.toBe(
      'preserved'
    )

    await expect(journal.recover(latestTarget, deleteSources)).resolves.toEqual({
      pending: false,
      failureCount: 0
    })
    await expect(readFile(join(source, 'artifacts', 'result.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(target, 'artifacts', 'result.txt'), 'utf8')).rejects.toThrow()
  })

  it('refuses a dependent move until an uncommitted cleanup intent is recovered', async () => {
    const journal = new DataRootCleanupJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: ['artifacts'],
      createdAt: 1
    })
    const latestTarget = join(root, 'latest-root')
    await mkdir(latestTarget)

    await expect(
      journal.stage({
        token: 'later-token',
        source: target,
        target: latestTarget,
        dirs: ['artifacts'],
        createdAt: 2
      })
    ).rejects.toThrow('An earlier data-root cleanup must be recovered before moving again.')
  })

  it('never deletes a source directory that was replaced after staging', async () => {
    const journal = new DataRootCleanupJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: ['artifacts'],
      createdAt: 1
    })
    await rm(join(source, 'artifacts'), { recursive: true, force: true })
    await mkdir(join(source, 'artifacts'))
    await writeFile(join(source, 'artifacts', 'new-user-data.txt'), 'must survive')

    await expect(journal.recover(target, deleteSources)).resolves.toEqual({
      pending: true,
      failureCount: 0
    })
    await expect(readFile(join(source, 'artifacts', 'new-user-data.txt'), 'utf8')).resolves.toBe(
      'must survive'
    )
    await expect(journal.hasPending()).resolves.toBe(true)
  })

  it('never deletes a committed source that is selected as the live data root again', async () => {
    const journal = new DataRootCleanupJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: ['artifacts'],
      createdAt: 1
    })
    await journal.markCommitted('cleanup-token')

    await expect(journal.recover(source, deleteSources)).resolves.toEqual({
      pending: true,
      failureCount: 0
    })
    await expect(readFile(join(source, 'artifacts', 'result.txt'), 'utf8')).resolves.toBe(
      'preserved'
    )
    await expect(journal.hasPending()).resolves.toBe(true)
  })

  it('never deletes a committed source after the verified target copy changes', async () => {
    const journal = new DataRootCleanupJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: ['artifacts'],
      createdAt: 1
    })
    await journal.markCommitted('cleanup-token')
    await writeFile(join(target, 'artifacts', 'result.txt'), 'corrupted target')

    await expect(journal.recover(target, deleteSources)).resolves.toEqual({
      pending: true,
      failureCount: 0
    })
    await expect(readFile(join(source, 'artifacts', 'result.txt'), 'utf8')).resolves.toBe(
      'preserved'
    )
    await expect(journal.hasPending()).resolves.toBe(true)
  })

  it('keeps a failed cleanup durable and clears it after a later startup retry succeeds', async () => {
    const journal = new DataRootCleanupJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: ['artifacts'],
      createdAt: 1
    })
    const deleteSources = vi
      .fn()
      .mockResolvedValueOnce({ deleted: [], failed: [{ dir: 'artifacts', error: 'EACCES' }] })
      .mockImplementationOnce(async () => {
        await rm(join(source, 'artifacts'), { recursive: true, force: true })
        return { deleted: ['artifacts'], failed: [] }
      })

    await expect(journal.recover(target, deleteSources)).resolves.toEqual({
      pending: true,
      failureCount: 1
    })
    await expect(journal.hasPending()).resolves.toBe(true)
    await expect(readMigrationMarker(target)).resolves.toMatchObject({ token: 'cleanup-token' })

    await expect(journal.recover(target, deleteSources)).resolves.toEqual({
      pending: false,
      failureCount: 0
    })
    await expect(journal.hasPending()).resolves.toBe(false)
    await expect(readMigrationMarker(target)).resolves.toBeNull()
    await expect(readFile(join(target, 'artifacts', 'result.txt'), 'utf8')).resolves.toBe(
      'preserved'
    )
  })

  it('keeps cleanup pending while a source with expected data is temporarily unavailable', async () => {
    const journal = new DataRootCleanupJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: ['artifacts'],
      createdAt: 1
    })
    await journal.markCommitted('cleanup-token')
    await rm(source, { recursive: true, force: true })
    const deleteSources = vi.fn()

    await expect(journal.recover(target, deleteSources)).resolves.toEqual({
      pending: true,
      failureCount: 0
    })
    expect(deleteSources).not.toHaveBeenCalled()
    await expect(journal.hasPending()).resolves.toBe(true)
    await expect(readMigrationMarker(target)).resolves.toMatchObject({ token: 'cleanup-token' })
  })

  it('retries rebuildable runtime-cache cleanup before clearing the durable intent', async () => {
    const journal = new DataRootCleanupJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: ['artifacts'],
      createdAt: 1
    })
    await journal.markCommitted('cleanup-token')
    const cleanupRuntimeCache = vi
      .fn<(sourceRoot: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    await expect(journal.recover(target, deleteSources, cleanupRuntimeCache)).resolves.toEqual({
      pending: true,
      failureCount: 1
    })
    await expect(journal.hasPending()).resolves.toBe(true)
    await expect(readMigrationMarker(target)).resolves.toMatchObject({ token: 'cleanup-token' })

    await expect(journal.recover(target, deleteSources, cleanupRuntimeCache)).resolves.toEqual({
      pending: false,
      failureCount: 0
    })
    const canonicalSource = await realpath(source)
    expect(cleanupRuntimeCache).toHaveBeenNthCalledWith(1, canonicalSource)
    expect(cleanupRuntimeCache).toHaveBeenNthCalledWith(2, canonicalSource)
  })

  it('removes the migration marker before clearing the durable cleanup intent', async () => {
    class MarkerOrderJournal extends DataRootCleanupJournal {
      override async clear(expectedToken?: string): Promise<void> {
        await expect(readMigrationMarker(target)).resolves.toBeNull()
        await super.clear(expectedToken)
      }
    }
    const journal = new MarkerOrderJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: ['artifacts'],
      createdAt: 1
    })
    await journal.markCommitted('cleanup-token')

    await expect(journal.recover(target, deleteSources)).resolves.toEqual({
      pending: false,
      failureCount: 0
    })
    await expect(journal.hasPending()).resolves.toBe(false)
  })

  it('retries matching source leftovers after marker removal when journal clearing failed', async () => {
    class FailOnceJournal extends DataRootCleanupJournal {
      private failClear = true

      override async clear(expectedToken?: string): Promise<void> {
        if (this.failClear) {
          this.failClear = false
          throw new Error('simulated journal clear failure')
        }
        await super.clear(expectedToken)
      }
    }
    const journal = new FailOnceJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: ['artifacts'],
      createdAt: 1
    })
    await journal.markCommitted('cleanup-token')

    const leaveSourceBehind = vi
      .fn<Parameters<typeof journal.recover>[1]>()
      .mockResolvedValueOnce({ deleted: ['artifacts'], failed: [] })
      .mockImplementationOnce(deleteSources)

    await expect(journal.recover(target, leaveSourceBehind)).resolves.toEqual({
      pending: true,
      failureCount: 1
    })
    await expect(readMigrationMarker(target)).resolves.toBeNull()
    await expect(readFile(join(source, 'artifacts', 'result.txt'), 'utf8')).resolves.toBe(
      'preserved'
    )
    await expect(journal.recover(target, leaveSourceBehind)).resolves.toEqual({
      pending: false,
      failureCount: 0
    })
    await expect(readFile(join(source, 'artifacts', 'result.txt'), 'utf8')).rejects.toThrow()
    await expect(journal.hasPending()).resolves.toBe(false)
  })

  it('never deletes from an intent whose target is not the live data root', async () => {
    const journal = new DataRootCleanupJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: ['artifacts'],
      createdAt: 1
    })
    const otherRoot = join(root, 'other-root')
    await mkdir(otherRoot)
    const deleteSources = vi.fn()

    await expect(journal.recover(otherRoot, deleteSources)).resolves.toEqual({
      pending: true,
      failureCount: 0
    })
    expect(deleteSources).not.toHaveBeenCalled()
    await expect(readFile(join(source, 'artifacts', 'result.txt'), 'utf8')).resolves.toBe(
      'preserved'
    )
  })

  it('clears an uncommitted intent when the old source is still the live data root', async () => {
    const journal = new DataRootCleanupJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: ['artifacts'],
      createdAt: 1
    })
    const deleteSources = vi.fn()

    await expect(journal.recover(source, deleteSources)).resolves.toEqual({
      pending: false,
      failureCount: 0
    })
    expect(deleteSources).not.toHaveBeenCalled()
    await expect(journal.hasPending()).resolves.toBe(false)
    await expect(readMigrationMarker(target)).resolves.toMatchObject({ token: 'cleanup-token' })
  })

  it('clears an uncommitted intent after its failed-switchover target was discarded', async () => {
    const journal = new DataRootCleanupJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: ['artifacts'],
      createdAt: 1
    })
    await rm(target, { recursive: true, force: true })
    const deleteSources = vi.fn()

    await expect(journal.recover(source, deleteSources)).resolves.toEqual({
      pending: false,
      failureCount: 0
    })
    expect(deleteSources).not.toHaveBeenCalled()
    await expect(journal.hasPending()).resolves.toBe(false)
  })
})
