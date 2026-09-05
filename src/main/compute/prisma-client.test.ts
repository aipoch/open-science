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
    await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
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

  it('rejects an unsupported authentication mode at the database seam', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-compute-auth-mode-check-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    await expect(
      client.computeHost.create({
        data: {
          providerId: 'ssh:invalid-mode',
          displayName: 'invalid mode',
          sshAlias: 'invalid-mode',
          authenticationMode: 'keyboard_interactive'
        }
      })
    ).rejects.toThrow(/constraint/i)
  })

  it('rejects a non-positive authentication revision at the database seam', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-compute-auth-revision-check-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    await expect(
      client.computeHost.create({
        data: {
          providerId: 'ssh:invalid-revision',
          displayName: 'invalid revision',
          sshAlias: 'invalid-revision',
          authenticationRevision: 0
        }
      })
    ).rejects.toThrow(/constraint/i)
  })

  it('rejects a non-positive authentication operation result revision at the database seam', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-compute-result-revision-check-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    await expect(
      client.computeAuthOperation.create({
        data: {
          id: 'invalid-result-revision',
          providerId: 'ssh:test',
          operationKind: 'create_password',
          requestFingerprint: 'invalid-result-revision-fingerprint',
          resultRevision: 0
        }
      })
    ).rejects.toThrow(/constraint/i)
  })

  it('rolls back ciphertext and authentication revision when a reset transaction fails', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-compute-reset-rollback-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repository = new ComputeHostRepository(() => Promise.resolve(client))
    const created = await repository.createPasswordHost({
      operationId: 'create-password-host',
      requestFingerprint: 'create-protected-fingerprint',
      sshAlias: 'password-host',
      username: 'researcher',
      port: 22,
      ciphertext: Buffer.from('original ciphertext'),
      verifiedAt: new Date('2026-08-17T00:00:00.000Z')
    })
    await client.$executeRawUnsafe(`CREATE TRIGGER fail_password_reset_operation
      BEFORE INSERT ON "ComputeAuthOperation"
      WHEN NEW."id" = 'fail-reset'
      BEGIN
        SELECT RAISE(ABORT, 'forced reset rollback');
      END`)

    await expect(
      repository.resetPasswordHost({
        providerId: created.providerId,
        operationId: 'fail-reset',
        requestFingerprint: 'reset-protected-fingerprint',
        expectedAuthenticationRevision: 1,
        ciphertext: Buffer.from('replacement ciphertext'),
        verifiedAt: new Date('2026-08-17T01:00:00.000Z')
      })
    ).rejects.toThrow()

    await expect(repository.getCredential(created.id)).resolves.toEqual({
      ciphertext: Buffer.from('original ciphertext'),
      revision: 1
    })
    await expect(repository.get(created.providerId)).resolves.toMatchObject({
      authentication: { revision: 1, lastVerifiedAt: Date.parse('2026-08-17T00:00:00.000Z') }
    })
  })

  it('rejects replaying an authentication operation with a different request fingerprint', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-compute-operation-binding-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repository = new ComputeHostRepository(() => Promise.resolve(client))
    const request = {
      operationId: 'bound-create-password-host',
      operationKind: 'create_password' as const,
      requestFingerprint: 'protected-fingerprint-a',
      sshAlias: 'bound-password-host',
      username: 'researcher',
      port: 22,
      ciphertext: Buffer.from('original ciphertext'),
      verifiedAt: new Date('2026-08-17T00:00:00.000Z')
    }

    await repository.createPasswordHost(request)

    await expect(
      repository.createPasswordHost({
        ...request,
        requestFingerprint: 'protected-fingerprint-b',
        ciphertext: Buffer.from('replacement ciphertext')
      })
    ).rejects.toMatchObject({ code: 'credential_conflict' })
  })
  it('prepares password-host creation by replaying a committed operation or rejecting a duplicate alias', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-compute-create-preflight-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repository = new ComputeHostRepository(() => Promise.resolve(client))
    const request = {
      operationId: 'create-password-preflight',
      requestFingerprint: 'create-preflight-fingerprint',
      sshAlias: 'preflight-host',
      username: 'researcher',
      port: 22,
      ciphertext: Buffer.from('ciphertext'),
      verifiedAt: new Date('2026-08-17T00:00:00.000Z')
    }
    const committed = await repository.createPasswordHost(request)

    await expect(
      repository.preparePasswordCreate({
        operationId: request.operationId,
        requestFingerprint: request.requestFingerprint,
        sshAlias: request.sshAlias
      })
    ).resolves.toEqual({ kind: 'replay', host: committed })
    await expect(
      repository.preparePasswordCreate({
        operationId: 'different-create-operation',
        requestFingerprint: 'different-create-fingerprint',
        sshAlias: request.sshAlias
      })
    ).rejects.toThrow('A host with alias "preflight-host" is already registered.')
  })
})
