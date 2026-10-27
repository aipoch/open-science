import type { AcpStateSnapshot } from '../../../../shared/acp'
import { useDesktopRuntimeRecoveryStore } from '../../stores/desktop-runtime-recovery-store'

type SnapshotScope = { generation: string | undefined; latestRevision?: number }
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
  snapshot: Pick<AcpStateSnapshot, 'revision'>
): boolean => {
  const source = snapshotScopes.get(snapshot)
  if (source && source !== scope) return false
  snapshotScopes.set(snapshot, scope)
  const revision = snapshot.revision
  if (revision === undefined) return scope.latestRevision === undefined
  if (scope.latestRevision !== undefined && revision < scope.latestRevision) return false
  scope.latestRevision = revision
  return true
}

const getAcpRuntimeSnapshotScope = (): object => scope

const resetAcpRuntimeSnapshotRevisionForTests = (): void => {
  scope = { generation: useDesktopRuntimeRecoveryStore.getState().generation }
  snapshotScopes = new WeakMap()
}

export {
  acceptAcpRuntimeSnapshotRevision,
  getAcpRuntimeSnapshotScope,
  resetAcpRuntimeSnapshotRevisionForTests
}
