import type { SessionLoadDiagnostics } from '../../../../shared/session-persistence'
export type SessionCatalogRecovery =
  | { kind: 'ready' }
  | {
      kind: 'repairable'
      reason: 'session-scan' | 'startup-reconciliation'
    }
  | {
      kind: 'damaged-authority'
      affectedFiles: Array<{ projectId: string; fileName: string }>
    }
  | {
      kind: 'unsupported-version'
      affectedFileCount: number
    }
  | {
      kind: 'oversized-authority'
      affectedFiles: Array<{ projectId: string; fileName: string }>
    }
  | { kind: 'project-deletion-recovery' }

export const READY_SESSION_CATALOG_RECOVERY: SessionCatalogRecovery = Object.freeze({
  kind: 'ready'
})

export const deriveSessionCatalogRecovery = (
  diagnostics: SessionLoadDiagnostics | undefined
): SessionCatalogRecovery => {
  if (!diagnostics) return READY_SESSION_CATALOG_RECOVERY
  if (diagnostics.isProjectDeletionRecoveryComplete === false) {
    return { kind: 'project-deletion-recovery' }
  }

  const sessionWarnings = diagnostics.warnings.filter((warning) => 'projectId' in warning)
  const unsupportedVersionWarnings = sessionWarnings.filter(
    (warning) => warning.kind === 'unsupported-version'
  )
  if (unsupportedVersionWarnings.length > 0) {
    return {
      kind: 'unsupported-version',
      affectedFileCount: unsupportedVersionWarnings.length
    }
  }
  const oversizedWarnings = sessionWarnings.filter((warning) => warning.kind === 'too-large')
  if (oversizedWarnings.length > 0) {
    return {
      kind: 'oversized-authority',
      affectedFiles: oversizedWarnings.map(({ projectId, fileName }) => ({ projectId, fileName }))
    }
  }
  if (diagnostics.isComplete === false) {
    return {
      kind: 'repairable',
      reason:
        diagnostics.failure === 'startup-reconciliation-failed'
          ? 'startup-reconciliation'
          : 'session-scan'
    }
  }

  const damagedWarnings = sessionWarnings.filter(
    (warning) => warning.kind === 'corrupt' && warning.recovered
  )
  if (damagedWarnings.length > 0) {
    return {
      kind: 'damaged-authority',
      affectedFiles: damagedWarnings.map(({ projectId, fileName }) => ({ projectId, fileName }))
    }
  }

  // A warning outside a partial scan should remain recoverable rather than being collapsed into a
  // healthy catalog if a future Main diagnostic can report a readable-but-unresolved Session.
  if (sessionWarnings.length > 0) {
    return { kind: 'repairable', reason: 'session-scan' }
  }
  return READY_SESSION_CATALOG_RECOVERY
}
