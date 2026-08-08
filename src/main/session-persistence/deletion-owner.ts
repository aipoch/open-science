import type { ProjectFilesChangedEvent, ProjectFileSource } from '../../shared/project-files'
import type {
  LoadAllSessionsResult,
  PersistedChatSession,
  PersistedSessionStatus,
  SessionLoadFailure,
  SessionLoadWarning,
  UpdateSessionArchiveRequest
} from '../../shared/session-persistence'
import type { SessionDeletionReceipt } from '../artifacts/provenance-message-snapshot'
import type { ManagedFileSoftDeleteToken } from '../project-files/repository'
import {
  OrphanLegacyUploadAuthorityMissingError,
  UnsafeLegacyUploadResidualError
} from '../uploads/repository'
import type { ProjectSessionDeletionState } from './repository'
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
  saveSession(session: PersistedChatSession): Promise<void>
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
  reconcileActiveSessions(sessions: PersistedChatSession[]): Promise<void>
  markReconciliationIncomplete(): void
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

type SessionPersistenceDeletionOwnerOptions = {
  repository: SessionDeletionRepository
  fileIndex: SessionDeletionFileIndex
  stateOwner: SessionPersistenceStateOwner
  provenance?: SessionDeletionProvenance
  uploads?: SessionDeletionUploads
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

class SessionPersistenceDeletionOwner {
  private readonly repository: SessionDeletionRepository
  private readonly fileIndex: SessionDeletionFileIndex
  private readonly stateOwner: SessionPersistenceStateOwner
  private readonly provenance: SessionDeletionProvenance | undefined
  private readonly uploads: SessionDeletionUploads | undefined
  private readonly assertArchiveMutable: (projectId: string, sessionId: string) => void
  private readonly notifyFilesChanged: (event: ProjectFilesChangedEvent) => void
  private readonly notifySessionsDeleted: (sessionIds: string[]) => Promise<void>

  constructor(options: SessionPersistenceDeletionOwnerOptions) {
    this.repository = options.repository
    this.fileIndex = options.fileIndex
    this.stateOwner = options.stateOwner
    this.provenance = options.provenance
    this.uploads = options.uploads
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
        (session) => isSessionArchiveBlocked(session) || isRuntimeBusy(session.id)
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
      throw new Error('Restore this archived Session before continuing.')
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
    if (request.archived && (isSessionArchiveBlocked(loaded.session) || isRuntimeBusy())) {
      throw new Error('Finish or stop this session before archiving.')
    }
    if (request.archived === (currentArchivedAt !== null)) return loaded.session

    const next: PersistedChatSession = { ...loaded.session }
    if (request.archived) next.archivedAt = Date.now()
    else delete next.archivedAt
    await this.repository.saveSession(next)
    this.stateOwner.recordSession(next)
    return next
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
    await this.repository.saveSession(upgradedSession)
    return this.uploads.upgradeLegacySessionUploads(upgradedSession, {
      mode: 'terminal-delete'
    })
  }

  private async prepareProjectSessionUploadsForTerminalDelete(
    session: PersistedChatSession,
    saveUpgradedSession: (session: PersistedChatSession) => Promise<void> = (upgraded) =>
      this.repository.saveSession(upgraded),
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
    options: { requireExistingUploadAuthority?: boolean } = {}
  ): Promise<ProjectSessionDeletionResult> {
    let deletedSessionIds: string[] = []

    if (options.requireExistingUploadAuthority && !this.uploads) {
      throw new Error('Upload recovery is unavailable for an orphaned Project tombstone.')
    }
    const deletionState = await this.repository.getProjectSessionDeletionState(projectId)
    const scan =
      deletionState === 'legacy-committed' || deletionState === 'prepared'
        ? await this.repository.loadCommittedProjectWithDiagnostics(projectId)
        : await this.repository.loadProjectWithDiagnostics(projectId)
    deletedSessionIds = [...new Set(scan.sessions.map((session) => session.id))]

    if (this.uploads && deletionState !== 'prepared') {
      if (!scan.isComplete) {
        if (options.requireExistingUploadAuthority) {
          throw new Error(
            'Cannot adopt a legacy Project tombstone with incomplete Session authority.'
          )
        }
        this.fileIndex.markReconciliationIncomplete()
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
            this.fileIndex.markReconciliationIncomplete()
            await this.fileIndex.softDeleteProject(projectId)
            await this.notifySessionsDeleted(deletedSessionIds)
            return { status: 'orphan-retained', reason: 'missing-upload-authority' }
          }
          throw error
        }
        if (cleanup.hasUnsafeResidual) this.fileIndex.markReconciliationIncomplete()
      }
    }
    if (deletionState === 'legacy-committed') {
      await this.repository.markCommittedProjectSessionsPrepared(projectId)
    }
    await this.repository.deleteProjectSessions(projectId)
    this.stateOwner.removeProject(projectId, deletedSessionIds)
    await this.fileIndex.softDeleteProject(projectId)

    this.notifyFilesChanged({
      projectId,
      sources: ['artifact', 'upload'],
      kind: 'reset'
    })
    await this.notifySessionsDeleted(deletedSessionIds)
    return { status: 'completed' }
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

  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    let token: ManagedFileSoftDeleteToken | undefined
    let receipt: SessionDeletionReceipt = { kind: 'ordinary', projectId, sessionId }
    let jsonDeleted = false

    try {
      const loadedSession = await this.repository.loadSessionWithDiagnostics(projectId, sessionId)
      if (loadedSession.status === 'unreadable') {
        throw new Error('Cannot delete a Session whose durable JSON is unreadable.')
      }
      let session = loadedSession.status === 'found' ? loadedSession.session : undefined
      if (session && this.uploads)
        session = await this.prepareSessionUploadsForTerminalDelete(session)
      if (session && this.provenance) {
        receipt = await this.provenance.prepareSessionDeletion(session)
      }
      if (receipt.kind === 'ordinary') {
        token = await this.fileIndex.softDeleteSession(projectId, sessionId)
      }
      await this.repository.deleteSession(projectId, sessionId)
      jsonDeleted = true
      this.stateOwner.removeSession(projectId, sessionId)
      await this.provenance?.completeSessionDeletion(receipt)
    } catch (error) {
      try {
        if (!jsonDeleted) {
          if (receipt.kind === 'retained') await this.provenance?.abortSessionDeletion(receipt)
          if (token) await this.fileIndex.restoreSession(projectId, sessionId, token)
        } else {
          this.fileIndex.markReconciliationIncomplete()
        }
      } catch (restoreError) {
        this.fileIndex.markReconciliationIncomplete()
        throw restoreError
      }
      throw error
    }

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
    } catch {
      this.stateOwner.markMetadataIncomplete()
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
      kind: receipt.kind === 'retained' ? 'upsert' : 'delete'
    })
    await this.notifySessionsDeleted([sessionId])
  }
}

export { SessionPersistenceDeletionOwner, hasLegacySessionUpload }
export type { ProjectSessionDeletionResult, SessionPersistenceDeletionOwnerOptions }
