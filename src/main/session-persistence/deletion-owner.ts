import { ProjectFilesReconciliationError } from '../project-files/repository'
import type { ProjectFilesChangedEvent, ProjectFileSource } from '../../shared/project-files'
import {
  hasAnswerableDelegatedQuestion,
  hasCurrentRunningDelegatedAttempt
} from '../../shared/delegated-work-projection'
import type {
  LoadAllSessionsResult,
  PersistedChatSession,
  PersistedSessionStatus,
  SessionLoadFailure,
  SessionLoadWarning,
  UpdateSessionArchiveRequest
} from '../../shared/session-persistence'
import type { SessionDeletionReceipt } from '../artifacts/provenance-message-snapshot'
import { ArchiveAvailabilityError } from '../archive/availability-error'
import type { ManagedFileSoftDeleteToken } from '../project-files/repository'
import type { Logger } from '../logger'
import { startDiagnosticOperation } from '../diagnostics/operation'
import {
  OrphanLegacyUploadAuthorityMissingError,
  UnsafeLegacyUploadResidualError
} from '../uploads/repository'
import type { ProjectSessionDeletionState } from './repository'
import { saveSessionWithRevision } from './save-session'
import type { SessionPersistenceStateOwner } from './state-owner'
import { hasLegacySessionUpload } from './legacy-upload'

type ProjectSessionDeletionResult =
  { status: 'completed' } | { status: 'orphan-retained'; reason: 'missing-upload-authority' }

type SessionDeletionRepository = {
  loadAllWithDiagnostics(options?: { mode?: 'repair' | 'read-only' }): Promise<{
    result: LoadAllSessionsResult
    isComplete: boolean
    warnings?: SessionLoadWarning[]
    failure?: SessionLoadFailure
  }>
  loadProjectWithDiagnostics(projectId: string): Promise<{
    sessions: PersistedChatSession[]
    isComplete: boolean
  }>
  loadCommittedProjectWithDiagnostics(projectId: string): Promise<{
    sessions: PersistedChatSession[]
    isComplete: boolean
  }>
  loadSessionWithDiagnostics(
    projectId: string,
    sessionId: string
  ): Promise<
    | { status: 'found'; session: PersistedChatSession }
    | { status: 'missing' }
    | { status: 'unreadable' }
  >
  saveSession(session: PersistedChatSession): Promise<PersistedChatSession | void>
  saveCommittedProjectSession(session: PersistedChatSession): Promise<void>
  deleteSession(projectId: string, sessionId: string): Promise<void>
  deleteProjectSessions(projectId: string): Promise<void>
  getProjectSessionDeletionState(projectId: string): Promise<ProjectSessionDeletionState>
  markCommittedProjectSessionsPrepared(projectId: string): Promise<void>
  completeProjectSessionDeletion(projectId: string): Promise<void>
  listLegacyProjectSessionTombstones(): Promise<string[]>
}

type SessionDeletionFileIndex = {
  syncSession(session: PersistedChatSession): Promise<ProjectFileSource[]>
  softDeleteSession(projectId: string, sessionId: string): Promise<ManagedFileSoftDeleteToken>
  restoreSession(
    projectId: string,
    sessionId: string,
    token: ManagedFileSoftDeleteToken
  ): Promise<void>
  softDeleteProject(projectId: string): Promise<ManagedFileSoftDeleteToken>
  reconcileProjectSessions(projectId: string, sessions: PersistedChatSession[]): Promise<void>
  reconcileActiveSessions(sessions: PersistedChatSession[]): Promise<void>
  markReconciliationIncomplete(projectId?: string): void
}

type SessionDeletionProvenance = {
  prepareSessionDeletion(session: PersistedChatSession): Promise<SessionDeletionReceipt>
  completeSessionDeletion(receipt: SessionDeletionReceipt): Promise<void>
  abortSessionDeletion(receipt: SessionDeletionReceipt): Promise<void>
}

type SessionDeletionUploads = {
  upgradeLegacySessionUploads(
    session: PersistedChatSession,
    options?: { mode?: 'reconcile' | 'live-save' | 'orphan-recovery' | 'terminal-delete' }
  ): Promise<PersistedChatSession>
}

