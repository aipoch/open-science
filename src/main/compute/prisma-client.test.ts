import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ComputeHostRepository } from './repository'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'

// Proves the runtime CREATE TABLE IF NOT EXISTS DDL for ComputeHost is byte-compatible with the
// generated Prisma client against a real (temp) SQLite database, and that adding the table to an
// existing (pre-compute) DB is a safe, purely-additive migration (CLAUDE.md schema-compat requirement).
// Requires the query engine, which is present in dev installs.

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

describe('compute host prisma client (integration)', () => {
  it('ensures the schema and round-trips CRUD (provider_id unique, JSON columns, timestamps)', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-compute-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await ensureProjectSchema(client)

    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    // Fresh install starts with no hosts.
    expect(await repository.list()).toEqual([])

    // Ensuring again is idempotent (table + unique index already exist).
    await ensureProjectSchema(client)
    expect(await repository.list()).toEqual([])

    // Create reads/writes every column type Prisma expects (TEXT, BOOLEAN, INTEGER, DATETIME, JSON).
    const created = await repository.create({
      sshAlias: 'biowulf',
      displayName: 'NIH Biowulf',
      detailsDoc: 'runs slurm; use the ccr account',
      sshOverrides: { user: 'argocd', port: 2222, identityFile: '~/.ssh/id_ed25519' }
    })
    expect(created.providerId).toBe('ssh:biowulf')
    expect(created.displayName).toBe('NIH Biowulf')
    expect(created.shape).toBe('direct_ssh')
    expect(created.scratchPinned).toBe(false)
    expect(created.sshOverrides).toEqual({
      user: 'argocd',
      port: 2222,
      identityFile: '~/.ssh/id_ed25519'
    })
    expect(created.detailsUpdatedBy).toBe('user')
    expect(created.detailsUpdatedAt).toBeGreaterThan(0)
    expect(created.createdAt).toBeGreaterThan(0)

    const fetched = await repository.get('ssh:biowulf')
    expect(fetched?.displayName).toBe('NIH Biowulf')

    // provider_id is unique: a second host with the same alias is rejected before insert.
    await expect(repository.create({ sshAlias: 'biowulf' })).rejects.toThrow(/already registered/i)
    expect((await repository.list()).length).toBe(1)

    await repository.delete('ssh:biowulf')
    expect(await repository.get('ssh:biowulf')).toBeNull()
    expect(await repository.list()).toEqual([])
  })

  it('enforces the provider_id unique index at the database level', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-compute-unique-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await ensureProjectSchema(client)

    // Insert one row directly, then a raw duplicate must violate the unique index (proving the index
    // exists and is authoritative even if the repository pre-check were bypassed).
    await client.computeHost.create({
      data: { providerId: 'ssh:dup', displayName: 'dup', sshAlias: 'dup' }
    })
    await expect(
      client.computeHost.create({
        data: { providerId: 'ssh:dup', displayName: 'dup2', sshAlias: 'dup' }
      })
    ).rejects.toThrow()
  })

  it('adds ComputeHost to a pre-existing DB without the table (additive migration)', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-compute-migrate-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    // Simulate an old DB that predates the Compute feature: only the Project table exists, populated
    // with a row that must survive the additive migration untouched.
    await client.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Project" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "isExample" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )`)
    await client.$executeRawUnsafe(
      `INSERT INTO "Project" ("id","name","updatedAt") VALUES ('p1','Existing',CURRENT_TIMESTAMP)`
    )

    // ensureProjectSchema must create ComputeHost (and its index) without error and without disturbing
    // the existing Project row.
    await expect(ensureProjectSchema(client)).resolves.toBeUndefined()
    // Idempotent second run.
    await expect(ensureProjectSchema(client)).resolves.toBeUndefined()

    const projects = await client.project.findMany()
    expect(projects).toHaveLength(1)
    expect(projects[0]!.name).toBe('Existing')

    const repository = new ComputeHostRepository(() => Promise.resolve(client))
    expect(await repository.list()).toEqual([])
    const created = await repository.create({ sshAlias: 'lab-gpu' })
    expect(created.providerId).toBe('ssh:lab-gpu')
  })
})
