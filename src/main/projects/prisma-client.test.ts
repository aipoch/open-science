import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ProjectRepository } from './repository'
import { createProjectDbClient, ensureProjectSchema } from './prisma-client'

// Proves the runtime CREATE TABLE IF NOT EXISTS DDL is byte-compatible with the generated Prisma client
// against a real (temp) SQLite database. Requires the query engine, which is present in dev installs.

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined

  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('project prisma client (integration)', () => {
  it('ensures the schema (no seed) and round-trips CRUD', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-projects-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await ensureProjectSchema(client)

    const repository = new ProjectRepository(() => Promise.resolve(client))

    // A fresh install starts with no projects; the user creates the first one.
    expect(await repository.list()).toEqual([])

    // Ensuring again is idempotent (table already exists, still no seed).
    await ensureProjectSchema(client)
    expect(await repository.list()).toEqual([])

    // Create reads/writes every column type Prisma expects (TEXT, BOOLEAN, DATETIME defaults).
    const created = await repository.create({ name: 'Reproduction', description: 'demo' })
    expect(created.name).toBe('Reproduction')
    expect(created.description).toBe('demo')
    expect(created.isExample).toBe(false)
    expect(created.createdAt).toBeGreaterThan(0)
    expect(created.updatedAt).toBeGreaterThan(0)

    const fetched = await repository.get(created.id)
    expect(fetched?.name).toBe('Reproduction')

    const renamed = await repository.update({ id: created.id, name: 'Renamed' })
    expect(renamed.name).toBe('Renamed')

    // Any project is deletable — there is no protected default.
    await repository.delete(created.id)
    expect(await repository.get(created.id)).toBeNull()
    expect(await repository.list()).toEqual([])
  })
})
