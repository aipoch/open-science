import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import {
  sessionRevision,
  type PersistedChatSession,
  type SessionSummary
} from '../../shared/session-persistence'
import type { PreparedSessionRecovery, RecoveredSessionReference } from './coordinator'
export type { RecoveredSessionReference } from './coordinator'

type RecoveryDependencies = {
  list(): Promise<readonly SessionSummary[]>
  prepare(projectId: string, sessionId: string): Promise<PreparedSessionRecovery | undefined>
  missing(projectId: string, sessionId: string): Promise<boolean>
  commit(prepared: PreparedSessionRecovery): Promise<PersistedChatSession | undefined>
  recovered(session: PersistedChatSession): Promise<PersistedChatSession>
  complete(sessions: readonly RecoveredSessionReference[], cancelled: () => boolean): Promise<void>
}

// One process-local sweep. Durable JSON/projection evidence reconstructs work on restart.
// Only one candidate body is retained, and no future Session lane is reserved in advance.
export class DeferredSessionRecovery {
  private stopped = false
  private task: Promise<void> | undefined
  private cancelWait: (() => void) | undefined
  private commit: Promise<unknown> | undefined
  private readonly log = createLogger('session-persistence')

  constructor(private readonly dependencies: RecoveryDependencies) {}

  start(): void {
    this.task ??= this.run().catch((error) => {
      this.log.warn('deferred Session recovery stopped', {
        ...diagnosticErrorFields(error),
        mode: 'background',
        status: 'failed'
      })
    })
  }

  settled(): Promise<void> {
    return this.task ?? Promise.resolve()
  }

  async dispose(): Promise<void> {
    this.stopped = true
    this.cancelWait?.()
    // A primary snapshot can finish later; it will not be allowed to submit a commit.
    // Already admitted effects must finish their existing durable boundary.
    await this.commit?.catch(() => undefined)
  }

  private yield(delay = 0): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        this.cancelWait = undefined
        resolve()
      }
      const timer = setTimeout(finish, delay)
      timer.unref?.()
      this.cancelWait = finish
    })
  }

  private async run(): Promise<void> {
    await this.yield()
    if (this.stopped) return
    const summaries = await this.dependencies.list()
    const pending = [...summaries]
      .sort((left, right) => Number(right.needsStartupRecovery) - Number(left.needsStartupRecovery))
      .map(({ projectId, id }) => ({ projectId, id, attempts: 0, readyAt: 0 }))
    const references: RecoveredSessionReference[] = []
    let exhausted = 0
    let confirmedMissing = 0
    while (pending.length && !this.stopped) {
      pending.sort((left, right) => left.readyAt - right.readyAt)
      const candidate = pending.shift()!
      await this.yield(Math.max(0, candidate.readyAt - Date.now()))
      if (this.stopped) return
      const startedAt = performance.now()
      candidate.attempts += 1
      let phase = 'prepare'
      try {
        const prepared = await this.dependencies.prepare(candidate.projectId, candidate.id)
        const prepareMs = performance.now() - startedAt
        if (this.stopped) return
        if (!prepared) {
          phase = 'confirm-missing'
          const missing = this.dependencies.missing(candidate.projectId, candidate.id)
          this.commit = missing
          if (await missing) confirmedMissing += 1
          this.commit = undefined
          continue
        }
        // Foreground operations queued while reading enter their lane before this commit.
        await this.yield()
        if (this.stopped) return
        phase = 'commit'
        const commitStartedAt = performance.now()
        const commit = this.dependencies.commit(prepared)
        this.commit = commit
        let session = await commit
        const commitMs = performance.now() - commitStartedAt
        this.commit = undefined
        if (this.stopped) return
        if (!session) {
          phase = 'confirm-missing'
          const missing = this.dependencies.missing(candidate.projectId, candidate.id)
          this.commit = missing
          if (await missing) confirmedMissing += 1
          this.commit = undefined
          continue
        }
        phase = 'recover-derived-state'
        const recovered = this.dependencies.recovered(session)
        this.commit = recovered
        session = await recovered
        this.commit = undefined
        if (this.stopped) return
        const { id, projectId, cwd, updatedAt, archivedAt } = session
        references.push({
          id,
          projectId,
          cwd,
          revision: sessionRevision(session),
          updatedAt,
          archivedAt
        })
        this.log.debug('deferred Session recovered', {
          mode: 'background',
          projectId: candidate.projectId,
          sessionId: candidate.id,
          attempt: candidate.attempts,
          durationMs: performance.now() - startedAt,
          prepareMs,
          commitMs,
          ...prepared.metrics,
          planningMs: Math.max(
            0,
            prepareMs -
              (prepared.metrics?.authorityReadMs ?? 0) -
              (prepared.metrics?.jsonParseMs ?? 0)
          )
        })
      } catch (error) {
        this.commit = undefined
        if (this.stopped) return
        const retry = candidate.attempts < 3
        const retryDelayMs = retry ? (candidate.attempts === 1 ? 250 : 1000) : 0
        this.log.warn('deferred Session recovery failed', {
          ...diagnosticErrorFields(error),
          mode: 'background',
          projectId: candidate.projectId,
          sessionId: candidate.id,
          phase,
          attempt: candidate.attempts,
          retry,
          retryDelayMs,
          exhausted: !retry,
          durationMs: performance.now() - startedAt
        })
        if (retry) {
          candidate.readyAt = Date.now() + retryDelayMs
          pending.push(candidate)
        } else exhausted += 1
      }
    }
    if (this.stopped) return
    const unresolvedCount = summaries.length - references.length - confirmedMissing
    const cleanupEligible = !exhausted && unresolvedCount === 0
    // Only successfully recovered or durably confirmed missing entries permit complete cleanup.
    if (cleanupEligible) {
      await this.yield()
      if (this.stopped) return
      this.commit = this.dependencies.complete(references, () => this.stopped)
      await this.commit
      this.commit = undefined
    }
    this.log.info('deferred Session recovery completed', {
      mode: 'background',
      status: cleanupEligible ? 'complete' : 'partial',
      sessionCount: summaries.length,
      recoveredCount: references.length,
      exhaustedCount: exhausted,
      missingCount: confirmedMissing,
      unresolvedCount,
      cleanupEligible,
      cleanupSkippedReason: exhausted
        ? 'retries-exhausted'
        : unresolvedCount
          ? 'unconfirmed-missing'
          : undefined
    })
  }
}
