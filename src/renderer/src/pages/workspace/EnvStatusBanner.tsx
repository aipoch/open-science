import { useTranslation } from 'react-i18next'

import { DownloadProgressLine } from '@/components/DownloadProgressLine'
import type { ProvisionUiState } from './provisioning-view'

// Floating top-of-app pill for the launch-time upgrade gate (spec §6.2). First-run python preparation
// is surfaced by the onboarding step and the notebook pane gate instead, so this banner only shows for
// an in-progress background upgrade or a blocking failure — never for the initial python bootstrap.
// It overlays content instead of taking layout space: the pages below are h-screen with
// overflow-hidden, so an in-flow banner would push their bottom edge (the composer toolbar) out of
// the viewport and clip it (issue #244).
const EnvStatusBanner = ({
  ui,
  onRetry
}: {
  ui: ProvisionUiState
  onRetry?: () => void
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

  return (
    <>
      {readyAnnouncement}
      <div
        data-testid="env-status-banner"
        role={isError ? 'alert' : 'status'}
        aria-live={isError ? 'assertive' : 'polite'}
        className={`fixed left-1/2 top-2 z-50 -translate-x-1/2 border border-border bg-card text-foreground shadow-dialog ${
          isError
            ? 'flex max-w-[min(90vw,560px)] items-start gap-3 rounded-xl px-4 py-3 text-left text-xs'
            : 'flex max-w-[min(90vw,640px)] items-center justify-center gap-2 rounded-full px-3 py-1 text-center text-xs'
        }`}
      >
        {ui.kind === 'error' ? (
          <>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground">{t('Environment update failed')}</p>
              <p className="mt-0.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">
                {ui.message}
              </p>
            </div>
            {onRetry ? (
              <button
                type="button"
                data-testid="env-status-banner-retry"
                onClick={onRetry}
                className="shrink-0 rounded-lg border border-border px-2 py-0.5 text-xs text-foreground hover:bg-muted"
              >
                {t('Retry')}
              </button>
            ) : null}
          </>
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
