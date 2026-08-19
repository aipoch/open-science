import type { SessionLoadWarning } from '../../shared/session-persistence'

type SessionCatalogDiagnostics = {
  isComplete: boolean
  warnings?: readonly SessionLoadWarning[]
}

const isSessionCatalogAuthoritative = (
  diagnostics: SessionCatalogDiagnostics | undefined
): boolean =>
  diagnostics?.isComplete === true &&
  !diagnostics.warnings?.some((warning) => warning.kind === 'corrupt')

export { isSessionCatalogAuthoritative }
