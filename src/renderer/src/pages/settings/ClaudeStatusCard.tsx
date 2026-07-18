import { CheckCircle2, RefreshCw, Trash2, XCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { ClaudeInfo } from '../../../../shared/settings'

type ClaudeStatusCardProps = {
  claude: ClaudeInfo
  claudeReady: boolean
  isDetecting: boolean
  onDetect: () => void
  embedded?: boolean
  // Uninstall is offered only for the app-managed install (a binary the app owns in its data dir).
  // Omitting onUninstall (as onboarding does) hides the action entirely.
  managed?: boolean
  isUninstalling?: boolean
  onUninstall?: () => void
}

// Shows whether a runnable claude executable was found, with its resolved path/version, plus a
// re-detect action. Shared by the onboarding wizard and the settings page.
const ClaudeStatusCard = ({
  claude,
  claudeReady,
  isDetecting,
  onDetect,
  embedded = false,
  managed = false,
  isUninstalling = false,
  onUninstall
}: ClaudeStatusCardProps): React.JSX.Element => (
  <Card className={cn('gap-0 rounded-lg py-0', embedded && 'rounded-none bg-transparent ring-0')}>
    <CardContent className={cn('p-4', embedded && 'px-0 py-0')}>
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
        <div className="flex items-center gap-2">
          {managed && onUninstall && claude.resolvedPath ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={onUninstall}
              disabled={isUninstalling || isDetecting}
            >
              <Trash2 aria-hidden="true" />
              Uninstall
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDetect}
            disabled={isDetecting || isUninstalling}
          >
            {/* Circular-arrows icon conveys the re-scan action; spins while a detection is in flight. */}
            <RefreshCw className={isDetecting ? 'animate-spin' : ''} aria-hidden="true" />
            {isDetecting ? 'Detecting…' : 'Re-detect'}
          </Button>
        </div>
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
    </CardContent>
  </Card>
)

export { ClaudeStatusCard }
