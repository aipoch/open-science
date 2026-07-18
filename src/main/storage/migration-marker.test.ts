import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MIGRATION_MARKER_FILENAME,
  hasPendingMigrationMarker,
  newToken,
  readMigrationMarker,
  removeMigrationMarker,
  scanInventory,
  writeMigrationMarker,
  type MigrationMarker
} from './migration-marker'

let root: string

const sampleMarker = (overrides: Partial<MigrationMarker> = {}): MigrationMarker => ({
  version: 1,
  token: 'tok-123',
  source: '/old/OpenScience',
  target: '/new/OpenScience',
  createdAt: 1_700_000_000_000,
  status: 'copying',
  ...overrides
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ds-migration-marker-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('migration-marker read/write/remove', () => {
  it('round-trips a written marker', async () => {
    const marker = sampleMarker({
      status: 'verified',
      inventory: { dirs: ['artifacts'], fileCount: 2, totalBytes: 10 }
    })
    await writeMigrationMarker(root, marker)

    expect(await readMigrationMarker(root)).toEqual(marker)
  })

  it('hasPendingMigrationMarker reflects the marker file presence', async () => {
    expect(hasPendingMigrationMarker(root)).toBe(false)
    await writeMigrationMarker(root, sampleMarker())
    expect(hasPendingMigrationMarker(root)).toBe(true)
    await removeMigrationMarker(root)
    expect(hasPendingMigrationMarker(root)).toBe(false)
  })

  it('returns null when the marker file is missing', async () => {
    expect(await readMigrationMarker(root)).toBeNull()
  })

  it('returns null on corrupt / non-JSON marker content', async () => {
    await writeFile(join(root, MIGRATION_MARKER_FILENAME), 'not json {')
    expect(await readMigrationMarker(root)).toBeNull()
  })

  it('returns null when required fields are missing (short/partial JSON)', async () => {
    await writeFile(join(root, MIGRATION_MARKER_FILENAME), JSON.stringify({ version: 1 }))
    expect(await readMigrationMarker(root)).toBeNull()
  })

  it('removeMigrationMarker is idempotent (no throw when absent)', async () => {
    await expect(removeMigrationMarker(root)).resolves.toBeUndefined()
    await writeMigrationMarker(root, sampleMarker())
    await expect(removeMigrationMarker(root)).resolves.toBeUndefined()
    await expect(removeMigrationMarker(root)).resolves.toBeUndefined()
  })

  it('newToken produces distinct values', () => {
    expect(newToken()).not.toBe(newToken())
  })
})

describe('scanInventory', () => {
  it('counts files and bytes across present dirs, listing only those that exist', async () => {
    await mkdir(join(root, 'artifacts', 'nested'), { recursive: true })
    await writeFile(join(root, 'artifacts', 'a.txt'), 'hello') // 5 bytes
    await writeFile(join(root, 'artifacts', 'nested', 'b.txt'), 'xyz') // 3 bytes
    await mkdir(join(root, 'notebooks'), { recursive: true })
    await writeFile(join(root, 'notebooks', 'c.txt'), 'ab') // 2 bytes
    // uploads is absent on purpose

    const inventory = await scanInventory(root, ['artifacts', 'notebooks', 'uploads'])

    expect(inventory.fileCount).toBe(3)
    expect(inventory.totalBytes).toBe(10)
    expect(inventory.dirs.sort()).toEqual(['artifacts', 'notebooks'])
  })

  it('reports an empty tally when no dirs exist', async () => {
    expect(await scanInventory(root, ['artifacts', 'uploads'])).toEqual({
      dirs: [],
      fileCount: 0,
      totalBytes: 0
    })
  })

  it('counts an existing-but-empty dir as present with zero files', async () => {
    await mkdir(join(root, 'artifacts'), { recursive: true })

    expect(await scanInventory(root, ['artifacts'])).toEqual({
      dirs: ['artifacts'],
      fileCount: 0,
      totalBytes: 0
    })
  })
})
