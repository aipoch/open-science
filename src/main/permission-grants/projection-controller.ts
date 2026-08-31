import type {
  PermissionGrantDefaultsRestoreView,
  PermissionGrantMutationResult,
  PermissionGrantMutationView,
  PermissionGrantRestoreRequest,
  PermissionGrantRevokeRequest,
  PermissionGrantSnapshot,
  PermissionGrantUndoExtendRequest,
  PermissionGrantUndoReceipt,
  PermissionGrantsChangedEvent
} from '../../shared/permission-grants'
import { restoreDefaultPermissionGrants } from './defaults'
import type { Project } from '../../shared/projects'
import type { SessionMetadataSnapshot } from '../session-persistence/coordinator'
import {
  projectPermissionGrantMutation,
  projectPermissionGrantSnapshot,
  type ConnectorPolicySnapshot
} from './catalog'
import type { PermissionGrantRegistry } from './registry'

type PermissionGrantProjectionControllerOptions = {
  registry: PermissionGrantRegistry
  projects: { list(): Promise<Project[]> }
  sessions: { metadataSnapshot(): Promise<SessionMetadataSnapshot> }
  connectors?: { get(): Promise<ConnectorPolicySnapshot | undefined> }
  publishChanged: (event: PermissionGrantsChangedEvent) => void
}

type PermissionGrantProjection = Readonly<{
  list(): Promise<PermissionGrantSnapshot>
  restoreDefaults(): Promise<PermissionGrantDefaultsRestoreView>
  revoke(request: PermissionGrantRevokeRequest): Promise<PermissionGrantMutationView>
  extendUndo(
    request: PermissionGrantUndoExtendRequest
  ): Promise<PermissionGrantUndoReceipt | undefined>
  restore(request: PermissionGrantRestoreRequest): Promise<PermissionGrantMutationView>
}>

type PermissionGrantProjectionController = PermissionGrantProjection & {
  invalidateProjection(): void
  dispose(): void
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

const createPermissionGrantProjectionController = (
  options: PermissionGrantProjectionControllerOptions
): PermissionGrantProjectionController => {
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
  const list = async (): Promise<PermissionGrantSnapshot> => {
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
  const revoke = async (
    request: PermissionGrantRevokeRequest
  ): Promise<PermissionGrantMutationView> => {
    validateRevokeRequest(request)
    return mutationSnapshot(await options.registry.revoke(request))
  }
  const extendUndo = async (
    request: PermissionGrantUndoExtendRequest
  ): Promise<PermissionGrantUndoReceipt | undefined> => {
    validateRestoreRequest(request)
    return options.registry.extendUndo(request)
  }
  const restore = async (
    request: PermissionGrantRestoreRequest
  ): Promise<PermissionGrantMutationView> => {
    validateRestoreRequest(request)
    return mutationSnapshot(await options.registry.restore(request))
  }
  const restoreDefaults = async (): Promise<PermissionGrantDefaultsRestoreView> => {
    const restoredCount = await restoreDefaultPermissionGrants(options.registry)
    return { ...(await list()), restoredCount }
  }
  const invalidateProjection = (): void => {
    version += 1
    options.publishChanged({ revision: version })
  }
  const dispose = options.registry.subscribe(invalidateProjection)

  return { list, restoreDefaults, revoke, extendUndo, restore, invalidateProjection, dispose }
}

export { createPermissionGrantProjectionController }
export type {
  PermissionGrantProjection,
  PermissionGrantProjectionController,
  PermissionGrantProjectionControllerOptions
}
