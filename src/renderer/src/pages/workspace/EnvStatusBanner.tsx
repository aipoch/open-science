import type { ProvisionUiState } from './provisioning-view'

// Thin top-of-app banner for the launch-time upgrade gate (spec §6.2). First-run python preparation
// is surfaced by the onboarding step and the notebook pane gate instead, so this banner only shows for
// an in-progress background upgrade or a blocking failure — never for the initial python bootstrap.
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
      className="flex w-full items-center justify-center gap-3 bg-bg-200 px-4 py-1.5 text-center text-xs text-text-100"
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
      ) : (
        <span>Updating the notebook environment… {Math.round(ui.progress * 100)}%</span>
      )}
    </div>
  )
}

export { EnvStatusBanner }
