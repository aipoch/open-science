import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Prisma, PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { createPermissionGrantRegistry, PermissionGrantTargetUnavailableError } from './registry'

let storageRoot: string | undefined
let clients: PrismaClient[] = []

afterEach(async () => {
  await Promise.all(clients.map((client) => client.$disconnect()))
  clients = []

  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

const openClient = async (): Promise<PrismaClient> => {
  if (!storageRoot) storageRoot = await mkdtemp(join(tmpdir(), 'open-science-permissions-'))

  const client = createProjectDbClient(storageRoot)
  clients.push(client)
  await ensureProjectSchema(client)
  return client
}

describe('PermissionGrantRegistry', () => {
  it('reacquires the shared client after an exclusive database disconnect', async () => {
    const firstClient = await openClient()
    let retired = false
    const guardedFirstClient = new Proxy(firstClient, {
      get(target, property, receiver) {
        if (retired && (property === '$transaction' || property === '$queryRawUnsafe')) {
          return () => Promise.reject(new Error('retired project database client was reused'))
        }
        return Reflect.get(target, property, receiver)
      }
    }) as PrismaClient
    let currentClient = guardedFirstClient
    let id = 0
    const registry = await createPermissionGrantRegistry({
      getClient: async () => currentClient,
      createId: () => `grant-${++id}`
    })

    await registry.remember({
      capability: { kind: 'file_operation', key: 'file:read' },
      scope: { kind: 'global' }
    })

    retired = true
    await firstClient.$disconnect()
    clients = clients.filter((client) => client !== firstClient)
    currentClient = await openClient()

    await registry.remember({
      capability: { kind: 'file_operation', key: 'file:write' },
      scope: { kind: 'global' }
    })

    const persisted = await currentClient.$queryRawUnsafe<Array<{ capabilityKey: string }>>(
      'SELECT "capabilityKey" FROM "PermissionGrant" ORDER BY "capabilityKey"'
    )
    expect(persisted.map((row) => row.capabilityKey)).toEqual(['file:read', 'file:write'])
    await expect(registry.list()).resolves.toHaveLength(2)
  })

  it('persists a Session grant across registry and database reopen', async () => {
    const firstClient = await openClient()
    await firstClient.project.create({
      data: { id: 'project-1', name: 'Project one' }
    })
    const firstRegistry = await createPermissionGrantRegistry({
      getClient: async () => firstClient,
      createId: () => 'grant-1',
      now: () => new Date('2026-07-30T00:00:00.000Z')
    })

    const capability = {
      kind: 'mcp_tool' as const,
      key: 'mcp:open-science-notebook/notebook_execute',
      qualifier: { mode: 'category' as const, value: 'python' }
    }

    await firstRegistry.remember({
      capability,
      scope: { kind: 'session', projectId: 'project-1', sessionId: 'session-1' }
    })
    await firstClient.$disconnect()
    clients = clients.filter((client) => client !== firstClient)

    const reopenedClient = await openClient()
    const reopenedRegistry = await createPermissionGrantRegistry({
      getClient: async () => reopenedClient
    })

    await expect(
      reopenedRegistry.resolve(capability, {
        projectId: 'project-1',
        sessionId: 'session-1'
      })
    ).resolves.toMatchObject({
      grant: {
        id: 'grant-1',
        scope: { kind: 'session', projectId: 'project-1', sessionId: 'session-1' }
      },
      matchedScope: 'session'
    })
  })

  it('resolves the most specific matching scope without leaking across targets', async () => {
    const client = await openClient()
    await client.project.createMany({
      data: [
        { id: 'project-1', name: 'Project one' },
        { id: 'project-2', name: 'Project two' }
      ]
    })
    let id = 0
    const registry = await createPermissionGrantRegistry({
      getClient: async () => client,
      createId: () => `grant-${++id}`
    })
    const capability = {
      kind: 'file_operation' as const,
      key: 'file:write'
    }

    await registry.remember({ capability, scope: { kind: 'global' } })
    await registry.remember({
      capability,
      scope: { kind: 'project', projectId: 'project-1' }
    })
    await registry.remember({
      capability,
      scope: { kind: 'session', projectId: 'project-1', sessionId: 'session-1' }
    })

    await expect(
      registry.resolve(capability, { projectId: 'project-1', sessionId: 'session-1' })
    ).resolves.toMatchObject({ matchedScope: 'session' })
    await expect(
      registry.resolve(capability, { projectId: 'project-1', sessionId: 'session-2' })
    ).resolves.toMatchObject({ matchedScope: 'project' })
    await expect(
      registry.resolve(capability, { projectId: 'project-2', sessionId: 'session-1' })
    ).resolves.toMatchObject({ matchedScope: 'global' })
  })

  it('does not authorize a grant revoked while scope liveness is being checked', async () => {
    const client = await openClient()
    let releaseLiveness: ((live: boolean) => void) | undefined
    let deferLiveness = false
    const registry = await createPermissionGrantRegistry({
      getClient: async () => client,
      createId: () => 'grant-1',
      isScopeLive: async () =>
        deferLiveness
          ? new Promise<boolean>((resolve) => {
              releaseLiveness = resolve
            })
          : true
    })
    const capability = { kind: 'file_operation' as const, key: 'file:read' }
    const grant = await registry.remember({ capability, scope: { kind: 'global' } })

    deferLiveness = true
    const resolving = registry.resolve(capability, {})
    await vi.waitFor(() => expect(releaseLiveness).toBeTypeOf('function'))
    await registry.revoke({ grants: [{ id: grant.id, revision: grant.revision }] })
    releaseLiveness?.(true)

    await expect(resolving).resolves.toBeUndefined()
  })

  it('revokes an exact revision and restores it through a one-time Undo receipt', async () => {
    const client = await openClient()
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    let id = 0
    const registry = await createPermissionGrantRegistry({
      getClient: async () => client,
      createId: () => `grant-${++id}`,
      createUndoToken: () => 'undo-1',
      now: () => new Date('2026-07-30T00:00:00.000Z')
    })
    const capability = { kind: 'execution' as const, key: 'exec:local/python' }
    await registry.remember({
      capability,
      scope: { kind: 'project', projectId: 'project-1' }
    })
    const sessionGrant = await registry.remember({
      capability,
      scope: { kind: 'session', projectId: 'project-1', sessionId: 'session-1' }
    })

    const revoked = await registry.revoke({
      grants: [{ id: sessionGrant.id, revision: sessionGrant.revision }]
    })

    expect(revoked).toMatchObject({
      receipt: { undoToken: 'undo-1', revokedCount: 1 },
      conflicts: []
    })
    await expect(
      registry.resolve(capability, { projectId: 'project-1', sessionId: 'session-1' })
    ).resolves.toMatchObject({ matchedScope: 'project' })

    const restored = await registry.restore({ undoToken: 'undo-1' })
    expect(restored.conflicts).toEqual([])
    await expect(
      registry.resolve(capability, { projectId: 'project-1', sessionId: 'session-1' })
    ).resolves.toMatchObject({
      matchedScope: 'session',
      grant: { id: sessionGrant.id, revision: 2 }
    })

    await expect(registry.restore({ undoToken: 'undo-1' })).resolves.toMatchObject({
      conflicts: []
    })
    await expect(registry.list()).resolves.toHaveLength(2)
  })

  it('keeps the concurrently re-created row and its actual revision when Undo converges', async () => {
    const client = await openClient()
    let id = 0
    const registry = await createPermissionGrantRegistry({
      getClient: async () => client,
      createId: () => `grant-${++id}`,
      createUndoToken: () => 'undo-race'
    })
    const capability = { kind: 'file_operation' as const, key: 'file:write' }
    const original = await registry.remember({ capability, scope: { kind: 'global' } })
    const revoked = await registry.revoke({
      grants: [{ id: original.id, revision: original.revision }]
    })
    const concurrent = await registry.remember({ capability, scope: { kind: 'global' } })

    const restored = await registry.restore({ undoToken: revoked.receipt!.undoToken })

    expect(restored.conflicts).toEqual([])
    expect(restored.grants).toEqual([concurrent])
    const revokedAgain = await registry.revoke({
      grants: [{ id: concurrent.id, revision: concurrent.revision }]
    })
    expect(revokedAgain.conflicts).toEqual([])
    expect(revokedAgain.grants).toEqual([])
  })

  it('serializes database commits with cache updates across concurrent mutations', async () => {
    const client = await openClient()
    let transactionCount = 0
    let releaseRevocation = (): void => undefined
    let reportRevocationCommitted = (): void => undefined
    const revocationReleased = new Promise<void>((resolve) => {
      releaseRevocation = resolve
    })
    const revocationCommitted = new Promise<void>((resolve) => {
      reportRevocationCommitted = resolve
    })
    const delayedClient = new Proxy(client, {
      get(target, property, receiver) {
        if (property !== '$transaction') return Reflect.get(target, property, receiver)
        return async (
          operation: (transaction: Prisma.TransactionClient) => Promise<unknown>
        ): Promise<unknown> => {
          transactionCount += 1
          const currentTransaction = transactionCount
          const result = await client.$transaction(operation)
          if (currentTransaction === 2) {
            reportRevocationCommitted()
            await revocationReleased
          }
          return result
        }
      }
    }) as PrismaClient
    let id = 0
    const registry = await createPermissionGrantRegistry({
      getClient: async () => delayedClient,
      createId: () => `grant-${++id}`
    })
    const capability = { kind: 'file_operation' as const, key: 'file:write' }
    const original = await registry.remember({ capability, scope: { kind: 'global' } })

    const revoke = registry.revoke({
      grants: [{ id: original.id, revision: original.revision }]
    })
    await revocationCommitted
    const remember = registry.remember({ capability, scope: { kind: 'global' } })
    await Promise.resolve()

    expect(transactionCount).toBe(2)
    releaseRevocation()
    await revoke
    const remembered = await remember

    expect(registry.listCached()).toEqual([remembered])
    await expect(
      client.permissionGrant.findMany({ select: { id: true, revision: true } })
    ).resolves.toEqual([{ id: remembered.id, revision: remembered.revision }])
  })

  it('extends a live Undo receipt from the authoritative clock', async () => {
    const client = await openClient()
    let now = 0
    const registry = await createPermissionGrantRegistry({
      getClient: async () => client,
      createUndoToken: () => 'extended-undo',
      now: () => new Date(now),
      receiptTtlMs: 10
    })
    const capability = { kind: 'execution' as const, key: 'exec:local/python' }
    const grant = await registry.remember({ capability, scope: { kind: 'global' } })
    await registry.revoke({ grants: [{ id: grant.id, revision: grant.revision }] })

    now = 6
    await expect(registry.extendUndo({ undoToken: 'extended-undo' })).resolves.toEqual({
      undoToken: 'extended-undo',
      expiresAt: 16,
      revokedCount: 1
    })
    now = 15
    await registry.restore({ undoToken: 'extended-undo' })

    await expect(registry.list()).resolves.toHaveLength(1)
  })

  it('discards expired Undo receipts so their row snapshots cannot become live again', async () => {
    const client = await openClient()
    let now = 0
    const registry = await createPermissionGrantRegistry({
      getClient: async () => client,
      createUndoToken: () => 'expired-undo',
      now: () => new Date(now),
      receiptTtlMs: 10
    })
    const capability = { kind: 'execution' as const, key: 'exec:local/python' }
    const grant = await registry.remember({ capability, scope: { kind: 'global' } })
    await registry.revoke({ grants: [{ id: grant.id, revision: grant.revision }] })

    now = 20
    await expect(registry.extendUndo({ undoToken: 'expired-undo' })).resolves.toBeUndefined()
    await registry.restore({ undoToken: 'expired-undo' })
    now = 0
    await registry.restore({ undoToken: 'expired-undo' })

    await expect(registry.list()).resolves.toEqual([])
  })

  it('rejects raw exact qualifiers at the durable Interface', async () => {
    const client = await openClient()
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client })

    await expect(
      registry.remember({
        capability: {
          kind: 'execution',
          key: 'exec:agent/shell',
          qualifier: { mode: 'exact', value: 'curl https://example.test?token=secret' }
        },
        scope: { kind: 'project', projectId: 'project-1' }
      })
    ).rejects.toThrow('Exact permission qualifiers must be a versioned SHA-256 digest.')
  })

  it('never authorizes or restores a grant after its Session owner disappears', async () => {
    const client = await openClient()
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    let sessionIsLive = true
    const registry = await createPermissionGrantRegistry({
      getClient: async () => client,
      createUndoToken: () => 'undo-session',
      isScopeLive: async (scope) => scope.kind !== 'session' || sessionIsLive
    })
    const capability = { kind: 'file_operation' as const, key: 'file:write' }
    const grant = await registry.remember({
      capability,
      scope: { kind: 'session', projectId: 'project-1', sessionId: 'session-1' }
    })
    sessionIsLive = false
    await expect(
      registry.resolve(capability, { projectId: 'project-1', sessionId: 'session-1' })
    ).resolves.toBeUndefined()

    sessionIsLive = true
    const revoked = await registry.revoke({
      grants: [{ id: grant.id, revision: grant.revision }]
    })
    expect(revoked.receipt?.undoToken).toBe('undo-session')

    sessionIsLive = false
    await expect(registry.restore({ undoToken: 'undo-session' })).resolves.toMatchObject({
      conflicts: [{ id: grant.id, reason: 'target-unavailable' }]
    })

    await expect(
      registry.resolve(capability, { projectId: 'project-1', sessionId: 'session-1' })
    ).resolves.toBeUndefined()
    await expect(registry.list()).resolves.toEqual([])
    await expect(
      registry.remember({
        capability,
        scope: { kind: 'session', projectId: 'project-1', sessionId: 'session-1' }
      })
    ).rejects.toBeInstanceOf(PermissionGrantTargetUnavailableError)
  })

  it('prunes Session and soft-owner grants and publishes cache changes', async () => {
    const client = await openClient()
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client })
    const changed = vi.fn()
    const unsubscribe = registry.subscribe(changed)

    await registry.remember({
      capability: { kind: 'mcp_tool', key: 'mcp:pubmed/search', qualifier: { mode: 'any' } },
      scope: { kind: 'session', projectId: 'project-1', sessionId: 'session-1' }
    })
    await registry.remember({
      capability: { kind: 'mcp_tool', key: 'mcp:other/search', qualifier: { mode: 'any' } },
      scope: { kind: 'project', projectId: 'project-1' }
    })

    await registry.prune({ kind: 'session', projectId: 'project-1', sessionId: 'session-1' })
    await expect(registry.list()).resolves.toHaveLength(1)
    await registry.prune({ kind: 'mcp_server', serverId: 'other' })
    expect(registry.listCached()).toEqual([])
    expect(changed).toHaveBeenCalledTimes(4)

    unsubscribe()
  })

  it('treats LIKE metacharacters in soft-owner ids as literal characters', async () => {
    const client = await openClient()
    const registry = await createPermissionGrantRegistry({ getClient: async () => client })
    await registry.remember({
      capability: { kind: 'mcp_tool', key: 'mcp:server%_\\name/search' },
      scope: { kind: 'global' }
    })
    await registry.remember({
      capability: { kind: 'mcp_tool', key: 'mcp:serverXX\\name/search' },
      scope: { kind: 'global' }
    })
    await registry.remember({
      capability: { kind: 'execution', key: 'exec:compute/provider%_\\name/submit' },
      scope: { kind: 'global' }
    })
    await registry.remember({
      capability: { kind: 'execution', key: 'exec:compute/providerXX\\name/submit' },
      scope: { kind: 'global' }
    })

    await registry.prune({ kind: 'mcp_server', serverId: 'server%_\\name' })
    await registry.prune({ kind: 'compute_provider', providerId: 'provider%_\\name' })

    await expect(registry.list()).resolves.toEqual([
      expect.objectContaining({
        capability: expect.objectContaining({ key: 'exec:compute/providerXX\\name/submit' })
      }),
      expect.objectContaining({
        capability: expect.objectContaining({ key: 'mcp:serverXX\\name/search' })
      })
    ])
  })

  it('does not restore pruned Connector or Compute owners from a mixed Undo receipt', async () => {
    const client = await openClient()
    const registry = await createPermissionGrantRegistry({
      getClient: async () => client,
      createUndoToken: () => 'undo-pruned-owners'
    })
    const connector = await registry.remember({
      capability: { kind: 'mcp_tool', key: 'mcp:retired-connector/search' },
      scope: { kind: 'global' }
    })
    const compute = await registry.remember({
      capability: { kind: 'execution', key: 'exec:compute/retired-provider/submit' },
      scope: { kind: 'global' }
    })
    const unrelated = await registry.remember({
      capability: { kind: 'file_operation', key: 'file:write' },
      scope: { kind: 'global' }
    })
    await registry.revoke({
      grants: [connector, compute, unrelated].map(({ id, revision }) => ({ id, revision }))
    })

    await registry.prune({ kind: 'mcp_server', serverId: 'retired-connector' })
    await registry.prune({ kind: 'compute_provider', providerId: 'retired-provider' })
    const restored = await registry.restore({ undoToken: 'undo-pruned-owners' })

    expect(restored.conflicts).toEqual([])
    expect(restored.grants).toEqual([
      expect.objectContaining({
        capability: expect.objectContaining({ kind: 'file_operation', key: 'file:write' })
      })
    ])
  })

  it('invalidates cached Project grants after the database FK already cascaded them', async () => {
    const client = await openClient()
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const registry = await createPermissionGrantRegistry({ getClient: async () => client })
    await registry.remember({
      capability: { kind: 'file_operation', key: 'file:read' },
      scope: { kind: 'project', projectId: 'project-1' }
    })

    await client.project.delete({ where: { id: 'project-1' } })
    expect(registry.listCached()).toHaveLength(1)

    await registry.prune({ kind: 'project', projectId: 'project-1' })
    expect(registry.listCached()).toEqual([])
  })

  it('finalizes a deleted owner after an already-committed remember updates the cache', async () => {
    const client = await openClient()
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    let releaseRemember = (): void => undefined
    let reportRememberCommitted = (): void => undefined
    const rememberReleased = new Promise<void>((resolve) => {
      releaseRemember = resolve
    })
    const rememberCommitted = new Promise<void>((resolve) => {
      reportRememberCommitted = resolve
    })
    const delayedClient = new Proxy(client, {
      get(target, property, receiver) {
        if (property !== '$transaction') return Reflect.get(target, property, receiver)
        return async (
          operation: (transaction: Prisma.TransactionClient) => Promise<unknown>
        ): Promise<unknown> => {
          const result = await client.$transaction(operation)
          reportRememberCommitted()
          await rememberReleased
          return result
        }
      }
    }) as PrismaClient
    const registry = await createPermissionGrantRegistry({
      getClient: async () => delayedClient,
      createId: () => 'late-grant'
    })
    const owner = { kind: 'project' as const, projectId: 'project-1' }
    await registry.prune(owner)

    const remember = registry.remember({
      capability: { kind: 'file_operation', key: 'file:write' },
      scope: owner
    })
    await rememberCommitted
    await client.project.delete({ where: { id: 'project-1' } })
    const finalize = registry.finalizeOwnerDeletion(owner)

    releaseRemember()
    await remember
    await finalize

    expect(registry.listCached()).toEqual([])
    await expect(client.permissionGrant.count()).resolves.toBe(0)
  })
})