type ComputeJobDeletionParticipant = {
  restoreProjectJobDeletion?(projectId: string): Promise<void>
  prepareSessionJobDeletion(projectId: string, sessionId: string): Promise<void>
  commitSessionJobDeletion(projectId: string, sessionId: string): Promise<void>
  prepareProjectJobDeletion(projectId: string): Promise<void>
  commitProjectJobDeletion(projectId: string): Promise<void>
  abortSessionJobDeletion?(projectId: string, sessionId: string): Promise<void>
  abortProjectJobDeletion?(projectId: string): Promise<void>
}

type SessionWorkspaceOwnership = {
  reconcileProvisional(sessions: readonly PersistedChatSession[]): Promise<void>
  markProjectRetained(projectId: string): Promise<readonly string[]>
  restoreProjectActive(projectId: string, directories: readonly string[]): Promise<void>
  markRetained(
    session: Pick<PersistedChatSession, 'cwd' | 'projectId' | 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<boolean>
  restoreActive(session: Pick<PersistedChatSession, 'cwd' | 'projectId' | 'id'>): Promise<void>
}

type SessionPersistenceDeletionOwnerOptions = {
  repository: SessionDeletionRepository
  fileIndex: SessionDeletionFileIndex
  stateOwner: SessionPersistenceStateOwner
  provenance?: SessionDeletionProvenance
  uploads?: SessionDeletionUploads
  computeJobs?: ComputeJobDeletionParticipant
  workspaceOwnership?: SessionWorkspaceOwnership
  log: Logger
  assertArchiveMutable(projectId: string, sessionId: string): void
  notifyFilesChanged(event: ProjectFilesChangedEvent): void
  notifySessionsDeleted(sessionIds: string[]): Promise<void>
}

const ARCHIVE_BLOCKING_SESSION_STATUSES = new Set<PersistedSessionStatus>([
  'running',
  'waiting-for-user',
  'waiting-permission',
  'waiting-plan-approval'
])

const assertArchiveExpectedAt = (value: number | null, target: 'Project' | 'Session'): void => {
  if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`${target} archive state is invalid.`)
  }
}

const isSessionArchiveBlocked = (session: PersistedChatSession): boolean =>
  ARCHIVE_BLOCKING_SESSION_STATUSES.has(session.status)

const isSessionArchiveBlockedByPersistedWork = (session: PersistedChatSession): boolean =>
  isSessionArchiveBlocked(session) ||
  hasCurrentRunningDelegatedAttempt(session) ||
  hasAnswerableDelegatedQuestion(session)

class SessionPersistenceDeletionOwner {
  private readonly repository: SessionDeletionRepository
  private readonly fileIndex: SessionDeletionFileIndex
  private readonly stateOwner: SessionPersistenceStateOwner
  private readonly provenance: SessionDeletionProvenance | undefined
  private readonly uploads: SessionDeletionUploads | undefined
  private readonly computeJobs: ComputeJobDeletionParticipant | undefined
  private readonly workspaceOwnership: SessionWorkspaceOwnership | undefined
  private readonly log: Logger
  private readonly assertArchiveMutable: (projectId: string, sessionId: string) => void
  private readonly notifyFilesChanged: (event: ProjectFilesChangedEvent) => void
  private readonly notifySessionsDeleted: (sessionIds: string[]) => Promise<void>

  constructor(options: SessionPersistenceDeletionOwnerOptions) {
    this.repository = options.repository
    this.fileIndex = options.fileIndex
    this.stateOwner = options.stateOwner
    this.provenance = options.provenance
    this.uploads = options.uploads
    this.computeJobs = options.computeJobs
    this.workspaceOwnership = options.workspaceOwnership
    this.log = options.log
    this.assertArchiveMutable = options.assertArchiveMutable
    this.notifyFilesChanged = options.notifyFilesChanged
    this.notifySessionsDeleted = options.notifySessionsDeleted
  }

  async assertProjectArchivable(
    projectId: string,
    isRuntimeBusy: (sessionId: string) => boolean = () => false
  ): Promise<string[]> {
    const loaded = await this.repository.loadProjectWithDiagnostics(projectId)
    if (!loaded.isComplete) {
      throw new Error('Cannot archive a Project while its Session catalog is incomplete.')
    }
    if (
      loaded.sessions.some(
        (session) => isSessionArchiveBlockedByPersistedWork(session) || isRuntimeBusy(session.id)
      )
    ) {
      throw new Error('Finish or stop active sessions before archiving this project.')
    }
    return loaded.sessions.map((session) => session.id)
  }

