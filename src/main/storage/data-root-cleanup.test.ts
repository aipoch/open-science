import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  it('refuses to overwrite cleanup authority that is still pending', async () => {
    const journal = new DataRootCleanupJournal(configRoot)
    await journal.stage({
      token: 'cleanup-token',
      source,
      target,
      dirs: ['artifacts'],
      createdAt: 1
    })
    const otherSource = join(root, 'other-old-root')
    const otherTarget = join(root, 'other-new-root')
    await mkdir(otherSource)
    await mkdir(otherTarget)

    await expect(
      journal.stage({
        token: 'other-token',
        source: otherSource,
        target: otherTarget,
        dirs: ['artifacts'],
        createdAt: 2
      })
    ).rejects.toThrow('cleanup is still pending')

    const deleteSources = vi.fn().mockResolvedValue({ deleted: ['artifacts'], failed: [] })
    await expect(journal.recover(target, deleteSources)).resolves.toEqual({
      pending: false,
      failureCount: 0
    })
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
})
