import { existsSync } from 'node:fs'
import { lstat, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import { isCurrentInFlight } from '../../shared/in-flight-promise'
import { createLogger } from '../logger'
import {
  operationJournalPath,
  readOperationChild,
  removeOperationChildSync,
  RuntimeOperationJournal,
  type RuntimeOperationRecord
} from './operation-journal'
import { micromambaCacheLockKey } from './micromamba-cache'
import {
  publishRecoveredMicromambaArchives,
  type WorkingCacheArchivePublication,
  type WorkingCacheFinalizationTarget
} from './windows-micromamba-working-cache'
import { defaultOperationChildLiveness, reconcileInterruptedOperations } from './operation-recovery'
import { verifyExecutable } from './provisioner-runtime'
import {
  addRepairRequired,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  legacyDefaultEnvPrefix,
  pythonBin,
  rBin,
  rReadyMarkerPath,
  readyMarkerPath
} from './runtime-paths'
import { NotebookRuntimeRepairPolicy } from './runtime-repair-policy'

const log = createLogger('notebook:recovery')

const isPathInside = (root: string, candidate: string): boolean => {
  const nested = relative(root, candidate)
  return nested !== '' && !isAbsolute(nested) && nested !== '..' && !nested.startsWith(`..${sep}`)
}

const isDirectChild = (root: string, candidate: string): boolean =>
  isPathInside(root, candidate) && !relative(root, candidate).includes(sep)

export type NotebookRecoveryReadiness =
  'not-started' | 'recovering' | 'ready' | 'failed' | 'disposed'

export type NotebookRecoverySnapshot = {
  readiness: NotebookRecoveryReadiness
  blockedPrefixes: string[]
  blockedRuntimeIds: string[]
  liveUnconfirmedPrefixes: string[]
  liveUnconfirmedRuntimeIds: string[]
  corruptJournal: boolean
  lastFailure?: Error
}

type NotebookRecoveryCoordinatorDeps = {
  finalizeWorkingCache?: (
    runtimeRoot: string,
    target: WorkingCacheFinalizationTarget
  ) => Promise<boolean>
  publishWorkingCacheArchives?: (
    runtimeRoot: string,
    publications: readonly WorkingCacheArchivePublication[]
  ) => Promise<void>
  workingCacheKey?: (path: string) => string
}

export class NotebookRecoveryCoordinator {
  private recoveryComplete: Promise<void> | undefined
  private recoveryInFlight: Promise<void> | undefined
  private readiness: NotebookRecoveryReadiness = 'not-started'
  private lastFailure: Error | undefined
  private readonly blockedPrefixes = new Set<string>()
  private readonly blockedRuntimeIds = new Set<string>()
  private readonly startupBlockedPrefixes = new Set<string>()
  private readonly startupBlockedRuntimeIds = new Set<string>()
  private readonly corruptResetAllowlist = new Set<string>()
  private readonly liveUnconfirmedPrefixes = new Set<string>()
  private readonly liveUnconfirmedRuntimeIds = new Set<string>()
  private recoveryCorrupt = false
  private disposed = false

  constructor(
    private readonly runtimeRoot: string,
    private readonly repairPolicy: Pick<
      NotebookRuntimeRepairPolicy,
      'recoveryMarker'
    > = new NotebookRuntimeRepairPolicy(runtimeRoot),
    private readonly deps: NotebookRecoveryCoordinatorDeps = {}
  ) {}

  async recover(): Promise<void> {
    if (this.disposed) throw new Error('Notebook recovery coordinator is disposed.')
    if (this.recoveryInFlight) {
      await this.recoveryInFlight
      return
    }

    this.readiness = 'recovering'
    this.lastFailure = undefined
    const run = this.reconcile()
    this.recoveryInFlight = run
    this.recoveryComplete = run.then(
      () => undefined,
      () => undefined
    )
    try {
      await run
      if (!this.disposed) this.readiness = 'ready'
    } catch (error) {
      this.lastFailure = error instanceof Error ? error : new Error(String(error))
      if (!this.disposed) this.readiness = 'failed'
      throw error
    } finally {
      if (isCurrentInFlight(this.recoveryInFlight, run)) this.recoveryInFlight = undefined
    }
  }

  async ensureReady(): Promise<void> {
    if (this.disposed) throw new Error('Notebook recovery coordinator is disposed.')
    if (this.recoveryComplete) await this.recoveryComplete
    if (
      this.startupBlockedPrefixes.size > 0 ||
      this.startupBlockedRuntimeIds.size > 0 ||
      this.recoveryCorrupt
    ) {
      await this.recover()
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.readiness = 'disposed'
    await this.recoveryInFlight?.catch(() => undefined)
  }

  snapshot(): NotebookRecoverySnapshot {
    return {
      readiness: this.readiness,
      blockedPrefixes: Array.from(this.blockedPrefixes).sort(),
      blockedRuntimeIds: Array.from(this.blockedRuntimeIds).sort(),
      liveUnconfirmedPrefixes: Array.from(this.liveUnconfirmedPrefixes).sort(),
      liveUnconfirmedRuntimeIds: Array.from(this.liveUnconfirmedRuntimeIds).sort(),
      corruptJournal: this.recoveryCorrupt,
      lastFailure: this.lastFailure
    }
  }

  isPrefixBlocked(prefix: string): boolean {
    if (this.disposed || this.blockedPrefixes.has(prefix)) return true
    return this.recoveryCorrupt && !this.corruptResetAllowlist.has(prefix)
  }

  isRuntimeIdBlocked(runtimeId: string): boolean {
    return this.disposed || this.blockedRuntimeIds.has(runtimeId)
  }

  isGloballyBlocked(): boolean {
    return this.disposed || this.recoveryCorrupt
  }

  clearPrefixBlock(prefix: string): void {
    this.blockedPrefixes.delete(prefix)
    this.startupBlockedPrefixes.delete(prefix)
  }

  clearRuntimeBlock(runtimeId: string): void {
    this.blockedRuntimeIds.delete(runtimeId)
    this.startupBlockedRuntimeIds.delete(runtimeId)
  }

  allowCorruptReset(prefix: string): void {
    this.corruptResetAllowlist.add(prefix)
  }

  markLiveUnconfirmed(prefix: string, runtimeId?: string): void {
    this.blockedPrefixes.add(prefix)
    this.liveUnconfirmedPrefixes.add(prefix)
    if (runtimeId) {
      this.blockedRuntimeIds.add(runtimeId)
      this.liveUnconfirmedRuntimeIds.add(runtimeId)
    }
  }

  markRuntimeLiveUnconfirmed(runtimeId: string): void {
    this.blockedRuntimeIds.add(runtimeId)
    this.liveUnconfirmedRuntimeIds.add(runtimeId)
  }

  isPrefixLiveUnconfirmed(prefix: string): boolean {
    return this.liveUnconfirmedPrefixes.has(prefix)
  }

  private async reconcile(): Promise<void> {
    const nextStartupBlockedPrefixes = new Set<string>()
    const nextStartupBlockedRuntimeIds = new Set<string>()
    const publishedArchiveRecords: RuntimeOperationRecord[] = []
    let recoveryIncomplete = false

    await rm(join(this.runtimeRoot, 'packs', '.cache'), { recursive: true, force: true }).catch(
      () => undefined
    )
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(this.runtimeRoot))
    if ((await journal.readState()) === 'corrupt') {
      log.error('operation journal is unreadable; blocking all runtime writes until recovery')
      this.recoveryCorrupt = true
      return
    }

    const validatedRemovalTargets = (
      record: RuntimeOperationRecord
    ): { prefix: string; targets: string[] } => {
      const language =
        record.runtimeId === DEFAULT_R_ENV
          ? 'r'
          : record.runtimeId === DEFAULT_PY_ENV
            ? 'python'
            : undefined
      if (!language) throw new Error('Interrupted Runtime removal has an unknown target.')
      const environmentName = language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV
      const expectedMarker =
        language === 'r' ? rReadyMarkerPath(this.runtimeRoot) : readyMarkerPath(this.runtimeRoot)
      const allowedPrefixes = new Set([
        envPrefix(this.runtimeRoot, environmentName),
        legacyDefaultEnvPrefix(this.runtimeRoot, environmentName)
      ])
      const targets = record.targetPaths ?? []
      const recordedPrefixes = targets.filter((target) => allowedPrefixes.has(target))
      if (
        targets.length !== 2 ||
        new Set(targets).size !== 2 ||
        !targets.includes(expectedMarker) ||
        recordedPrefixes.length !== 1
      ) {
        throw new Error('Interrupted Runtime removal contains an unsafe filesystem target.')
      }
      return { prefix: recordedPrefixes[0], targets }
    }

    const reconciled = await reconcileInterruptedOperations(journal, {
      operationChildLiveness: defaultOperationChildLiveness,
      hydrateInterruptedChild: (record) => {
        const state = readOperationChild(this.runtimeRoot, record.operationId)
        if (state === undefined) return record
        if (state === 'corrupt' || 'spawning' in state) {
          return {
            ...record,
            childPid: undefined,
            childStartedAt: undefined,
            childStartToken: undefined,
            spawnAttempted: true
          }
        }
        return { ...record, ...state }
      },
      cleanStaging: async (record) => {
        if (record.targetPath) await rm(record.targetPath, { recursive: true, force: true })
      },
      verifyOrRebuildEnv: async (record) => {
        const targetPath = record.targetPath
        if (!targetPath) return
        const rejectUnsafe = (message: string): never => {
          nextStartupBlockedPrefixes.add(targetPath)
          nextStartupBlockedRuntimeIds.add(record.runtimeId)
          throw new Error(message)
        }
        const envsRoot = join(this.runtimeRoot, 'envs')
        if (!isDirectChild(envsRoot, targetPath)) {
          rejectUnsafe('Interrupted environment target is outside the managed runtime root.')
        }
        const targetStat = await lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined
          return rejectUnsafe('Interrupted environment target could not be validated.')
        })
        if (!targetStat) return
        if (targetStat.isSymbolicLink()) {
          rejectUnsafe('Interrupted environment target must not be a symbolic link.')
        }
        const [canonicalRuntimeRoot, canonicalEnvsRoot, canonicalPrefix] = await Promise.all([
          realpath(this.runtimeRoot),
          realpath(envsRoot),
          realpath(targetPath)
        ]).catch(() => rejectUnsafe('Interrupted environment paths could not be validated.'))
        if (
          canonicalEnvsRoot !== join(canonicalRuntimeRoot, 'envs') ||
          !isDirectChild(canonicalEnvsRoot, canonicalPrefix)
        ) {
          rejectUnsafe('Interrupted environment target escapes the managed runtime root.')
        }
        const language =
          record.phase.endsWith('-r') ||
          (record.phase === 'restore' && record.runtimeId === DEFAULT_R_ENV)
            ? 'r'
            : record.phase.endsWith('-python') ||
                (record.phase === 'restore' && record.runtimeId === DEFAULT_PY_ENV)
              ? 'python'
              : undefined
        const expectedBin =
          language === 'r'
            ? rBin(targetPath)
            : language === 'python'
              ? pythonBin(targetPath)
              : undefined
        const bin = expectedBin
          ? existsSync(expectedBin)
            ? expectedBin
            : undefined
          : [pythonBin(targetPath), rBin(targetPath)].find((candidate) => existsSync(candidate))
        if (existsSync(join(targetPath, 'conda-meta')) && bin) {
          const canonicalBin = await realpath(bin).catch(() =>
            rejectUnsafe('Interrupted environment executable could not be validated.')
          )
          if (!isPathInside(canonicalPrefix, canonicalBin)) {
            rejectUnsafe('Interrupted environment executable escapes the managed runtime root.')
          }
          try {
            await verifyExecutable(canonicalBin, { prefix: canonicalPrefix })
            return
          } catch {
            // An interrupted mutation can leave an interpreter file before the prefix is runnable.
          }
        }
        await rm(canonicalPrefix, { recursive: true, force: true })
      },
      markRepairRequired: async (record) => {
        if (!record.runtimeId) return
        const marker = this.repairPolicy.recoveryMarker(record)
        addRepairRequired(this.runtimeRoot, marker.key, marker.reason)
      },
      removeTargets: async (record) => {
        const { targets } = validatedRemovalTargets(record)
        for (const target of targets) await rm(target, { recursive: true, force: true })
      },
      blockUnknownChildTarget: async (record) => {
        if (record.kind === 'install') nextStartupBlockedRuntimeIds.add(record.runtimeId)
        if (record.targetPath) nextStartupBlockedPrefixes.add(record.targetPath)
      },
      publishArchives: async (record) => {
        const publish = this.deps.publishWorkingCacheArchives ?? publishRecoveredMicromambaArchives
        await publish(this.runtimeRoot, record.archivePublications ?? [])
        publishedArchiveRecords.push(record)
      },
      deferArchiveCompletion: true,
      onRetained: (record) => {
        if (record.kind === 'remove') {
          try {
            // The delete may have succeeded before journal completion failed. Keep this exact prefix
            // blocked so no new provision can be recreated under a stale remove intent that recovery
            // will replay on the next attempt.
            nextStartupBlockedPrefixes.add(validatedRemovalTargets(record).prefix)
          } catch {
            // Unsafe remove records remain retained, but never turn an unvalidated path into authority.
          }
        }
        recoveryIncomplete = true
      }
    })

    for (const prefix of this.startupBlockedPrefixes) {
      if (!nextStartupBlockedPrefixes.has(prefix) && !this.liveUnconfirmedPrefixes.has(prefix)) {
        this.blockedPrefixes.delete(prefix)
      }
    }
    for (const runtimeId of this.startupBlockedRuntimeIds) {
      if (
        !nextStartupBlockedRuntimeIds.has(runtimeId) &&
        !this.liveUnconfirmedRuntimeIds.has(runtimeId)
      ) {
        this.blockedRuntimeIds.delete(runtimeId)
      }
    }
    this.startupBlockedPrefixes.clear()
    this.startupBlockedRuntimeIds.clear()
    for (const prefix of nextStartupBlockedPrefixes) {
      this.startupBlockedPrefixes.add(prefix)
      this.blockedPrefixes.add(prefix)
    }
    for (const runtimeId of nextStartupBlockedRuntimeIds) {
      this.startupBlockedRuntimeIds.add(runtimeId)
      this.blockedRuntimeIds.add(runtimeId)
    }
    this.recoveryCorrupt = false
    this.corruptResetAllowlist.clear()

    for (const record of reconciled) {
      if (!record.archivePublications) {
        removeOperationChildSync(this.runtimeRoot, record.operationId)
      }
    }
    const retainedState = await journal.readState()
    const finalizedWorkingRootKeys = new Set<string>()
    const workingCacheKey = this.deps.workingCacheKey ?? micromambaCacheLockKey
    if (
      retainedState !== 'corrupt' &&
      !retainedState.records.some((record) => record.archivePublicationPending === true)
    ) {
      const publishedOperationIds = new Set(
        publishedArchiveRecords.map((record) => record.operationId)
      )
      const retainedWorkingRootKeys = new Set(
        retainedState.records.flatMap((record) =>
          publishedOperationIds.has(record.operationId)
            ? []
            : (record.archivePublications?.map((publication) =>
                workingCacheKey(publication.workingRoot)
              ) ?? [])
        )
      )
      const publishedWorkingRoots = new Map<string, string>()
      for (const record of publishedArchiveRecords) {
        for (const publication of record.archivePublications ?? []) {
          const key = workingCacheKey(publication.workingRoot)
          if (!retainedWorkingRootKeys.has(key))
            publishedWorkingRoots.set(key, publication.workingRoot)
        }
      }
      for (const [key, workingRoot] of publishedWorkingRoots) {
        const finalized = this.deps.finalizeWorkingCache
          ? await this.deps.finalizeWorkingCache(this.runtimeRoot, {
              mode: 'exact',
              workingRoots: [workingRoot]
            })
          : true
        if (finalized) {
          finalizedWorkingRootKeys.add(key)
        }
      }
      for (const record of publishedArchiveRecords) {
        const recordKeys = (record.archivePublications ?? []).map((publication) =>
          workingCacheKey(publication.workingRoot)
        )
        if (recordKeys.every((key) => finalizedWorkingRootKeys.has(key))) {
          await journal.complete(record.operationId)
          removeOperationChildSync(this.runtimeRoot, record.operationId)
        } else {
          recoveryIncomplete = true
        }
      }
    } else if (retainedState === 'corrupt') {
      recoveryIncomplete = true
      this.recoveryCorrupt = true
    }
    if (
      nextStartupBlockedPrefixes.size === 0 &&
      nextStartupBlockedRuntimeIds.size === 0 &&
      !recoveryIncomplete
    ) {
      await this.deps.finalizeWorkingCache?.(this.runtimeRoot, { mode: 'current-candidates' })
    }
  }
}
