import type { LoadAllSessionsResult, PersistedChatSession } from '../../shared/session-persistence'
import { canReconcileSessionAbsences } from '../session-persistence/catalog-authority'

// Only a fully recovered catalog can replace the details owner's fresh catalog read. Undefined
// preserves that fallback; an empty array means recovery succeeded and found nothing to do.
export const selectSessionDetailsStartupCandidates = (
  catalog: LoadAllSessionsResult
): PersistedChatSession[] | undefined => {
  if (!canReconcileSessionAbsences(catalog) || catalog.diagnostics?.failure) return undefined
  return catalog.sessions.filter(
    (session) =>
      session.sessionDetailsGenerationEligible === true ||
      session.sessionDetailsGeneration !== undefined ||
      session.branchSource !== undefined
  )
}
