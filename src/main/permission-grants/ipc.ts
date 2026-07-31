import type {
  PermissionGrantMutationView,
  PermissionGrantMutationResult,
  PermissionGrantRestoreRequest,
  PermissionGrantRevokeRequest,
  PermissionGrantSnapshot,
  PermissionGrantUndoExtendRequest,
  PermissionGrantUndoReceipt,
  PermissionGrantsChangedEvent
} from '../../shared/permission-grants'
import type { Project } from '../../shared/projects'
import { ipcMainHandle } from '../ipc-handler-registry'
import { broadcastToRenderers } from '../renderer-broadcast'
import type { SessionMetadataSnapshot } from '../session-persistence/coordinator'
import {
  projectPermissionGrantMutation,
  projectPermissionGrantSnapshot,
  type ConnectorPolicySnapshot
} from './catalog'
import type { PermissionGrantRegistry } from './registry'

type PermissionGrantIpcOptions = {
  registry: PermissionGrantRegistry
  projects: { list(): Promise<Project[]> }
  sessions: { metadataSnapshot(): Promise<SessionMetadataSnapshot> }
  connectors?: { get(): Promise<ConnectorPolicySnapshot | undefined> }
  broadcast?: (channel: string, payload: PermissionGrantsChangedEvent) => void
}

type PermissionGrantIpcController = {
  dispose(): void
  invalidateProjection(): void
}

const validateRevokeRequest = (request: PermissionGrantRevokeRequest): void => {
  if (!request || !Array.isArray(request.grants) || request.grants.length === 0) {
    throw new Error('Select at least one permission grant to revoke.')
  }
  if (request.grants.length > 1_000) throw new Error('Too many permission grants selected.')
  for (const grant of request.grants) {
    if (!grant.id?.trim() || !Number.isSafeInteger(grant.revision) || grant.revision < 1) {
      throw new Error('Invalid permission grant revision.')
    }
  }
}

const validateRestoreRequest = (request: PermissionGrantRestoreRequest): void => {
  if (!request?.undoToken?.trim()) throw new Error('Permission Undo token is required.')
}

const registerPermissionGrantIpcHandlers = (
  options: PermissionGrantIpcOptions
): PermissionGrantIpcController => {
  const names = async (): Promise<{
    projects: Map<string, string>
    sessions: Map<string, string>
    connectorPolicy?: ConnectorPolicySnapshot
    incompleteStores: PermissionGrantSnapshot['incompleteStores']
  }> => {
    const [projectsResult, sessionsResult, connectorPolicyResult] = await Promise.allSettled([
      options.projects.list(),
      Promise.resolve().then(() => options.sessions.metadataSnapshot()),
      options.connectors?.get()
    ])
    const projects = projectsResult.status === 'fulfilled' ? projectsResult.value : []
    const sessions: SessionMetadataSnapshot =
      sessionsResult.status === 'fulfilled'
        ? sessionsResult.value
        : { sessions: [], isComplete: false }
    const connectorPolicy =
      connectorPolicyResult.status === 'fulfilled' ? connectorPolicyResult.value : undefined
    const incompleteStores: PermissionGrantSnapshot['incompleteStores'] = []
    if (projectsResult.status === 'rejected') incompleteStores.push('projects')
    if (sessionsResult.status === 'rejected' || !sessions.isComplete) {
      incompleteStores.push('sessions')
    }
    if (connectorPolicyResult.status === 'rejected') incompleteStores.push('connector_policy')
    return {
      projects: new Map(projects.map((project): [string, string] => [project.id, project.name])),
      sessions: new Map(
        sessions.sessions.map((session): [string, string] => [session.id, session.title])
      ),
      incompleteStores,
      ...(connectorPolicy ? { connectorPolicy } : {})
    }
  }

  let version = 0
  const snapshot = async (): Promise<PermissionGrantSnapshot> => {
    for (;;) {
      const snapshotVersion = version
      const metadata = await names()
      const records = await options.registry.list()
      if (snapshotVersion !== version) continue
      return projectPermissionGrantSnapshot(records, metadata, {
        version: snapshotVersion,
        incompleteStores: metadata.incompleteStores
      })
    }
  }
  const mutationSnapshot = async (
    result: PermissionGrantMutationResult
  ): Promise<PermissionGrantMutationView> => {
    for (;;) {
      const snapshotVersion = version
      const metadata = await names()
      result.grants = await options.registry.list()
      if (snapshotVersion !== version) continue
      return projectPermissionGrantMutation(result, metadata, {
        version: snapshotVersion,
        incompleteStores: metadata.incompleteStores
      })
    }
  }

  ipcMainHandle('permissions:list', snapshot)
  ipcMainHandle(
    'permissions:revoke',
    async (_event, request: PermissionGrantRevokeRequest): Promise<PermissionGrantMutationView> => {
      validateRevokeRequest(request)
      const result = await options.registry.revoke(request)
      return mutationSnapshot(result)
    }
  )
  ipcMainHandle(
    'permissions:extend-undo',
    async (
      _event,
      request: PermissionGrantUndoExtendRequest
    ): Promise<PermissionGrantUndoReceipt | undefined> => {
      validateRestoreRequest(request)
      return options.registry.extendUndo(request)
    }
  )
  ipcMainHandle(
    'permissions:restore',
    async (
      _event,
      request: PermissionGrantRestoreRequest
    ): Promise<PermissionGrantMutationView> => {
      validateRestoreRequest(request)
      const result = await options.registry.restore(request)
      return mutationSnapshot(result)
    }
  )

  const broadcast = options.broadcast ?? broadcastToRenderers
  const invalidateProjection = (): void => {
    version += 1
    broadcast('permissions:changed', { revision: version })
  }
  const dispose = options.registry.subscribe(invalidateProjection)
  return { dispose, invalidateProjection }
}

export { registerPermissionGrantIpcHandlers }
export type { PermissionGrantIpcController, PermissionGrantIpcOptions }
