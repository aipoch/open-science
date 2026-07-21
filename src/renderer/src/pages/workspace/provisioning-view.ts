import type {
  ProvisionProgress,
  ProvisionScope,
  ProvisionStatus
} from '../../../../shared/notebook-env'

// UI-local scope: extends the wire-level ProvisionScope with the inferred 'upgrade' state. 'upgrade'
// is never requested by the renderer and never crosses the shared boundary (contract §4) — it only
// exists here, derived from `(provisioning && pythonReady)`.
type PreparingScope = ProvisionScope | 'upgrade'

// Derived UI state for the single reusable provisioning surface (onboarding step, launch banner,
// notebook gate all render from this).
export type ProvisionUiState =
  | { kind: 'ready' }
  | { kind: 'preparing'; scope: PreparingScope; phase: string; message: string; progress: number }
  | { kind: 'error'; message: string }

// Pure mapping from the mirrored main-process state to the UI state. `scope` is the renderer's last
// explicit provision request (undefined for an auto upgrade); `error` is the last failed attempt.
export function deriveProvisionUi(
  status: ProvisionStatus,
  scope: ProvisionScope | undefined,
  progress: ProvisionProgress | undefined,
  error: string | undefined
): ProvisionUiState {
  if (status.provisioning) {
    const resolvedScope: PreparingScope = scope ?? (status.pythonReady ? 'upgrade' : 'python')
    return {
      kind: 'preparing',
      scope: resolvedScope,
      phase: progress?.phase ?? '',
      message: progress?.message ?? '',
      progress: progress?.progress ?? 0
    }
  }
  // A failed attempt only counts as a blocking error while python itself is missing; an R failure
  // leaves Python usable, so it does not surface as an app-level error.
  if (error && !status.pythonReady) return { kind: 'error', message: error }
  return { kind: 'ready' }
}

// The notebook pane is greyed while python is unavailable or while an additive upgrade is running.
// An R-only preparation never gates the pane — Python stays interactive (spec §6.5).
export function notebookGated(status: ProvisionStatus, ui: ProvisionUiState): boolean {
  if (!status.pythonReady) return true
  return ui.kind === 'preparing' && ui.scope === 'upgrade'
}
