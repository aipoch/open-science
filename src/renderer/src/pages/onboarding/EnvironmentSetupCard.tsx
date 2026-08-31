import { useTranslation } from 'react-i18next'

import type { EnvironmentCheckId, EnvironmentCheckResult } from '../../../../shared/settings'
import { EnvironmentCheckRow, PendingCheckRow } from '@/components/environment-check-row'
import { localizeHostEnvironmentCheck } from './environment-check-presentation'

type EnvironmentSetupCardProps = {
  environment: EnvironmentCheckResult | undefined
  error?: string
}

// Only the placeholder rows shown before the first result need local labels; once the check returns,
// every row renders the main process's own label for that item. A runtime id can't be interpolated
// into a natural-language key, so each id carries its English text here for `t()` to resolve.
const CHECK_LABELS: Array<{ id: EnvironmentCheckId; label: string }> = [
  { id: 'system', label: 'System compatibility' },
  { id: 'storage', label: 'App storage permission' },
  { id: 'secure-storage', label: 'Secure credential storage' },
  { id: 'install-network', label: 'Installation network' }
]

const HOST_CHECK_IDS: readonly EnvironmentCheckId[] = CHECK_LABELS.map((check) => check.id)

// Host-only requirement list for the first onboarding step. Agent installation and notebook runtime
// management live in their dedicated steps and must not leak back into this surface.
const EnvironmentSetupCard = ({
  environment,
  error
}: EnvironmentSetupCardProps): React.JSX.Element => {
  const { t } = useTranslation()
  const visibleChecks = environment?.checks.filter((check) => HOST_CHECK_IDS.includes(check.id))
  const hostNeedsAction = visibleChecks?.some((check) => check.status === 'failed') ?? false

  return (
    <div className="space-y-4">
      <ul
        className="divide-y divide-border-200"
        aria-label={t('Environment requirements')}
        aria-live="polite"
      >
        {environment
          ? visibleChecks?.map((check) => (
              <EnvironmentCheckRow key={check.id} check={localizeHostEnvironmentCheck(check, t)} />
            ))
          : CHECK_LABELS.map((check) => (
              <PendingCheckRow key={check.id} id={check.id} label={t(check.label)} />
            ))}
      </ul>

      {hostNeedsAction ? (
        <div className="rounded-lg bg-bg-10 px-4 py-4 ring-1 ring-border-200">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('Resolve the items marked Action needed, then choose Check again.')}
          </p>
        </div>
      ) : null}

      {error ? (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"
          role="alert"
        >
          <p className="text-xs font-semibold text-destructive">
            {t('Setup could not be completed')}
          </p>
          <p className="mt-1 break-words text-xs text-destructive/90">{error}</p>
        </div>
      ) : null}
    </div>
  )
}

export { EnvironmentSetupCard }
