import { ErrorNotice } from '@/components/error-notice'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DownloadProgressLine } from '@/components/DownloadProgressLine'
import type { ProvisionUiState } from './provisioning-view'

type ProvisionErrorUi = Extract<ProvisionUiState, { kind: 'error' }>

const provisionErrorKey = (ui: ProvisionErrorUi): string =>
  JSON.stringify([ui.message, ui.scope ?? null, ui.sessionId ?? null, ui.recoveryBlocked ?? false])

// Keep the provisioner reason fully readable on the global surface, including Home where there is no
// EnvProvisionOverlay. Keying this component by stable failure content preserves dismissal across
// status refreshes, while a changed failure or a non-error transition mounts a fresh notice.
const EnvironmentErrorBanner = ({
  ui,
  onRetry,
  onOpenRuntimes
}: {
  ui: ProvisionErrorUi
  onRetry?: () => void
  onOpenRuntimes?: () => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null

  const recoveryBlocked = ui.recoveryBlocked
  const onAction = recoveryBlocked ? (onOpenRuntimes ?? onRetry) : onRetry

  return (
    <div
      data-testid="env-status-banner"
      data-bottom-notice
      role="alert"
      aria-live="assertive"
      className="pointer-events-auto fixed right-3 bottom-3 z-toast w-[min(420px,calc(100vw-24px))] rounded-2xl bg-card text-left shadow-dialog"
    >
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
        dismissButton={{
          label: t('Close'),
          onClick: () => setDismissed(true),
          testId: 'env-status-banner-dismiss'
        }}
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
    </div>
  )
}

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

  if (ui.kind === 'error') {
    return (
      <>
        {readyAnnouncement}
        <EnvironmentErrorBanner
          key={provisionErrorKey(ui)}
          ui={ui}
          onRetry={onRetry}
          onOpenRuntimes={onOpenRuntimes}
        />
      </>
    )
  }

  // Preparing is a compact single-line pill; errors use the wider EnvironmentErrorBanner card.
  return (
    <>
      {readyAnnouncement}
      <div
        data-testid="env-status-banner"
        data-bottom-notice
        role="status"
        aria-live="polite"
        className="pointer-events-auto fixed right-3 bottom-3 z-toast flex w-[min(420px,calc(100vw-24px))] items-center justify-center gap-2 rounded-3xl border border-border bg-card px-4 py-2 text-center text-xs text-foreground shadow-dialog"
      >
        {ui.download ? (
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