  async assertSessionAvailable(projectId: string, sessionId: string): Promise<void> {
    const loaded = await this.repository.loadSessionWithDiagnostics(projectId, sessionId)
    if (loaded.status === 'unreadable') {
      throw new Error('Cannot use a Session whose durable JSON is unreadable.')
    }
    if (loaded.status === 'missing') return
    if (loaded.session.archivedAt !== undefined) {
      throw new ArchiveAvailabilityError('session-archived')
    }
  }

  async updateArchive(
    request: UpdateSessionArchiveRequest,
    isRuntimeBusy: () => boolean = () => false
  ): Promise<PersistedChatSession> {
    assertArchiveExpectedAt(request.expectedArchivedAt, 'Session')
    this.assertArchiveMutable(request.projectId, request.sessionId)

    const loaded = await this.repository.loadSessionWithDiagnostics(
      request.projectId,
      request.sessionId
    )
    if (loaded.status === 'missing') throw new Error('Session not found.')
    if (loaded.status === 'unreadable') {
      throw new Error('Cannot archive a Session whose durable JSON is unreadable.')
    }

    const currentArchivedAt = loaded.session.archivedAt ?? null
    if (currentArchivedAt !== request.expectedArchivedAt) {
      throw new Error('Session archive state changed elsewhere.')
    }
    if (
      request.archived &&
      (isSessionArchiveBlockedByPersistedWork(loaded.session) || isRuntimeBusy())
    ) {
      throw new Error('Finish or stop this session before archiving.')
    }
    if (request.archived === (currentArchivedAt !== null)) return loaded.session

    const next: PersistedChatSession = { ...loaded.session }
    if (request.archived) next.archivedAt = Date.now()
    else delete next.archivedAt
    const persisted = await saveSessionWithRevision(this.repository, next)
    this.stateOwner.recordSession(persisted)
    return persisted
  }

  private async prepareSessionUploadsForTerminalDelete(
    session: PersistedChatSession
  ): Promise<PersistedChatSession> {
    if (!this.uploads) return session

    if (!hasLegacySessionUpload(session)) {
      return this.uploads.upgradeLegacySessionUploads(session, { mode: 'terminal-delete' })
    }

    const upgradedSession = await this.uploads.upgradeLegacySessionUploads(session, {
      mode: 'live-save'
    })
    const persisted = await saveSessionWithRevision(this.repository, upgradedSession)
    return this.uploads.upgradeLegacySessionUploads(persisted, {
      mode: 'terminal-delete'
    })
  }

  private async prepareProjectSessionUploadsForTerminalDelete(
    session: PersistedChatSession,
    saveUpgradedSession: (session: PersistedChatSession) => Promise<void> = async (upgraded) => {
      await saveSessionWithRevision(this.repository, upgraded)
    },
    requireExistingUploadAuthority = false
  ): Promise<{ hasUnsafeResidual: boolean }> {
    if (!this.uploads) return { hasUnsafeResidual: false }

    let terminalSession = session
    if (hasLegacySessionUpload(session)) {
      terminalSession = await this.uploads.upgradeLegacySessionUploads(session, {
        mode: requireExistingUploadAuthority ? 'orphan-recovery' : 'live-save'
      })
      await saveUpgradedSession(terminalSession)
    }

    try {
      await this.uploads.upgradeLegacySessionUploads(terminalSession, {
        mode: 'terminal-delete'
      })
      return { hasUnsafeResidual: false }
    } catch (error) {
      if (error instanceof UnsafeLegacyUploadResidualError) {
        return { hasUnsafeResidual: true }
      }
      throw error
    }
  }

