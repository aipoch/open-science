import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  operationJournalPath,
  readOperationChild,
  removeOperationChildSync,
  RuntimeOperationJournal
} from './operation-journal'
import { defaultOperationChildLiveness, reconcileInterruptedOperations } from './operation-recovery'
import { verifyExecutable } from './provisioner-runtime'
import { addRepairRequired, pythonBin, rBin } from './runtime-paths'
import { NotebookRuntimeRepairPolicy } from './runtime-repair-policy'

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
    > = new NotebookRuntimeRepairPolicy(runtimeRoot)
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
      if (this.recoveryInFlight === run) this.recoveryInFlight = undefined
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

    await rm(join(this.runtimeRoot, 'packs', '.cache'), { recursive: true, force: true }).catch(
      () => undefined
    )
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(this.runtimeRoot))
    if ((await journal.readState()) === 'corrupt') {
      console.error(
        '[notebook] operation journal is unreadable; blocking all runtime writes until recovery'
      )
      this.recoveryCorrupt = true
      return
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
        if (!record.targetPath || !existsSync(record.targetPath)) return
        const bin = [pythonBin(record.targetPath), rBin(record.targetPath)].find((candidate) =>
          existsSync(candidate)
        )
        if (existsSync(join(record.targetPath, 'conda-meta')) && bin) {
          try {
            await verifyExecutable(bin, { prefix: record.targetPath })
            return
          } catch {
            // An interrupted mutation can leave an interpreter file before the prefix is runnable.
          }
        }
        await rm(record.targetPath, { recursive: true, force: true })
      },
      markRepairRequired: async (record) => {
        if (!record.runtimeId) return
        const marker = this.repairPolicy.recoveryMarker(record)
        addRepairRequired(this.runtimeRoot, marker.key, marker.reason)
      },
      blockUnknownChildTarget: async (record) => {
        if (record.kind === 'install') nextStartupBlockedRuntimeIds.add(record.runtimeId)
        if (record.targetPath) nextStartupBlockedPrefixes.add(record.targetPath)
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

    for (const record of reconciled) removeOperationChildSync(this.runtimeRoot, record.operationId)
  }
}
