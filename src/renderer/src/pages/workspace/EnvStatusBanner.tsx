import { ErrorNotice } from '@/components/error-notice'
import { useTranslation } from 'react-i18next'

import { DownloadProgressLine } from '@/components/DownloadProgressLine'
import type { ProvisionUiState } from './provisioning-view'

// Bottom-right notice for the launch-time upgrade gate (spec §6.2). First-run python preparation
// is surfaced by the onboarding step and the notebook pane gate instead, so this banner only shows for
// an in-progress background upgrade or a blocking failure — never for the initial python bootstrap.
// It overlays content instead of taking layout space: the pages below are h-screen with
// overflow-hidden, so an in-flow banner would push their bottom edge (the composer toolbar) out of
// the viewport and clip it (issue #244).
const EnvStatusBanner = ({
  ui,
  onRetry,
  onOpenRuntimes
}: {
  ui: ProvisionUiState
  onRetry?: () => void
  onOpenRuntimes?: () => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const show = (ui.kind === 'preparing' && ui.scope === 'upgrade') || ui.kind === 'error'
  const readyAnnouncement = (
    <span
      className="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="env-status-ready-announcement"
    >
      {ui.kind === 'ready' ? t('Notebook environment ready') : ''}
    </span>
  )
  if (!show) return readyAnnouncement

  // A preparing banner is a compact single-line pill; an error can carry a longer provisioner reason,
  // so it uses a wider rounded card (matching the app's dialog chrome). This banner is the ONLY error
  // surface outside the notebook pane (it renders globally from App, incl. Home where there is no
  // EnvProvisionOverlay), so the reason must stay fully readable — bound it to a scrollable box rather
  // than clamping lines, which could hide the actionable tail. The source excerpt is already short
  // (provisioner-runtime.briefTail); full diagnostics also live in the logs.
  const isError = ui.kind === 'error'
  const recoveryBlocked = ui.kind === 'error' && ui.recoveryBlocked
  const onAction = recoveryBlocked ? (onOpenRuntimes ?? onRetry) : onRetry

  return (
    <>
      {readyAnnouncement}
      <div
        data-testid="env-status-banner"
        data-bottom-notice
        role={isError ? 'alert' : 'status'}
        aria-live={isError ? 'assertive' : 'polite'}
        className={`pointer-events-auto fixed bottom-3 right-3 z-toast w-[min(420px,calc(100vw-24px))] shadow-dialog ${
          isError
            ? 'rounded-2xl bg-card text-left'
            : 'border border-border bg-card text-foreground flex items-center justify-center gap-2 rounded-3xl px-4 py-2 text-center text-xs'
        }`}
      >
        {ui.kind === 'error' ? (
          <ErrorNotice
            title={recoveryBlocked ? t('Runtime recovery blocked') : t('Environment update failed')}
            description={
              recoveryBlocked
                ? t(
                    'Use Recheck to retry safe recovery. Only confirmed stopped operations can be reconciled; permissions and repair requirements remain in force.'
                  )
                : ui.message
            }
            className="[&_p]:max-h-28 [&_p]:overflow-y-auto"
            primaryButton={
              onAction
                ? {
                    label: recoveryBlocked
                      ? onOpenRuntimes
                        ? t('Open Settings')
                        : t('Recheck')
                      : t('Retry'),
                    onClick: onAction,
                    testId: 'env-status-banner-retry'
                  }
                : undefined
            }
          />
        ) : ui.download ? (
          // Task 8: keep the existing overall provision phase text (with its percent), and render the
          // shared DownloadProgressLine (speed/ETA + resume bar) BELOW it — not a second overall bar.
          <div className="flex min-w-56 flex-col text-left">
            <span>
              {t('Updating the notebook environment… {{percent}}%', {
                percent: Math.round(ui.progress * 100)
              })}
            </span>
            <DownloadProgressLine progress={ui.download} />
          </div>
        ) : (
          <span>
            {t('Updating the notebook environment… {{percent}}%', {
              percent: Math.round(ui.progress * 100)
            })}
          </span>
        )}
      </div>
    </>
  )
}

export { EnvStatusBanner }
