import { existsSync, lstatSync } from 'node:fs'

import {
  publishMicromambaArchives,
  type MicromambaArchiveAuthorization
} from './micromamba-archive-store'
import {
  isTrustedMicromambaWorkingCacheForRoot,
  micromambaCacheLockKey,
  micromambaWorkingCachePaths,
  removeMicromambaCacheForRoot,
  removeTrustedMicromambaWorkingCacheForRoot,
  type MicromambaCacheDeps
} from './micromamba-cache'
import {
  operationJournalPath,
  RuntimeOperationJournal,
  type RuntimeArchivePublication
} from './operation-journal'
import { pkgsCache } from './runtime-paths'

export type WorkingCacheArchivePublication = RuntimeArchivePublication

export type WorkingCacheReleaseOptions = {
  archivePublications?: readonly WorkingCacheArchivePublication[]
  completedOperationId?: string
  retainForRecovery?: boolean
}

export type WorkingCacheFinalizationTarget =
  { mode: 'current-candidates' } | { mode: 'exact'; workingRoots: readonly string[] }

export type MicromambaWorkingCacheLease = (options: WorkingCacheReleaseOptions) => Promise<boolean>
export type MicromambaWorkingCacheRetainer = (
  root: string,
  operationId?: string
) => MicromambaWorkingCacheLease | Promise<MicromambaWorkingCacheLease>

type ManagedNotebookWorkingCache = Readonly<{
  finalizeWorkingCache?: (root: string, target: WorkingCacheFinalizationTarget) => Promise<boolean>
  retainWorkingCache?: MicromambaWorkingCacheRetainer
}>

type WorkingCacheLeaseDeps = Pick<
  MicromambaCacheDeps,
  'platform' | 'canonicalize' | 'env' | 'exists'
> & {
  publishArchives?: typeof publishMicromambaArchives
  cleanup?: (root: string) => boolean | void
  requiresRecoveryRetention?: (
    root: string,
    completedOperationIds: ReadonlySet<string>
  ) => Promise<boolean>
  cleanupExact?: (root: string, workingRoot: string) => boolean
  workingRootState?: (path: string) => 'present' | 'absent' | 'unknown'
}

type ActiveWorkingCache = {
  leases: number
  operationIds: Set<string>
  completedOperationIds: Set<string>
  archivePublications: Map<
    string,
    { workingRoot: string; authorizations: Map<string, MicromambaArchiveAuthorization> }
  >
  finalization?: Promise<boolean>
  completion: Promise<boolean>
  resolveCompletion: (completed: boolean) => void
}

const activeWorkingCaches = new Map<string, ActiveWorkingCache>()
// Recovery retention protects the shared on-disk cache for the rest of this process, but is not part
// of a later lease's publication result. A later operation may publish its own verified archives and
// complete its journal while cleanup remains deferred until startup recovery reconciles the old writer.
const recoveryRetainedWorkingCaches = new Set<string>()

const completionSignal = (): Pick<ActiveWorkingCache, 'completion' | 'resolveCompletion'> => {
  let resolveCompletion!: (completed: boolean) => void
  const completion = new Promise<boolean>((resolve) => {
    resolveCompletion = resolve
  })
  return { completion, resolveCompletion }
}

const cleanupWorkingCache = (root: string): boolean => removeMicromambaCacheForRoot(root)

const hasDurableRecoveryRetention = async (
  root: string,
  completedOperationIds: ReadonlySet<string>
): Promise<boolean> => {
  const state = await RuntimeOperationJournal.forPath(operationJournalPath(root)).readState()
  if (state === 'corrupt') return true
  return state.records.some(
    (record) =>
      record.archivePublicationPending === true ||
      (record.archivePublications !== undefined && !completedOperationIds.has(record.operationId))
  )
}

const hasRecoveredArchivePublications = async (
  root: string,
  operationId: string | undefined,
  activeOperationIds: ReadonlySet<string>
): Promise<boolean> => {
  const state = await RuntimeOperationJournal.forPath(operationJournalPath(root)).readState()
  if (state === 'corrupt') return true
  return state.records.some(
    (record) =>
      (record.archivePublicationPending === true || record.archivePublications !== undefined) &&
      record.operationId !== operationId &&
      !activeOperationIds.has(record.operationId)
  )
}

