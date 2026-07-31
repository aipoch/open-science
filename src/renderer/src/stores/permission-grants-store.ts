import { create } from 'zustand'

import type {
  PermissionGrantMutationView,
  PermissionGrantSnapshot,
  PermissionGrantView
} from '../../../shared/permission-grants'

const EMPTY_SNAPSHOT: PermissionGrantSnapshot = {
  version: 0,
  incompleteStores: [],
  grants: [],
  counts: { all: 0, global: 0, project: 0, session: 0 }
}

type PermissionUndo = {
  token: string
  expiresAt: number
  message: string
  canRestore?: boolean
  retry?: boolean
}

type PermissionGrantsStore = PermissionGrantSnapshot & {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  undo?: PermissionUndo
  undoQueue: PermissionUndo[]
  isRestoring: boolean
  load: () => Promise<void>
  revoke: (grants: PermissionGrantView[]) => Promise<void>
  extendUndo: (token: string) => Promise<number | undefined>
  restore: (token?: string) => Promise<void>
  dismissUndo: (token?: string) => void
  listen: () => () => void
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Permission grants could not be updated.'

const FAMILY_LABELS: Record<PermissionGrantView['family'], string> = {
  registry_writes: 'Registry writes',
  local_compute: 'Local compute',
  connectors: 'Connectors',
  file_operations: 'File operations',
  skills: 'Skills',
  built_in_tools: 'Built-in tools'
}

const nextUndoState = (
  queue: PermissionUndo[]
): Pick<PermissionGrantsStore, 'undo' | 'undoQueue'> => {
  const remaining = queue.filter((item) => item.expiresAt > Date.now())
  const [undo, ...undoQueue] = remaining
  return { undo, undoQueue }
}

const mutationState = (
  result: PermissionGrantMutationView
): Pick<
  PermissionGrantsStore,
  'version' | 'incompleteStores' | 'grants' | 'counts' | 'status' | 'error'
> => ({
  version: result.version ?? 0,
  incompleteStores: result.incompleteStores ?? [],
  grants: result.grants,
  counts: result.counts,
  status: 'ready',
  error: undefined
})

const snapshotFromState = (state: PermissionGrantSnapshot): PermissionGrantSnapshot => ({
  version: state.version,
  incompleteStores: state.incompleteStores,
  grants: state.grants,
  counts: state.counts
})

const withoutGrants = (
  snapshot: PermissionGrantSnapshot,
  removed: PermissionGrantView[]
): PermissionGrantSnapshot => {
  const ids = new Set(removed.map((grant) => grant.id))
  const grants = snapshot.grants.filter((grant) => !ids.has(grant.id))
  return {
    version: snapshot.version,
    incompleteStores: snapshot.incompleteStores,
    grants,
    counts: {
      all: grants.length,
      global: grants.filter((grant) => grant.scopeKind === 'global').length,
      project: grants.filter((grant) => grant.scopeKind === 'project').length,
      session: grants.filter((grant) => grant.scopeKind === 'session').length
    }
  }
}

const withRestoredGrants = (
  snapshot: PermissionGrantSnapshot,
  restored: PermissionGrantView[]
): PermissionGrantSnapshot => {
  const byId = new Map(snapshot.grants.map((grant) => [grant.id, grant]))
  for (const grant of restored) {
    if (!byId.has(grant.id)) byId.set(grant.id, grant)
  }
  const grants = Array.from(byId.values())
  return {
    version: snapshot.version,
    incompleteStores: snapshot.incompleteStores,
    grants,
    counts: {
      all: grants.length,
      global: grants.filter((grant) => grant.scopeKind === 'global').length,
      project: grants.filter((grant) => grant.scopeKind === 'project').length,
      session: grants.filter((grant) => grant.scopeKind === 'session').length
    }
  }
}

let latestLoadRequest = 0
let revokeRequestSequence = 0
const pendingRevocations = new Map<number, Set<string>>()

const pendingGrantIds = (): Set<string> =>
  new Set(Array.from(pendingRevocations.values()).flatMap((ids) => Array.from(ids)))

const withoutPendingRevocations = (snapshot: PermissionGrantSnapshot): PermissionGrantSnapshot => {
  const ids = pendingGrantIds()
  return ids.size === 0
    ? snapshot
    : withoutGrants(
        snapshot,
        snapshot.grants.filter((grant) => ids.has(grant.id))
      )
}

const applyAuthoritativeSnapshot = (
  state: PermissionGrantSnapshot,
  incoming: PermissionGrantSnapshot
): PermissionGrantSnapshot =>
  withoutPendingRevocations(incoming.version < state.version ? snapshotFromState(state) : incoming)

const allUndoItems = (state: Pick<PermissionGrantsStore, 'undo' | 'undoQueue'>): PermissionUndo[] =>
  [state.undo, ...state.undoQueue].filter((item): item is PermissionUndo => Boolean(item))

const undoItems = (state: Pick<PermissionGrantsStore, 'undo' | 'undoQueue'>): PermissionUndo[] =>
  allUndoItems(state).filter((item) => item.expiresAt > Date.now())

const withoutUndoToken = (
  state: Pick<PermissionGrantsStore, 'undo' | 'undoQueue'>,
  token: string
): Pick<PermissionGrantsStore, 'undo' | 'undoQueue'> =>
  nextUndoState(undoItems(state).filter((item) => item.token !== token))

const usePermissionGrantsStore = create<PermissionGrantsStore>((set, get) => ({
  ...EMPTY_SNAPSHOT,
  status: 'idle',
  undoQueue: [],
  isRestoring: false,

  load: async () => {
    const requestId = ++latestLoadRequest
    set({ status: 'loading', error: undefined })
    try {
      const snapshot = await window.api.permissions.list()
      if (requestId !== latestLoadRequest) return
      const normalized = {
        ...snapshot,
        version: snapshot.version ?? 0,
        incompleteStores: snapshot.incompleteStores ?? []
      }
      set((state) =>
        normalized.version < state.version
          ? { status: 'ready', error: undefined }
          : {
              ...withoutPendingRevocations(normalized),
              status: 'ready',
              error: undefined
            }
      )
    } catch (error) {
      if (requestId !== latestLoadRequest) return
      set({ status: 'error', error: errorMessage(error) })
    }
  },

  revoke: async (grants) => {
    if (grants.length === 0) return
    const requestId = ++revokeRequestSequence
    pendingRevocations.set(requestId, new Set(grants.map((grant) => grant.id)))
    const previous: PermissionGrantSnapshot = {
      version: get().version,
      incompleteStores: get().incompleteStores,
      grants: get().grants,
      counts: get().counts
    }
    set({ ...withoutGrants(previous, grants), error: undefined })
    try {
      const result = await window.api.permissions.revoke({
        grants: grants.map(({ id, revision }) => ({ id, revision }))
      })
      const revokedCount = result.receipt?.revokedCount ?? 0
      const conflictCount = result.conflicts.length
      const conflictIds = new Set(result.conflicts.map((conflict) => conflict.id))
      const revoked = grants.filter((grant) => !conflictIds.has(grant.id))
      const oneFamily = new Set(revoked.map((grant) => grant.family)).size === 1
      const message = `${
        revokedCount === 1
          ? `Revoked ${FAMILY_LABELS[revoked[0].family]} · ${revoked[0].capabilityLabel}`
          : `Revoked ${revokedCount} permissions${oneFamily && revoked[0] ? ` in ${FAMILY_LABELS[revoked[0].family]}` : ''}`
      }${conflictCount > 0 ? `; ${conflictCount} changed before it could be revoked` : ''}`
      pendingRevocations.delete(requestId)
      set((state) => {
        const current =
          state.undo?.expiresAt && state.undo.expiresAt > Date.now() ? state.undo : undefined
        const queued = state.undoQueue.filter((item) => item.expiresAt > Date.now())
        const next = result.receipt
          ? {
              token: result.receipt.undoToken,
              expiresAt: result.receipt.expiresAt,
              message
            }
          : undefined
        const authoritative = applyAuthoritativeSnapshot(state, {
          version: result.version ?? 0,
          incompleteStores: result.incompleteStores ?? [],
          grants: result.grants,
          counts: result.counts
        })
        return {
          ...authoritative,
          status: 'ready',
          error: undefined,
          undoQueue: current && next ? [...queued, next] : queued,
          undo: current ?? next,
          ...(revokedCount === 0 && conflictCount > 0
            ? { error: 'The selected permission changed before it could be revoked.' }
            : {})
        }
      })
    } catch (error) {
      pendingRevocations.delete(requestId)
      try {
        const snapshot = await window.api.permissions.list()
        set((state) => ({
          ...applyAuthoritativeSnapshot(state, {
            ...snapshot,
            version: snapshot.version ?? 0,
            incompleteStores: snapshot.incompleteStores ?? []
          }),
          status: 'error',
          error: errorMessage(error)
        }))
        return
      } catch {
        // If the authoritative refresh also fails, only roll back against the request's unchanged
        // starting version. A newer local snapshot may already reflect another actor's revoke.
      }
      set((state) => {
        const current: PermissionGrantSnapshot = {
          version: state.version,
          incompleteStores: state.incompleteStores,
          grants: state.grants,
          counts: state.counts
        }
        // A newer server snapshot already includes the authoritative outcome of any concurrent
        // mutation. Only merge this request's optimistic removals back while its starting version is
        // still current, otherwise a stale rollback can resurrect a grant another request revoked.
        const rollback =
          state.version === previous.version ? withRestoredGrants(current, grants) : current
        return {
          ...withoutPendingRevocations(rollback),
          status: 'error',
          error: errorMessage(error)
        }
      })
    }
  },

  extendUndo: async (token) => {
    const undo = allUndoItems(get()).find((item) => item.token === token)
    if (!undo || undo.canRestore === false) return undefined

    try {
      const receipt = await window.api.permissions.extendUndo({ undoToken: token })
      if (!receipt) {
        set((state) => withoutUndoToken(state, token))
        return undefined
      }
      set((state) =>
        nextUndoState(
          allUndoItems(state).map((item) =>
            item.token === token ? { ...item, expiresAt: receipt.expiresAt } : item
          )
        )
      )
      return receipt.expiresAt
    } catch {
      // A receipt that cannot be renewed must not remain as a visible but ineffective action.
      set((state) => withoutUndoToken(state, token))
      return undefined
    }
  },

  restore: async (token) => {
    const undo = undoItems(get()).find((item) => item.token === (token ?? get().undo?.token))
    if (!undo || undo.canRestore === false || undo.expiresAt <= Date.now()) {
      if (token) set((state) => withoutUndoToken(state, token))
      else set((state) => nextUndoState(state.undoQueue))
      return
    }
    set({ isRestoring: true, error: undefined })
    try {
      const result = await window.api.permissions.restore({ undoToken: undo.token })
      const targetUnavailable = result.conflicts.filter(
        (conflict) => conflict.reason === 'target-unavailable'
      ).length
      set((state) =>
        targetUnavailable > 0
          ? {
              ...applyAuthoritativeSnapshot(state, mutationState(result)),
              ...(() => {
                const items = undoItems(state).map((item) =>
                  item.token === undo.token
                    ? {
                        token: undo.token,
                        expiresAt: Date.now() + 5_000,
                        message: `Couldn't restore ${targetUnavailable === 1 ? 'permission' : `${targetUnavailable} permissions`}: owner no longer exists`,
                        canRestore: false
                      }
                    : item
                )
                return nextUndoState(items)
              })(),
              isRestoring: false
            }
          : {
              ...applyAuthoritativeSnapshot(state, mutationState(result)),
              ...withoutUndoToken(state, undo.token),
              status: 'ready',
              error: undefined,
              isRestoring: false
            }
      )
    } catch (error) {
      set((state) => {
        const items = undoItems(state).map((item) =>
          item.token === undo.token
            ? { ...undo, message: "Couldn't restore permission. Retry.", retry: true }
            : item
        )
        return {
          ...nextUndoState(items),
          status: 'error',
          error: errorMessage(error),
          isRestoring: false
        }
      })
    }
  },

  dismissUndo: (token) =>
    set((state) => (token ? withoutUndoToken(state, token) : nextUndoState(state.undoQueue))),

  listen: () => window.api.permissions?.onChanged?.(() => void get().load()) ?? (() => undefined)
}))

export { usePermissionGrantsStore }
export type { PermissionUndo }
