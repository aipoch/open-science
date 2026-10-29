import type { AcpStateSnapshot } from '../../../../shared/acp'
import { useDesktopRuntimeRecoveryStore } from '../../stores/desktop-runtime-recovery-store'

type SnapshotActivity = Pick<
  AcpStateSnapshot,
  | 'promptInFlightSessionIds'
  | 'agentPromptInFlightSessionIds'
  | 'pendingPermissions'
  | 'pendingElicitations'
>
type SnapshotScope = {
  generation: string | undefined
  latestRevision?: number
  activeSessionIds?: Set<string>
}
let scope: SnapshotScope = { generation: useDesktopRuntimeRecoveryStore.getState().generation }
let snapshotScopes = new WeakMap<object, SnapshotScope>()

useDesktopRuntimeRecoveryStore.subscribe((next, previous) => {
  if (next.generation === previous.generation) return
  // Initial identity discovery binds snapshots already read from that same service. A real
  // replacement creates a new scope even when no consumer ran between the lifecycle events.
  if (scope.generation === undefined && previous.generation === undefined) {
    scope.generation = next.generation
  } else {
    scope = { generation: next.generation }
  }
})

// Revisions belong to a service generation, not a renderer lifetime or socket epoch. Remember
// admitted objects too: an older React render must not acquire authority in the replacement service.
const acceptAcpRuntimeSnapshotRevision = (
  snapshot: Pick<AcpStateSnapshot, 'revision'> & Partial<SnapshotActivity>
): boolean => {
  const source = snapshotScopes.get(snapshot)
  if (source && source !== scope) return false
  snapshotScopes.set(snapshot, scope)
  const revision = snapshot.revision
  if (
    scope.latestRevision !== undefined &&
    (revision === undefined || revision < scope.latestRevision)
  )
    return false
  // Keep session activity at the same watermark as the revision, including snapshots accepted
  // outside React. A revision-only advance leaves activity unknown until its state is observed.
  if (revision !== scope.latestRevision) scope.activeSessionIds = undefined
  scope.latestRevision = revision
  if (snapshot.promptInFlightSessionIds && snapshot.pendingPermissions) {
    scope.activeSessionIds = new Set([
      ...snapshot.promptInFlightSessionIds,
      ...(snapshot.agentPromptInFlightSessionIds ?? []),
      ...snapshot.pendingPermissions.map((request) => request.sessionId),
      ...(snapshot.pendingElicitations ?? []).map((request) => request.sessionId)
    ])
  }
  return true
}

const getAcpRuntimeSnapshotScope = (): object => scope

// Undefined is deliberately distinct from idle: recovery requires observed runtime authority.
const hasAcpRuntimeSessionActivity = (sessionId: string): boolean | undefined =>
  scope.activeSessionIds?.has(sessionId)

const resetAcpRuntimeSnapshotRevisionForTests = (): void => {
  scope = { generation: useDesktopRuntimeRecoveryStore.getState().generation }
  snapshotScopes = new WeakMap()
}

export {
  acceptAcpRuntimeSnapshotRevision,
  getAcpRuntimeSnapshotScope,
  hasAcpRuntimeSessionActivity,
  resetAcpRuntimeSnapshotRevisionForTests
}
