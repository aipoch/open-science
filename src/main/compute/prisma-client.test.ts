import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ComputeHostRepository } from './repository'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'

// Exercises ComputeHostRepository against the current application schema in a real SQLite database.
// Schema migration behavior is owned by src/main/database/migration-service.test.ts.

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
  it('round-trips CRUD (provider_id unique, JSON columns, timestamps)', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-compute-'))

    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()

    await migrateApplicationDatabase(client)

    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    // Fresh install starts with no hosts.
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

    await migrateApplicationDatabase(client)

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
})
