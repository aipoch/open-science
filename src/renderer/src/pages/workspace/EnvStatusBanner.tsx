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
  const show = (ui.kind === 'preparing' && ui.scope === 'upgrade') || ui.kind === 'error'
  if (!show) return null

  return (
    <div
      data-testid="env-status-banner"
      className="fixed left-1/2 top-2 z-50 flex max-w-[min(90vw,640px)] -translate-x-1/2 items-center justify-center gap-2 rounded-full border border-border-100 bg-bg-200 px-3 py-1 text-center text-xs text-text-100 shadow-md"
    >
      {ui.kind === 'error' ? (
        <>
          <span>Environment update failed — {ui.message}</span>
          {onRetry ? (
            <button
              type="button"
              data-testid="env-status-banner-retry"
              onClick={onRetry}
              className="rounded border border-border-100 px-2 py-0.5 text-xs text-text-100 hover:bg-bg-300"
            >
              Retry
            </button>
          ) : null}
        </>
      ) : ui.download ? (
        // Task 8: reuse the shared DownloadProgressLine (with its resume/pulse bar) so the upgrade
        // banner renders speed/ETA and a stall reads as "resuming" consistently with the other hosts.
        // The banner drops its single-line pill shape to a small stacked block for this phase.
        <div className="flex min-w-56 flex-col text-left">
          <span>Updating the notebook environment…</span>
          <DownloadProgressLine progress={ui.download} />
        </div>
      ) : (
        <span>Updating the notebook environment… {Math.round(ui.progress * 100)}%</span>
      )}
    </div>
  )
}

export { EnvStatusBanner }