const publishWorkingArchives = (
  root: string,
  workingRoot: string,
  authorizations: readonly MicromambaArchiveAuthorization[],
  deps: WorkingCacheLeaseDeps
): Promise<number> => {
  if (deps.publishArchives) return deps.publishArchives(root, workingRoot, authorizations)
  return publishMicromambaArchives(
    root,
    workingRoot,
    authorizations,
    micromambaCacheLockKey(pkgsCache(root), deps),
    () => isTrustedMicromambaWorkingCacheForRoot(root, workingRoot, deps)
  )
}

export const retainMicromambaWorkingCache = async (
  root: string,
  deps: WorkingCacheLeaseDeps = {},
  operationId?: string
): Promise<MicromambaWorkingCacheLease> => {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return async () => true
  const key = micromambaCacheLockKey(root, deps)
  let active: ActiveWorkingCache
  while (true) {
    const existing = activeWorkingCaches.get(key)
    if (existing?.finalization) {
      await existing.finalization.catch(() => false)
      continue
    }
    if (
      await hasRecoveredArchivePublications(root, operationId, existing?.operationIds ?? new Set())
    ) {
      throw new Error(
        'RUNTIME_CACHE_RECOVERY_BLOCKED: verified package archives are still awaiting recovery publication'
      )
    }
    if (activeWorkingCaches.get(key) !== existing || existing?.finalization) continue
    active =
      existing ??
      ({
        leases: 0,
        operationIds: new Set(),
        completedOperationIds: new Set(),
        archivePublications: new Map(),
        ...completionSignal()
      } satisfies ActiveWorkingCache)
    if (existing && existing.leases === 0) Object.assign(active, completionSignal())
    active.leases += 1
    if (operationId) active.operationIds.add(operationId)
    activeWorkingCaches.set(key, active)
    break
  }
  let released = false

  return async ({
    archivePublications = [],
    completedOperationId,
    retainForRecovery = false
  }): Promise<boolean> => {
    if (released) return false
    released = true
    if (operationId) active.operationIds.delete(operationId)
    if (completedOperationId) active.completedOperationIds.add(completedOperationId)
    if (retainForRecovery) {
      recoveryRetainedWorkingCaches.add(key)
    } else {
      for (const publication of archivePublications) {
        if (publication.authorizations.length === 0) continue
        const publicationKey = micromambaCacheLockKey(publication.workingRoot, deps)
        const collected = active.archivePublications.get(publicationKey) ?? {
          workingRoot: publication.workingRoot,
          authorizations: new Map<string, MicromambaArchiveAuthorization>()
        }
        for (const authorization of publication.authorizations) {
          const key = `${authorization.file}\0${authorization.algorithm}\0${authorization.digest}`
          collected.authorizations.set(key, authorization)
        }
        active.archivePublications.set(publicationKey, collected)
      }
    }
    active.leases -= 1
    if (active.leases > 0) return retainForRecovery ? false : active.completion
    let publicationFailed = false
    const finalization = Promise.resolve().then(async (): Promise<boolean> => {
      try {
        if (active.archivePublications.size > 0) {
          try {
            for (const publication of active.archivePublications.values()) {
              await publishWorkingArchives(
                root,
                publication.workingRoot,
                [...publication.authorizations.values()],
                deps
              )
            }
          } catch {
            // Preserve the working cache when durable publication fails; a later operation can retry.
            publicationFailed = true
            active.resolveCompletion(false)
            return false
          }
        }
        const durableRetention = await (
          deps.requiresRecoveryRetention ?? hasDurableRecoveryRetention
        )(root, active.completedOperationIds)
        if (!recoveryRetainedWorkingCaches.has(key) && !durableRetention) {
          const cleanupCompleted = (deps.cleanup ?? cleanupWorkingCache)(root)
          if (cleanupCompleted === false) {
            publicationFailed = true
            active.resolveCompletion(false)
            return false
          }
        }
        active.resolveCompletion(true)
        return true
      } catch {
        publicationFailed = true
        active.resolveCompletion(false)
        return false
      } finally {
        if (activeWorkingCaches.get(key) === active) {
          active.finalization = undefined
          if (!publicationFailed) activeWorkingCaches.delete(key)
        }
      }
    })
    active.finalization = finalization
    const completed = await finalization
    return retainForRecovery ? false : completed
  }
}

