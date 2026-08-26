import type {
  LoadAllSessionsResult,
  PersistedChatSession,
  SessionLoadDiagnostics,
  SessionLoadWarning
} from '../../shared/session-persistence'

type SessionCatalogDiagnostics = {
  isComplete: boolean
  warnings?: readonly SessionLoadWarning[]
}

type SessionIdentityOwnershipRepository = {
  assertSessionIdentityOwnership(sessionId: string, expectedProjectId: string): Promise<void>
}

type SessionMetadataAuthority = {
  metadataSnapshot(): {
    sessions: readonly Pick<PersistedChatSession, 'id' | 'projectId'>[]
    isComplete: boolean
  }
}

const isSessionCatalogAuthoritative = (
  diagnostics: SessionCatalogDiagnostics | undefined
): boolean =>
  diagnostics?.isComplete === true &&
  !diagnostics.warnings?.some((warning) => warning.kind === 'corrupt')

const assertSessionIdentityOwnership = async (
  repository: SessionIdentityOwnershipRepository,
  metadataAuthority: SessionMetadataAuthority,
  session: Pick<PersistedChatSession, 'id' | 'projectId'>
): Promise<void> => {
  const metadata = metadataAuthority.metadataSnapshot()
  const existingProjectId = metadata.sessions.find((item) => item.id === session.id)?.projectId
  if (existingProjectId !== undefined && existingProjectId !== session.projectId) {
    throw new Error('Cannot save a Session id that is already owned by another Project.')
  }
  if (!metadata.isComplete) {
    await repository.assertSessionIdentityOwnership(session.id, session.projectId)
  }
}

type SessionCatalog = Readonly<{
  sessions: PersistedChatSession[]
  diagnostics?: SessionLoadDiagnostics
}>

const canReconcileSessionAbsences = <Catalog extends SessionCatalog>(catalog: Catalog): boolean =>
  catalog.diagnostics?.isProjectDeletionRecoveryComplete === true &&
  isSessionCatalogAuthoritative(catalog.diagnostics)

const withProjectDeletionRecoveryStatus = (
  result: LoadAllSessionsResult,
  isProjectDeletionRecoveryComplete: boolean
): LoadAllSessionsResult => ({
  ...result,
  diagnostics: {
    isComplete: result.diagnostics?.isComplete ?? true,
    warnings: result.diagnostics?.warnings ?? [],
    ...result.diagnostics,
    isProjectDeletionRecoveryComplete
  }
})

export {
  assertSessionIdentityOwnership,
  canReconcileSessionAbsences,
  isSessionCatalogAuthoritative,
  withProjectDeletionRecoveryStatus
}
export type { SessionCatalog }
