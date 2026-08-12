import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import type { GrantedLocalRoot } from '../../shared/local-fs'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { SettingsRepository } from '../settings/repository'
import {
  GrantedLocalRootsRepository,
  type LegacyGrantedLocalRootsStore
} from './granted-roots-repository'

// Integration tests against a real (temp) SQLite database, mirroring the projects/prisma-client
// harness. Requires the query engine, which is present in dev installs.

let storageRoot: string | undefined
let client: PrismaClient | undefined

afterEach(async () => {
  await client?.$disconnect()
  client = undefined

  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

const createRepository = async (
  legacy?: LegacyGrantedLocalRootsStore
): Promise<GrantedLocalRootsRepository> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-granted-roots-'))
  client = createProjectDbClient(storageRoot)
  await migrateApplicationDatabase(client)

  return new GrantedLocalRootsRepository(() => Promise.resolve(client!), legacy)
}

const root = (id: string, path: string, access: 'ro' | 'rw' = 'ro'): GrantedLocalRoot => ({
  id,
  path,
  name: path.split('/').pop() ?? path,
  access
})

describe('granted local roots repository', () => {
  it('starts empty on a fresh database', async () => {
    const repository = await createRepository()

    await expect(repository.list()).resolves.toEqual([])
  })

  it('inserts a grant and lists it back', async () => {
    const repository = await createRepository()

    await repository.upsertByPath(root('id-1', '/data/one', 'rw'))

    await expect(repository.list()).resolves.toEqual([
      { id: 'id-1', path: '/data/one', name: 'one', access: 'rw' }
    ])
  })

  it('de-dupes by path: a re-grant updates access and keeps the existing id', async () => {
    const repository = await createRepository()

    await repository.upsertByPath(root('id-1', '/data/one'))
    // A different id must not create a second row for the same path.
    const stored = await repository.upsertByPath(root('id-2', '/data/one', 'rw'))

    expect(stored.id).toBe('id-1')
    const roots = await repository.list()
    expect(roots).toHaveLength(1)
    expect(roots[0]).toMatchObject({ id: 'id-1', path: '/data/one', access: 'rw' })
  })

  it('updates the access level of one root by id', async () => {
    const repository = await createRepository()

    await repository.upsertByPath(root('id-1', '/data/one'))
    await repository.setAccess('id-1', 'rw')

    const roots = await repository.list()
    expect(roots[0]).toMatchObject({ id: 'id-1', access: 'rw' })
  })

  it('removes a root by id; removing an unknown id is a no-op', async () => {
    const repository = await createRepository()

    await repository.upsertByPath(root('id-1', '/data/one'))
    await repository.remove('id-1')
    await repository.remove('id-missing')

    await expect(repository.list()).resolves.toEqual([])
  })

  it('enforces path uniqueness at the database level', async () => {
    await createRepository()

    await client!.grantedLocalRoot.create({
      data: { id: 'id-1', path: '/data/one', name: 'one', access: 'ro' }
    })
    await expect(
      client!.grantedLocalRoot.create({
        data: { id: 'id-2', path: '/data/one', name: 'one', access: 'rw' }
      })
    ).rejects.toThrow()
  })
})

describe('granted local roots legacy settings.json import', () => {
  // Writes a raw settings.json holding the legacy field, then exposes it through the real
  // SettingsRepository so malformed-entry dropping is exercised exactly as production reads it.
  const writeLegacySettings = async (
    settingsDir: string,
    grantedLocalRoots: unknown[]
  ): Promise<SettingsRepository> => {
    await writeFile(
      join(settingsDir, 'settings.json'),
      JSON.stringify({ version: SETTINGS_FILE_VERSION, providers: [], grantedLocalRoots }),
      'utf8'
    )
    return new SettingsRepository(settingsDir)
  }

  const legacyStoreFor = (
    settingsRepository: SettingsRepository
  ): LegacyGrantedLocalRootsStore => ({
    getGrantedLocalRoots: async () =>
      (await settingsRepository.getSettings()).grantedLocalRoots ?? [],
    clearGrantedLocalRoots: () => settingsRepository.clearGrantedLocalRoots()
  })

  it('imports legacy settings roots into the DB, drops malformed entries, and clears the field', async () => {
    const settingsDir = await mkdtemp(join(tmpdir(), 'open-science-granted-roots-settings-'))
    try {
      const settingsRepository = await writeLegacySettings(settingsDir, [
        { id: 'id-1', path: '/data/one', name: 'one', access: 'ro' },
        { id: 'id-2', path: '/data/two', name: 'two', access: 'rw' },
        // Malformed: unknown access level and a missing path must not reach the DB.
        { id: 'id-3', path: '/data/three', name: 'three', access: 'admin' },
        { id: 'id-4', name: 'four', access: 'ro' }
      ])
      const repository = await createRepository(legacyStoreFor(settingsRepository))

      const roots = await repository.list()
      expect(roots).toHaveLength(2)
      expect(roots.find((entry) => entry.path === '/data/one')).toMatchObject({
        id: 'id-1',
        access: 'ro'
      })
      expect(roots.find((entry) => entry.path === '/data/two')).toMatchObject({
        id: 'id-2',
        access: 'rw'
      })

      // The legacy field is gone from settings.json once every row has landed in the DB.
      const raw = JSON.parse(await readFile(join(settingsDir, 'settings.json'), 'utf8')) as Record<
        string,
        unknown
      >
      expect('grantedLocalRoots' in raw).toBe(false)
    } finally {
      await rm(settingsDir, { recursive: true, force: true })
    }
  })

  it('is idempotent: a second run imports nothing and keeps access changes intact', async () => {
    const settingsDir = await mkdtemp(join(tmpdir(), 'open-science-granted-roots-settings-'))
    try {
      const settingsRepository = await writeLegacySettings(settingsDir, [
        { id: 'id-1', path: '/data/one', name: 'one', access: 'ro' }
      ])
      const legacy = legacyStoreFor(settingsRepository)
      const repository = await createRepository(legacy)
      await repository.list()

      // Change access in the DB, then replay the import (a new process would construct a fresh
      // repository; here the migration cache is per instance, so a second instance replays).
      await repository.setAccess('id-1', 'rw')
      await writeLegacySettings(settingsDir, [
        { id: 'id-1', path: '/data/one', name: 'one', access: 'ro' }
      ])
      const replay = new GrantedLocalRootsRepository(() => Promise.resolve(client!), legacy)

      const roots = await replay.list()
      expect(roots).toHaveLength(1)
      // The existing DB row wins — the legacy value never clobbers a post-import change.
      expect(roots[0]).toMatchObject({ id: 'id-1', access: 'rw' })
      // The replayed import clears the field again.
      expect((await settingsRepository.getSettings()).grantedLocalRoots).toBeUndefined()
    } finally {
      await rm(settingsDir, { recursive: true, force: true })
    }
  })

  it('keeps settings.json as the retry source when the import fails before clearing', async () => {
    const rows = [root('id-1', '/data/one')]
    let clears = 0
    let failClear = true
    const legacy: LegacyGrantedLocalRootsStore = {
      getGrantedLocalRoots: async () => rows,
      clearGrantedLocalRoots: async () => {
        clears += 1
        if (failClear) throw new Error('settings write failed')
      }
    }
    const repository = await createRepository(legacy)

    await expect(repository.list()).rejects.toThrow('settings write failed')
    // The failed migration is not cached: the next call retries the import.
    failClear = false
    await expect(repository.list()).resolves.toEqual([
      { id: 'id-1', path: '/data/one', name: 'one', access: 'ro' }
    ])
    expect(clears).toBe(2)
  })
})