export const publishRecoveredMicromambaArchives = async (
  root: string,
  archivePublications: readonly WorkingCacheArchivePublication[],
  deps: WorkingCacheLeaseDeps = {}
): Promise<void> => {
  for (const publication of archivePublications) {
    await publishWorkingArchives(root, publication.workingRoot, publication.authorizations, deps)
  }
}

// On Windows, a hard app exit loses the in-memory lease but leaves the marker-owned working cache. Startup recovery
// calls this only after every interrupted writer has been reconciled. Avoid selectMicromambaCache when
// the expected path is absent because selection intentionally creates and hardens the working folder.
export const finalizeRecoveredMicromambaWorkingCache = async (
  root: string,
  deps: WorkingCacheLeaseDeps & { exists?: (path: string) => boolean },
  target: WorkingCacheFinalizationTarget
): Promise<boolean> => {
  const recoveredWorkingRoots = target.mode === 'exact' ? target.workingRoots : []
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    if (recoveredWorkingRoots.length === 0) return false
    const durableKey = micromambaCacheLockKey(pkgsCache(root), { ...deps, platform })
    return recoveredWorkingRoots.every(
      (workingRoot) => micromambaCacheLockKey(workingRoot, { ...deps, platform }) === durableKey
    )
  }
  let recoveredComplete = recoveredWorkingRoots.length > 0
  const workingRootState =
    deps.workingRootState ??
    (deps.exists
      ? (path: string) => (deps.exists?.(path) ? ('present' as const) : ('absent' as const))
      : (path: string) => {
          try {
            lstatSync(path)
            return 'present' as const
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? ('absent' as const)
              : ('unknown' as const)
          }
        })
  for (const workingRoot of new Set(recoveredWorkingRoots)) {
    const state = workingRootState(workingRoot)
    if (state === 'unknown') {
      recoveredComplete = false
      continue
    }
    if (state === 'absent') continue
    recoveredComplete =
      (deps.cleanupExact ?? removeTrustedMicromambaWorkingCacheForRoot)(root, workingRoot) &&
      recoveredComplete
  }
  if (target.mode === 'exact') return recoveredComplete
  let expectedPaths: string[]
  try {
    expectedPaths = micromambaWorkingCachePaths(root, deps)
  } catch {
    return recoveredComplete
  }
  const exists = deps.exists ?? existsSync
  if (!expectedPaths.some((path) => exists(path))) return recoveredComplete

  // A crash loses the in-memory transaction/lock authorization. The working cache is disposable, so
  // never reconstruct trust from notebook-writable environment metadata during startup recovery.
  const key = micromambaCacheLockKey(root, deps)
  activeWorkingCaches.delete(key)
  recoveryRetainedWorkingCaches.delete(key)
  return (deps.cleanup ?? cleanupWorkingCache)(root) !== false
}

export const managedNotebookWorkingCache = (
  platform: NodeJS.Platform = process.platform,
  enabled = true
): ManagedNotebookWorkingCache => {
  const archiveCacheEnabled = enabled && platform === 'win32'
  return {
    finalizeWorkingCache: archiveCacheEnabled
      ? (root: string, target: WorkingCacheFinalizationTarget) =>
          finalizeRecoveredMicromambaWorkingCache(root, { platform }, target)
      : undefined,
    retainWorkingCache: archiveCacheEnabled
      ? (root: string, operationId?: string) =>
          retainMicromambaWorkingCache(root, { platform }, operationId)
      : undefined
  }
}
