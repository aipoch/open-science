/* Hallmark · component: background runtime status · genre: editorial · theme: app tokens
 * states: preparing · reconnecting · error · ready · Retry inherits the standard Button states
 * contrast: pass (40–41) · tokens: pass (48) · responsive: pass (34, 49)
 * pre-emit critique: P5 H5 E5 S5 R5 V4
 */
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ProvisionUiState } from './provisioning-view'

type EnvStatusBannerPlacement = 'floating' | 'inline'

// Background preparation stays subordinate to the user's current task: onboarding places the status
// beside its explanatory copy, while the app shell uses a quiet edge-aligned label. Detailed progress
// remains local to Notebook, where waiting is relevant. Failures stay globally actionable.
const EnvStatusBanner = ({
  ui,
  onRetry,
  placement = 'floating'
}: {
  ui: ProvisionUiState
  onRetry?: () => void
  placement?: EnvStatusBannerPlacement
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const show = (ui.kind === 'preparing' && ui.scope !== 'r') || ui.kind === 'error'
  if (!show) return null

  if (ui.kind === 'preparing') {
    const activityLabel =
      ui.download?.phase === 'reconnecting'
        ? t('Connection lost, resuming… (attempt {{attempt}})', {
            attempt: ui.download.attempt
          })
        : ui.scope === 'python'
          ? t('Preparing Python environment…')
          : t('Updating the notebook environment…')

    return (
      <div
        data-testid="env-status-banner"
        data-placement={placement}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={cn(
          'flex items-center gap-2 text-xs leading-4 text-muted-foreground',
          placement === 'inline'
            ? 'mt-4 max-w-60 border-t border-border-200 pt-3'
            : 'pointer-events-none fixed top-4 right-4 z-50 max-w-[min(90vw,360px)] bg-bg-10 px-2 py-1'
        )}
      >
        <LoaderCircle
          data-testid="env-status-activity"
          className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
          aria-hidden="true"
        />
        <span>{activityLabel}</span>
      </div>
    )
  }

  // This is the only failure surface outside the Notebook pane, so keep the full actionable reason
  // reachable in a bounded scroll area and preserve the established dialog chrome.
  return (
    <div
      data-testid="env-status-banner"
      data-placement="floating"
      role="alert"
      className="fixed left-1/2 top-2 z-50 flex max-w-[min(90vw,560px)] -translate-x-1/2 items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left text-xs text-foreground shadow-dialog"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{t('Environment update failed')}</p>
        <p className="mt-0.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">
          {ui.message}
        </p>
      </div>
      {onRetry ? (
        <Button
          type="button"
          variant="outline"
          data-testid="env-status-banner-retry"
          onClick={onRetry}
          className="shrink-0"
        >
          {t('Retry')}
        </Button>
      ) : null}
    </div>
  )
}

export { EnvStatusBanner, type EnvStatusBannerPlacement }
