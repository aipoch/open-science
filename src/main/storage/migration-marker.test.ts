import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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
      inventory: {
        dirs: ['artifacts'],
        fileCount: 2,
        totalBytes: 10,
        digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      }
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

  it('returns null when a verified marker has a malformed inventory', async () => {
    await writeFile(
      join(root, MIGRATION_MARKER_FILENAME),
      JSON.stringify({ ...sampleMarker({ status: 'verified' }), inventory: { fileCount: -1 } })
    )

    expect(await readMigrationMarker(root)).toBeNull()
  })

  it('returns null when migrated paths escape the staged data root', async () => {
    await writeFile(
      join(root, MIGRATION_MARKER_FILENAME),
      JSON.stringify(sampleMarker({ migratedDirs: ['artifacts', '../outside'] }))
    )

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
    expect(inventory.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('reports an empty tally when no dirs exist', async () => {
    expect(await scanInventory(root, ['artifacts', 'uploads'])).toEqual({
      dirs: [],
      fileCount: 0,
      totalBytes: 0,
      digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    })
  })

  it('counts an existing-but-empty dir as present with zero files', async () => {
    await mkdir(join(root, 'artifacts'), { recursive: true })

    expect(await scanInventory(root, ['artifacts'])).toMatchObject({
      dirs: ['artifacts'],
      fileCount: 0,
      totalBytes: 0
    })
  })

  it('includes a top-level SQLite file in the verified inventory', async () => {
    await writeFile(join(root, 'open-science.db'), 'database bytes')

    expect(await scanInventory(root, ['open-science.db'])).toMatchObject({
      dirs: ['open-science.db'],
      fileCount: 1,
      totalBytes: 'database bytes'.length
    })
  })

  it.skipIf(process.platform === 'win32')(
    'inventories relative symlinks used by the Conda package cache',
    async () => {
      const packageRoot = join(root, 'runtime', 'pkgs', 'ca-certificates', 'ssl')
      await mkdir(packageRoot, { recursive: true })
      await writeFile(join(packageRoot, 'cacert.pem'), 'certificate bytes')
      await symlink('cacert.pem', join(packageRoot, 'cert.pem'))

      const inventory = await scanInventory(root, [join('runtime', 'pkgs')])
      expect(inventory).toMatchObject({
        dirs: [join('runtime', 'pkgs')],
        fileCount: 2,
        totalBytes: 'certificate bytes'.length + Buffer.byteLength('cacert.pem')
      })

      await rm(join(packageRoot, 'cert.pem'))
      await symlink('badcrt.pem', join(packageRoot, 'cert.pem'))
      expect((await scanInventory(root, [join('runtime', 'pkgs')])).digest).not.toBe(
        inventory.digest
      )
    }
  )
})