  async deleteProjectSessions(
    projectId: string,
    runWithSessionIdentities: <Result>(
      sessionIds: readonly string[],
      operation: () => Promise<Result>
    ) => Promise<Result>,
    options: { requireExistingUploadAuthority?: boolean } = {}
  ): Promise<ProjectSessionDeletionResult> {
    let deletedSessionIds: string[] = []

    if (options.requireExistingUploadAuthority && !this.uploads) {
      throw new Error('Upload recovery is unavailable for an orphaned Project tombstone.')
    }
    await this.computeJobs?.prepareProjectJobDeletion(projectId)
    const deletionState = await this.repository.getProjectSessionDeletionState(projectId)
    const scan =
      deletionState === 'legacy-committed' || deletionState === 'prepared'
        ? await this.repository.loadCommittedProjectWithDiagnostics(projectId)
        : await this.repository.loadProjectWithDiagnostics(projectId)
    deletedSessionIds = [...new Set(scan.sessions.map((session) => session.id))]
    const affectedSessionIds = [
      ...new Set([
        ...deletedSessionIds,
        ...this.stateOwner
          .metadataSnapshot()
          .sessions.filter((session) => session.projectId === projectId)
          .map((session) => session.id)
      ])
    ]

    return runWithSessionIdentities(
      affectedSessionIds,
      async (): Promise<ProjectSessionDeletionResult> => {
        if (this.uploads && deletionState !== 'prepared') {
          if (!scan.isComplete) {
            if (options.requireExistingUploadAuthority) {
              throw new Error(
                'Cannot adopt a legacy Project tombstone with incomplete Session authority.'
              )
            }
            this.fileIndex.markReconciliationIncomplete(projectId)
          }
          for (const session of scan.sessions) {
            let cleanup: { hasUnsafeResidual: boolean }
            try {
              cleanup = await this.prepareProjectSessionUploadsForTerminalDelete(
                session,
                deletionState === 'legacy-committed'
                  ? (upgraded) => this.repository.saveCommittedProjectSession(upgraded)
                  : undefined,
                options.requireExistingUploadAuthority === true
              )
            } catch (error) {
              if (
                options.requireExistingUploadAuthority &&
                error instanceof OrphanLegacyUploadAuthorityMissingError
              ) {
                await this.computeJobs?.commitProjectJobDeletion(projectId)
                this.fileIndex.markReconciliationIncomplete(projectId)
                await this.fileIndex.softDeleteProject(projectId)
                await this.notifySessionsDeleted(deletedSessionIds)
                return { status: 'orphan-retained', reason: 'missing-upload-authority' }
              }
              throw error
            }
            if (cleanup.hasUnsafeResidual) this.fileIndex.markReconciliationIncomplete(projectId)
          }
        }
        const retainedWorkspaceSessions: PersistedChatSession[] = []
        let retainedProjectWorkspaceDirectories: readonly string[] = []
        let sessionAuthorityDeleted = false
        try {
          if (this.workspaceOwnership) {
            for (const session of scan.sessions) {
              retainedWorkspaceSessions.push(session)
              if (!(await this.workspaceOwnership.markRetained(session))) {
                retainedWorkspaceSessions.pop()
              }
            }
            if (!scan.isComplete) {
              retainedProjectWorkspaceDirectories =
                await this.workspaceOwnership.markProjectRetained(projectId)
            }
          }
          if (deletionState === 'legacy-committed') {
            await this.repository.markCommittedProjectSessionsPrepared(projectId)
          }
          await this.repository.deleteProjectSessions(projectId)
          sessionAuthorityDeleted = true
          await this.computeJobs?.commitProjectJobDeletion(projectId)
          this.stateOwner.removeProject(projectId, deletedSessionIds)
          await this.fileIndex.softDeleteProject(projectId)

          this.notifyFilesChanged({
            projectId,
            sources: ['artifact', 'upload'],
            kind: 'reset'
          })
          await this.notifySessionsDeleted(deletedSessionIds)
          return { status: 'completed' }
        } catch (error) {
          if (sessionAuthorityDeleted || !this.workspaceOwnership) throw error
          const recoveryErrors: unknown[] = []
          if (retainedProjectWorkspaceDirectories.length > 0) {
            try {
              await this.workspaceOwnership.restoreProjectActive(
                projectId,
                retainedProjectWorkspaceDirectories
              )
            } catch (recoveryError) {
              recoveryErrors.push(recoveryError)
            }
          }
          for (const session of retainedWorkspaceSessions.reverse()) {
            try {
              await this.workspaceOwnership.restoreActive(session)
            } catch (recoveryError) {
              recoveryErrors.push(recoveryError)
            }
          }
          if (recoveryErrors.length > 0) {
            throw new AggregateError(
              [error, ...recoveryErrors],
              `Project Session deletion and managed workspace rollback failed: ${projectId}`
            )
          }
          throw error
        }
      }
    )
  }

