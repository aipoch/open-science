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

const isSessionCatalogAuthoritative = (
  diagnostics: SessionCatalogDiagnostics | undefined
): boolean =>
  diagnostics?.isComplete === true &&
  !diagnostics.warnings?.some((warning) => warning.kind === 'corrupt')

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
  canReconcileSessionAbsences,
  isSessionCatalogAuthoritative,
  withProjectDeletionRecoveryStatus
}
export type { SessionCatalog }
