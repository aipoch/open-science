import { CheckCircle2, XCircle } from 'lucide-react'

import type { ClaudeInfo } from '../../../../shared/settings'

type ClaudeStatusCardProps = {
  claude: ClaudeInfo
  claudeReady: boolean
  isDetecting: boolean
  onDetect: () => void
}

// Shows whether a runnable claude executable was found, with its resolved path/version, plus a
// re-detect action. Shared by the onboarding wizard and the settings page.
const ClaudeStatusCard = ({
  claude,
  claudeReady,
  isDetecting,
  onDetect
}: ClaudeStatusCardProps): React.JSX.Element => (
  <div className="rounded-xl border border-border p-4">
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        {claudeReady ? (
          <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
        ) : (
          <XCircle className="size-4 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="text-sm font-medium text-foreground">
          {claudeReady ? 'Claude is installed' : 'Claude not detected'}
        </span>
      </div>
      <button
        type="button"
        onClick={onDetect}
        disabled={isDetecting}
        className="rounded-lg border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-50"
      >
        {isDetecting ? 'Detecting…' : 'Re-detect'}
      </button>
    </div>
    {claude.resolvedPath ? (
      <dl className="mt-3 space-y-1 text-xs text-muted-foreground">
        <div className="flex gap-2">
          <dt className="shrink-0">Path</dt>
          <dd className="truncate font-mono text-foreground/80" title={claude.resolvedPath}>
            {claude.resolvedPath}
          </dd>
        </div>
        {claude.version ? (
          <div className="flex gap-2">
            <dt className="shrink-0">Version</dt>
            <dd className="font-mono text-foreground/80">{claude.version}</dd>
          </div>
        ) : null}
      </dl>
    ) : (
      <p className="mt-3 text-xs text-muted-foreground">
        Install Claude below, or run the command manually, then re-detect.
      </p>
    )}
  </div>
)

export { ClaudeStatusCard }