  getProjectSessionDeletionState(projectId: string): Promise<ProjectSessionDeletionState> {
    return this.repository.getProjectSessionDeletionState(projectId)
  }

  markCommittedProjectSessionsPrepared(projectId: string): Promise<void> {
    return this.repository.markCommittedProjectSessionsPrepared(projectId)
  }

  completeProjectSessionDeletion(projectId: string): Promise<void> {
    return this.repository.completeProjectSessionDeletion(projectId)
  }

  listLegacyProjectSessionTombstones(): Promise<string[]> {
    return this.repository.listLegacyProjectSessionTombstones()
  }

  async deleteSession(
    projectId: string,
    sessionId: string
  ): Promise<SessionDeletionReceipt['kind']> {
    const operation = startDiagnosticOperation(this.log, {
      operation: 'session-persistence-deletion'
    })
    let failurePhase = 'load-authority'
    let token: ManagedFileSoftDeleteToken | undefined
    let receipt: SessionDeletionReceipt = { kind: 'ordinary', projectId, sessionId }
    let jsonDeleted = false
    let computeJobsPrepared = false
    let managedWorkspaceRetained = false
    let session: PersistedChatSession | undefined

    try {
      if (this.computeJobs) {
        failurePhase = 'prepare-compute-cleanup'
        operation.phase(failurePhase)
        await this.computeJobs.prepareSessionJobDeletion(projectId, sessionId)
        computeJobsPrepared = true
      }
      failurePhase = 'load-authority'
      operation.phase(failurePhase)
      const loadedSession = await this.repository.loadSessionWithDiagnostics(projectId, sessionId)
      if (loadedSession.status === 'unreadable') {
        throw new Error('Cannot delete a Session whose durable JSON is unreadable.')
      }
      session = loadedSession.status === 'found' ? loadedSession.session : undefined
      if (session && this.uploads) {
        failurePhase = 'prepare-upload-cleanup'
        operation.phase(failurePhase)
        session = await this.prepareSessionUploadsForTerminalDelete(session)
      }
      if (session && this.provenance) {
        failurePhase = 'prepare-provenance'
        operation.phase(failurePhase)
        receipt = await this.provenance.prepareSessionDeletion(session)
      }
      if (receipt.kind === 'ordinary') {
        failurePhase = 'soft-delete-file-index'
        operation.phase(failurePhase)
        token = await this.fileIndex.softDeleteSession(projectId, sessionId)
      }
      if (session && this.workspaceOwnership) {
        failurePhase = 'retain-managed-workspace'
        operation.phase(failurePhase)
        managedWorkspaceRetained = true
        managedWorkspaceRetained = await this.workspaceOwnership.markRetained(session)
      }
      failurePhase = 'delete-authority'
      operation.phase(failurePhase)
      await this.repository.deleteSession(projectId, sessionId)
      jsonDeleted = true
      if (this.computeJobs) {
        failurePhase = 'commit-compute-cleanup'
        operation.phase(failurePhase)
        await this.computeJobs.commitSessionJobDeletion(projectId, sessionId)
      }
      failurePhase = 'complete-provenance'
      operation.phase(failurePhase)
      await this.provenance?.completeSessionDeletion(receipt)
    } catch (error) {
      let recoveryPhase: string | undefined
      try {
        if (!jsonDeleted) {
          let recoveryError: unknown
          let recoveryFailed = false
          try {
            if (receipt.kind === 'retained') {
              recoveryPhase = 'abort-provenance'
              await this.provenance?.abortSessionDeletion(receipt)
            }
            if (token) {
              recoveryPhase = 'restore-file-index'
              await this.fileIndex.restoreSession(projectId, sessionId, token)
            }
          } catch (restoreError) {
            recoveryError = restoreError
            recoveryFailed = true
          }
          if (computeJobsPrepared) {
            try {
              await this.computeJobs?.abortSessionJobDeletion?.(projectId, sessionId)
            } catch (computeRestoreError) {
              recoveryPhase = 'abort-compute-cleanup'
              recoveryError = computeRestoreError
              recoveryFailed = true
            }
          }
          if (managedWorkspaceRetained && session) {
            try {
              recoveryPhase = 'restore-managed-workspace'
              await this.workspaceOwnership?.restoreActive(session)
            } catch (workspaceRestoreError) {
              recoveryError = workspaceRestoreError
              recoveryFailed = true
            }
          }
          if (recoveryFailed) throw recoveryError
        } else {
          this.fileIndex.markReconciliationIncomplete(projectId)
        }
      } catch (restoreError) {
        this.fileIndex.markReconciliationIncomplete(projectId)
        operation.fail(restoreError, { failurePhase, recoveryPhase })
        throw restoreError
      }
      operation.fail(error, { failurePhase })
      throw error
    }

    operation.complete({ receiptKind: receipt.kind })
    return receipt.kind
  }

