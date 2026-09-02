import type { PermissionGrantOwner, PermissionGrantRecord } from '../../shared/permission-grants'

type PermissionGrantReconciliationRegistry = {
  list(): Promise<PermissionGrantRecord[]>
  prune(owner: PermissionGrantOwner): Promise<unknown>
}

type PermissionGrantOwnerSnapshot = {
  sessions?: ReadonlyArray<{ projectId: string; sessionId: string }>
  customServerIds?: readonly string[]
  computeProviderIds?: readonly string[]
}

type PendingCustomServerDeletionStore = {
  pendingCustomServerDeletionIds: readonly string[]
  removeTagsForConnector(id: string): Promise<unknown>
  completeCustomServerDeletion(id: string): Promise<unknown>
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const reconcilePermissionGrantOwners = async (
  registry: PermissionGrantReconciliationRegistry,
  snapshot: PermissionGrantOwnerSnapshot
): Promise<void> => {
  const records = await registry.list()
  const sessions = snapshot.sessions
    ? new Set(
        snapshot.sessions.map(({ projectId, sessionId }) => JSON.stringify([projectId, sessionId]))
      )
    : undefined
  const customServerIds = snapshot.customServerIds ? new Set(snapshot.customServerIds) : undefined
  const computeProviderIds = snapshot.computeProviderIds
    ? new Set(snapshot.computeProviderIds)
    : undefined
  const owners = new Map<string, PermissionGrantOwner>()

  for (const record of records) {
    if (sessions && record.scope.kind === 'session') {
      const key = JSON.stringify([record.scope.projectId, record.scope.sessionId])
      if (!sessions.has(key)) {
        owners.set(`session:${key}`, {
          kind: 'session',
          projectId: record.scope.projectId,
          sessionId: record.scope.sessionId
        })
      }
    }

    if (record.capability.kind === 'mcp_tool') {
      const serverId = /^mcp:([^/]+)\//.exec(record.capability.key)?.[1]
      // App and bundled server ids are catalog strings. Custom servers are generated UUIDs, which
      // lets startup remove a grant left behind by an interrupted settings deletion without guessing
      // whether an unknown catalog string is retired or merely from a newer app version.
      if (
        customServerIds &&
        serverId &&
        UUID_PATTERN.test(serverId) &&
        !customServerIds.has(serverId)
      ) {
        owners.set(`mcp:${serverId}`, { kind: 'mcp_server', serverId })
      }
    }

    if (record.capability.kind === 'execution') {
      // Compute provider ids embed the user-selected SSH alias. Treat only the final path segment as
      // the operation so valid aliases containing '/' are reconciled against their complete id.
      const providerId = /^exec:compute\/(.+)\/[^/]+$/.exec(record.capability.key)?.[1]
      if (computeProviderIds && providerId && !computeProviderIds.has(providerId)) {
        owners.set(`compute:${providerId}`, { kind: 'compute_provider', providerId })
      }
    }
  }

  for (const owner of owners.values()) await registry.prune(owner)
}

const reconcilePendingCustomServerDeletions = async (
  registry: Pick<PermissionGrantReconciliationRegistry, 'prune'>,
  store: PendingCustomServerDeletionStore
): Promise<void> => {
  for (const serverId of store.pendingCustomServerDeletionIds) {
    await registry.prune({ kind: 'mcp_server', serverId })
    await store.removeTagsForConnector(serverId)
    await store.completeCustomServerDeletion(serverId)
  }
}

export { reconcilePendingCustomServerDeletions, reconcilePermissionGrantOwners }
export type {
  PendingCustomServerDeletionStore,
  PermissionGrantOwnerSnapshot,
  PermissionGrantReconciliationRegistry
}
