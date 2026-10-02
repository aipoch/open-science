import type { RendererFailureContext } from '../../../shared/diagnostics'
import { projectRendererFailure } from '../renderer-diagnostics'

// Keeps full detail in the local console while Main's log receives only the allowlisted phase,
// error category and stack fingerprint. Diagnostics are best-effort and never replace the failure
// being handled.
export const reportHandledRendererFailure = (
  message: string,
  error: unknown,
  context: RendererFailureContext
): void => {
  console.warn(message, error)
  try {
    window.api.diagnostics?.reportRendererFailure(
      projectRendererFailure('handled-error', error, 'workspace', context)
    )
  } catch {
    // Reporting is best-effort.
  }
}
