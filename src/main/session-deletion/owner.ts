import type { AcpRuntimeState } from '../../shared/acp'
import {
  SessionDeletionCommittedError,
  type DeleteSessionRequest,
  type SessionDeletionResult
} from '../../shared/session-persistence'
import { createLogger, diagnosticErrorFields, type Logger } from '../logger'

type SessionDeletionRuntime = {
  deleteSession(request: { sessionId: string }): Promise<AcpRuntimeState>
  liveSessionProjectId(sessionId: string): string | undefined
}

type SessionDeletionPersistence = {
  deleteSession(request: DeleteSessionRequest): Promise<void>
}

type SessionDeletionBackgroundResults = {
  prepareSessionDeletion(projectId: string, sessionId: string): Promise<void>
  commitSessionDeletion(projectId: string, sessionId: string): Promise<void>
  abortSessionDeletion(projectId: string, sessionId: string): Promise<void>
}

type SessionDeletionOwnerOptions = {
  runtime: SessionDeletionRuntime
  persistence: SessionDeletionPersistence
  backgroundResults?: SessionDeletionBackgroundResults
  withStoppedWork?: (
    request: DeleteSessionRequest,
    operation: () => Promise<SessionDeletionResult>
  ) => Promise<SessionDeletionResult>
  log?: Pick<Logger, 'warn'>
}

type ActiveSessionDeletion = {
  projectId: string
  promise: Promise<SessionDeletionResult>
}

// Owns terminal Session deletion across runtime and durable persistence. Callers submit one intent;
// ordering, retry-safe runtime absence, project identity checks, and concurrent dedup stay inside.
class SessionDeletionOwner {
  private readonly runtime: SessionDeletionRuntime
  private readonly persistence: SessionDeletionPersistence
  private readonly backgroundResults: SessionDeletionBackgroundResults | undefined
  private readonly log: Pick<Logger, 'warn'>
  private readonly activeBySessionId = new Map<string, ActiveSessionDeletion>()

  constructor(private readonly options: SessionDeletionOwnerOptions) {
    this.runtime = options.runtime
    this.persistence = options.persistence
    this.backgroundResults = options.backgroundResults
    this.log = options.log ?? createLogger('session-deletion')
  }

  delete(request: DeleteSessionRequest): Promise<SessionDeletionResult> {
    const active = this.activeBySessionId.get(request.sessionId)
    if (active) {
      if (active.projectId === request.projectId) return active.promise
      this.log.warn('Session deletion project identity conflict', {
        operation: 'delete-session',
        phase: 'validate-runtime-owner',
        outcome: 'rejected'
      })
      return Promise.resolve({
        status: 'failed',
        reason: 'runtime',
        runtimeDetached: false
      })
    }

    const operation = (): Promise<SessionDeletionResult> => this.run(request)
    const promise = (
      this.options.withStoppedWork ? this.options.withStoppedWork(request, operation) : operation()
    )
      .catch((error: unknown): SessionDeletionResult => {
        this.log.warn('Session background work could not be stopped', diagnosticErrorFields(error))
        return { status: 'failed', reason: 'runtime', runtimeDetached: false }
      })
      .finally(() => {
        if (this.activeBySessionId.get(request.sessionId)?.promise === promise) {
          this.activeBySessionId.delete(request.sessionId)
        }
      })
    this.activeBySessionId.set(request.sessionId, { projectId: request.projectId, promise })
    return promise
  }

  private async run(request: DeleteSessionRequest): Promise<SessionDeletionResult> {
    const runtimeProjectId = this.runtime.liveSessionProjectId(request.sessionId)
    if (runtimeProjectId !== undefined && runtimeProjectId !== request.projectId) {
      this.log.warn('Session deletion runtime owner does not match the requested Project', {
        operation: 'delete-session',
        phase: 'validate-runtime-owner',
        outcome: 'rejected'
      })
      return { status: 'failed', reason: 'runtime', runtimeDetached: false }
    }

    try {
      await this.backgroundResults?.prepareSessionDeletion(request.projectId, request.sessionId)
    } catch (error) {
      this.log.warn('Session result delivery fence failed', {
        operation: 'delete-session',
        phase: 'prepare-result-delivery',
        outcome: 'failed',
        ...diagnosticErrorFields(error)
      })
      return { status: 'failed', reason: 'runtime', runtimeDetached: false }
    }

    let snapshot: AcpRuntimeState
    try {
      snapshot = await this.runtime.deleteSession({ sessionId: request.sessionId })
    } catch (error) {
      await this.abortBackgroundResultFence(request)
      this.log.warn('Session runtime deletion failed', {
        operation: 'delete-session',
        phase: 'delete-runtime',
        outcome: 'failed',
        ...diagnosticErrorFields(error)
      })
      return { status: 'failed', reason: 'runtime', runtimeDetached: false }
    }

    if (snapshot.sessionIds.includes(request.sessionId)) {
      await this.abortBackgroundResultFence(request)
      this.log.warn('Session runtime remained attached after deletion', {
        operation: 'delete-session',
        phase: 'verify-runtime-deletion',
        outcome: 'failed'
      })
      return { status: 'failed', reason: 'runtime', runtimeDetached: false }
    }

    try {
      await this.persistence.deleteSession(request)
    } catch (error) {
      this.log.warn('Session persistence deletion failed', {
        operation: 'delete-session',
        phase: 'delete-persistence',
        outcome: 'failed',
        ...diagnosticErrorFields(error)
      })
      if (error instanceof SessionDeletionCommittedError) {
        await this.commitBackgroundResultDeletion(request)
        return { status: 'deleted', runtimeDetached: true, cleanupPending: true }
      }
      return { status: 'failed', reason: 'persistence', runtimeDetached: true }
    }

    if (!(await this.commitBackgroundResultDeletion(request))) {
      return { status: 'deleted', runtimeDetached: true, cleanupPending: true }
    }
    return { status: 'deleted', runtimeDetached: true }
  }

  private async commitBackgroundResultDeletion(request: DeleteSessionRequest): Promise<boolean> {
    try {
      await this.backgroundResults?.commitSessionDeletion(request.projectId, request.sessionId)
      return true
    } catch (error) {
      this.log.warn('Session result delivery cleanup failed', {
        operation: 'delete-session',
        phase: 'commit-result-delivery',
        outcome: 'failed',
        ...diagnosticErrorFields(error)
      })
      return false
    }
  }

  private async abortBackgroundResultFence(request: DeleteSessionRequest): Promise<void> {
    try {
      await this.backgroundResults?.abortSessionDeletion(request.projectId, request.sessionId)
    } catch (error) {
      this.log.warn('Session result delivery fence rollback failed', {
        operation: 'delete-session',
        phase: 'abort-result-delivery',
        outcome: 'failed',
        ...diagnosticErrorFields(error)
      })
    }
  }
}

export { SessionDeletionOwner }
export type {
  SessionDeletionBackgroundResults,
  SessionDeletionOwnerOptions,
  SessionDeletionPersistence,
  SessionDeletionRuntime
}
