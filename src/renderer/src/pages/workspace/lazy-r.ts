import type { NotebookLanguage } from '../../../../shared/notebook'
import type { ProvisionStatus } from '../../../../shared/notebook-env'

// First time R is needed (user selects R / an R cell runs) and it is not yet materialized, fire a
// one-shot provision('r'). Python stays usable throughout (spec §6.5). Guard against re-entry.
export function shouldProvisionR(
  status: ProvisionStatus,
  requestedLang: NotebookLanguage
): boolean {
  return requestedLang === 'r' && !status.rReady && !status.provisioning
}
