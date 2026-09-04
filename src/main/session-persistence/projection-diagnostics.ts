import type { SessionLoadDiagnostics } from '../../shared/session-persistence'

const HEALTHY_SESSION_PROJECTION_DIAGNOSTICS: SessionLoadDiagnostics = {
  isComplete: true,
  warnings: [],
  isProjectDeletionRecoveryComplete: true
}

const hasRecoveredAuthorityWarning = (diagnostics: SessionLoadDiagnostics): boolean =>
  diagnostics.warnings?.some((warning) => warning.recovered) === true

// Projection reads usually omit authority diagnostics after the projection is ready. Preserve a
// successful recovery warning across later reads so a second startup client cannot replace the
// warning with an inferred healthy state. A fresh authority result always supersedes the cache.
class SessionProjectionDiagnostics {
  private recovered: SessionLoadDiagnostics | undefined

  resolve(current: SessionLoadDiagnostics | undefined): SessionLoadDiagnostics {
    if (current) {
      this.recovered = hasRecoveredAuthorityWarning(current) ? current : undefined
      return current
    }
    return this.recovered ?? HEALTHY_SESSION_PROJECTION_DIAGNOSTICS
  }
}

export { SessionProjectionDiagnostics }