  async reconcileSessionDeletion(
    projectId: string,
    sessionId: string,
    receiptKind: SessionDeletionReceipt['kind']
  ): Promise<void> {
    // Retain the metadata identity tombstone until the global phase starts so a cross-Project reuse
    // cannot be admitted between authoritative deletion and ID-only projection cleanup.
    this.stateOwner.removeSession(projectId, sessionId)
    const survivorChanges: Array<{ sessionId: string; sources: ProjectFileSource[] }> = []
    try {
      const scan = await this.repository.loadAllWithDiagnostics()
      if (scan.isComplete) {
        this.stateOwner.replaceMetadata(scan.result.sessions, true)
        for (const session of scan.result.sessions) {
          if (session.projectId !== projectId) continue
          const changedSources = await this.fileIndex.syncSession(session).catch(() => undefined)
          if (changedSources?.length) {
            survivorChanges.push({ sessionId: session.id, sources: changedSources })
          }
        }
        await this.fileIndex.reconcileActiveSessions(scan.result.sessions)
      } else {
        this.stateOwner.markMetadataIncomplete()
        this.fileIndex.markReconciliationIncomplete()
      }
    } catch (error) {
      this.stateOwner.markMetadataIncomplete()
      if (!(error instanceof ProjectFilesReconciliationError))
        this.fileIndex.markReconciliationIncomplete()
    }

    for (const change of survivorChanges) {
      this.notifyFilesChanged({
        projectId,
        sessionId: change.sessionId,
        sources: change.sources,
        kind: 'upsert'
      })
    }
    this.notifyFilesChanged({
      projectId,
      sessionId,
      sources: ['artifact', 'upload'],
      kind: receiptKind === 'retained' ? 'upsert' : 'delete'
    })
    await this.notifySessionsDeleted([sessionId])
  }

  async reconcileProjectSessionDeletion(
    projectId: string,
    sessionId: string,
    receiptKind: SessionDeletionReceipt['kind']
  ): Promise<boolean> {
    const survivorChanges: Array<{ sessionId: string; sources: ProjectFileSource[] }> = []
    try {
      const scan = await this.repository.loadProjectWithDiagnostics(projectId)
      if (!scan.isComplete || !this.stateOwner.metadataSnapshot().isComplete) return false
      for (const session of scan.sessions) {
        const changedSources = await this.fileIndex.syncSession(session).catch(() => undefined)
        if (changedSources?.length) {
          survivorChanges.push({ sessionId: session.id, sources: changedSources })
        }
      }
      await this.fileIndex.reconcileProjectSessions(projectId, scan.sessions)
      if (!this.stateOwner.metadataSnapshot().isComplete) return false
      this.stateOwner.replaceProjectMetadata(projectId, scan.sessions)
      this.stateOwner.invalidateBindingTopology(projectId, sessionId)
    } catch {
      this.stateOwner.markMetadataIncomplete()
      this.fileIndex.markReconciliationIncomplete(projectId)
      return false
    }

    for (const change of survivorChanges) {
      this.notifyFilesChanged({
        projectId,
        sessionId: change.sessionId,
        sources: change.sources,
        kind: 'upsert'
      })
    }
    this.notifyFilesChanged({
      projectId,
      sessionId,
      sources: ['artifact', 'upload'],
      kind: receiptKind === 'retained' ? 'upsert' : 'delete'
    })
    await this.notifySessionsDeleted([sessionId])
    return true
  }
}

export { SessionPersistenceDeletionOwner, hasLegacySessionUpload }
export type {
  ComputeJobDeletionParticipant,
  SessionWorkspaceOwnership,
  ProjectSessionDeletionResult,
  SessionPersistenceDeletionOwnerOptions
}
