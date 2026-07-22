import { DownloadProgressLine } from '@/components/DownloadProgressLine'
import type { ProvisionUiState } from './provisioning-view'

// Reusable provisioning progress surface. Rendered as a greyed overlay over the notebook pane, and
// (compact) inside the onboarding step and the launch banner. Returns null when the env is ready.
const EnvProvisionOverlay = ({
  ui,
  onRetry
}: {
  ui: ProvisionUiState
  onRetry?: () => void
}): React.JSX.Element | null => {
  if (ui.kind === 'ready') return null

  const title =
    ui.kind === 'error'
      ? 'Environment setup needs attention'
      : ui.scope === 'r'
        ? 'Preparing R environment (~1GB, first time only)…'
        : ui.scope === 'upgrade'
          ? 'Updating the notebook environment…'
          : 'Preparing Python environment…'

  return (
    <div
      data-testid="notebook-env-gate"
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-bg-000/80 p-6 text-center backdrop-blur-sm"
    >
      <p className="text-sm font-medium text-text-000">{title}</p>
      {ui.kind === 'preparing' ? (
        <>
          {ui.message ? <p className="text-xs text-text-300">{ui.message}</p> : null}
          {ui.download ? (
            // During the pack download, show the shared speed/ETA/resume line instead of the coarse
            // overall bar so a weak-network stall reads as "resuming" rather than a frozen bar.
            <div className="w-56">
              <DownloadProgressLine progress={ui.download} />
            </div>
          ) : (
            <div className="h-1.5 w-56 overflow-hidden rounded-full bg-bg-300">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${Math.round(ui.progress * 100)}%` }}
              />
            </div>
          )}
        </>
      ) : (
        <>
          <p className="text-xs text-text-300">{ui.message}</p>
          {onRetry ? (
            <button
              type="button"
              data-testid="notebook-env-retry"
              onClick={onRetry}
              className="rounded border border-border-100 px-3 py-1 text-xs text-text-100 hover:bg-bg-300"
            >
              Retry
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}

export { EnvProvisionOverlay }
