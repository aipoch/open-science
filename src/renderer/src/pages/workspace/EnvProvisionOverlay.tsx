import { ErrorNotice } from '@/components/error-notice'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DownloadProgressLine } from '@/components/DownloadProgressLine'
import type { ProvisionUiState } from './provisioning-view'
import { provisionProgressText } from './provision-progress-text'

// Reusable provisioning progress surface. Rendered as a greyed overlay over the notebook pane, and
// (compact) inside the onboarding step and the launch banner. Returns null when the env is ready.
const EnvProvisionOverlay = ({
  ui,
  onRetry
}: {
  ui: ProvisionUiState
  onRetry?: () => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [dismissedErrorKey, setDismissedErrorKey] = useState<string | undefined>(undefined)

  if (ui.kind === 'ready') return null
  if (ui.kind === 'error') {
    const errorKey = JSON.stringify([ui.message, ui.scope ?? null, ui.sessionId ?? null])
    if (dismissedErrorKey === errorKey) return null
    return (
      <div
        data-testid="notebook-env-gate"
        role="alert"
        aria-live="assertive"
        className="absolute inset-0 z-20 flex items-center justify-center bg-bg-000/80 p-6 backdrop-blur-sm"
      >
        <ErrorNotice
          className="max-w-md [&_p]:max-h-24 [&_p]:overflow-y-auto"
          title={t('Environment setup needs attention')}
          description={ui.message}
          dismissButton={{
            label: t('Close'),
            onClick: () => setDismissedErrorKey(errorKey),
            testId: 'notebook-env-dismiss'
          }}
          primaryButton={
            onRetry
              ? { label: t('Retry'), onClick: onRetry, testId: 'notebook-env-retry' }
              : undefined
          }
        />
      </div>
    )
  }

  const title =
    ui.scope === 'r'
      ? 'Preparing R environment (~1GB, first time only)…'
      : ui.scope === 'upgrade'
        ? 'Updating the notebook environment…'
        : 'Preparing Python environment…'
  const progressText = provisionProgressText(t, ui.event)

  return (
    <div
      data-testid="notebook-env-gate"
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-bg-000/80 p-6 text-center backdrop-blur-sm"
    >
      <p className="text-sm font-medium text-text-000">{t(title)}</p>
      <>
        {progressText ? <p className="text-xs text-text-300">{progressText}</p> : null}
        {/* §3.1: the overall provision bar (fetch → verify → seed) and the download sub-line
              coexist — the download is one phase of provisioning, so the coarse bar stays visible
              for overall position while the detail line adds speed/ETA/resume during the fetch. */}
        <div
          className="h-1.5 w-56 overflow-hidden rounded-full bg-bg-300"
          role="progressbar"
          aria-label={t('Environment setup progress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ui.progress * 100)}
        >
          <div
            className="h-full w-full origin-left bg-primary transition-transform duration-150 ease-out motion-reduce:transition-none"
            style={{ transform: `scaleX(${ui.progress})` }}
          />
        </div>
        {ui.download ? (
          <div className="w-56">
            <DownloadProgressLine progress={ui.download} />
          </div>
        ) : null}
      </>
    </div>
  )
}

export { EnvProvisionOverlay }
