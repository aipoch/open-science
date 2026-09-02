import type { DownloadProgress } from '../../../../shared/download-progress'
import type {
  ProvisionOperationScope,
  ProvisionProgress,
  ProvisionScope,
  ProvisionStatus
} from '../../../../shared/notebook-env'
import type { NotebookRuntimeBinding } from '../../../../shared/notebook-runtime'

// Preparing scope can arrive explicitly on progress events. Older main-process senders omit it, so
// the reducer retains the legacy `(provisioning && pythonReady)` upgrade inference as a fallback.
type PreparingScope = ProvisionOperationScope

// Derived UI state for the single reusable provisioning surface (onboarding step, launch banner,
// notebook gate all render from this).
export type ProvisionUiState =
  | { kind: 'ready' }
  | {
      kind: 'preparing'
      scope: PreparingScope
      phase: string
      message: string
      progress: number
      sessionId?: string
      download?: DownloadProgress
    }
  | { kind: 'error'; message: string; scope?: PreparingScope; sessionId?: string }

export const hasActiveRuntimeTarget = (
  binding: Pick<NotebookRuntimeBinding, 'status'> | undefined
): boolean => binding !== undefined && (binding.status ?? 'active') === 'active'

// Pure mapping from the mirrored main-process state to the UI state. `scope` is the renderer's last
// explicit provision request (undefined for an auto upgrade); `error` is the last failed attempt.
export function deriveProvisionUi(
  status: ProvisionStatus,
  scope: ProvisionScope | undefined,
  progress: ProvisionProgress | undefined,
  error: string | undefined
): ProvisionUiState {
  if (status.provisioning) {
    const resolvedScope: PreparingScope =
      progress?.scope ?? scope ?? (status.pythonReady ? 'upgrade' : 'python')
    return {
      kind: 'preparing',
      scope: resolvedScope,
      phase: progress?.phase ?? '',
      message: progress?.message ?? '',
      progress: progress?.progress ?? 0,
      ...(progress?.sessionId ? { sessionId: progress.sessionId } : {}),
      ...(progress?.download ? { download: progress.download } : {})
    }
  }
  // A failed attempt only counts as a blocking error while python itself is missing; an R failure
  // leaves Python usable, so it does not surface as an app-level error.
  if (error && !status.pythonReady) {
    const failedProgress = progress?.phase === 'error' ? progress : undefined
    return {
      kind: 'error',
      message: error,
      ...(failedProgress?.scope ? { scope: failedProgress.scope } : {}),
      ...(failedProgress?.sessionId ? { sessionId: failedProgress.sessionId } : {})
    }
  }
  return { kind: 'ready' }
}

// The notebook pane is greyed while its implicit managed Python target is unavailable or while an
// additive upgrade is running. An active explicit runtime binding bypasses managed provisioning.
export function notebookGated(
  status: ProvisionStatus,
  ui: ProvisionUiState,
  sessionId?: string,
  binding?: Pick<NotebookRuntimeBinding, 'status'>
): boolean {
  if (ui.kind !== 'ready' && ui.sessionId && sessionId && ui.sessionId !== sessionId) {
    return false
  }
  // Explicit Session bindings have already been validated by the runtime registry. Only the absent
  // binding (the implicit app-managed default) depends on global provisioning readiness.
  if (hasActiveRuntimeTarget(binding)) return false
  // A progress event can identify Python/upgrade work before its follow-up status refresh observes
  // provisioning=true. Fail closed from either signal so a refresh failure never opens the gate;
  // R-only work stays additive, and the error overlay still exposes Retry.
  if (ui.kind === 'error' && ui.scope !== 'r' && (status.provisioning || ui.scope !== undefined)) {
    return true
  }
  if (!status.pythonReady) return true
  return ui.kind === 'preparing' && ui.scope === 'upgrade'
}
