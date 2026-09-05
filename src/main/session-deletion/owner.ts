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

type SessionDeletionOwnerOptions = {
  runtime: SessionDeletionRuntime
  persistence: SessionDeletionPersistence
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
  private readonly log: Pick<Logger, 'warn'>
  private readonly activeBySessionId = new Map<string, ActiveSessionDeletion>()

  constructor(options: SessionDeletionOwnerOptions) {
    this.runtime = options.runtime
    this.persistence = options.persistence
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

    const promise = this.run(request).finally(() => {
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

    let snapshot: AcpRuntimeState
    try {
      snapshot = await this.runtime.deleteSession({ sessionId: request.sessionId })
    } catch (error) {
      this.log.warn('Session runtime deletion failed', {
        operation: 'delete-session',
        phase: 'delete-runtime',
        outcome: 'failed',
        ...diagnosticErrorFields(error)
      })
      return { status: 'failed', reason: 'runtime', runtimeDetached: false }
    }

    if (snapshot.sessionIds.includes(request.sessionId)) {
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
        return { status: 'deleted', runtimeDetached: true, cleanupPending: true }
      }
      return { status: 'failed', reason: 'persistence', runtimeDetached: true }
    }

    return { status: 'deleted', runtimeDetached: true }
  }
}

export { SessionDeletionOwner }
export type { SessionDeletionOwnerOptions, SessionDeletionPersistence, SessionDeletionRuntime }
