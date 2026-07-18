import { CheckCircle2, RefreshCw, Trash2, XCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
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
  // Marks this as the runtime the selected agent framework uses, so it stands out when both cards show.
  active?: boolean
  // Selects Claude as the active framework (settings only). The card's title acts as a radio option;
  // omitting it (onboarding/embedded) renders a plain, non-selectable header.
  onSelect?: () => void
  // Locks selection (e.g. while an install/uninstall is in flight) so the backend can't be switched
  // mid-operation.
  selectDisabled?: boolean
  // Uninstall is offered only for the app-managed install (a binary the app owns in its data dir).
  // Omitting onUninstall (as onboarding does) hides the action entirely. Disabled while this is the
  // active runtime — the user must switch to the other framework first.
  managed?: boolean
  isUninstalling?: boolean
  onUninstall?: () => void
}

// Shows whether a runnable claude executable was found, with its resolved path/version, plus a
// re-detect action. In settings the title doubles as a radio option to make Claude the active
// framework. Shared by the onboarding wizard (non-selectable) and the settings page.
const ClaudeStatusCard = ({
  claude,
  claudeReady,
  isDetecting,
  onDetect,
  embedded = false,
  active = false,
  onSelect,
  selectDisabled = false,
  managed = false,
  isUninstalling = false,
  onUninstall
}: ClaudeStatusCardProps): React.JSX.Element => {
  const heading = (
    <>
      {claudeReady ? (
        <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
      ) : (
        <XCircle className="size-4 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="text-sm font-medium text-foreground">
        {claudeReady ? 'Claude is installed' : 'Claude not detected'}
      </span>
      {active ? <Badge variant="secondary">Active</Badge> : null}
    </>
  )

  return (
    <Card
      className={cn(
        'gap-0 rounded-lg py-0',
        active && !embedded && 'ring-1 ring-primary',
        embedded && 'rounded-none bg-transparent ring-0'
      )}
    >
      <CardContent className={cn('p-4', embedded && 'px-0 py-0')}>
        <div className="flex items-center justify-between gap-3">
          {onSelect ? (
            <button
              type="button"
              role="radio"
              aria-checked={active}
              aria-label="Use Claude Code"
              onClick={onSelect}
              disabled={selectDisabled}
              className="-m-1 flex cursor-pointer items-center gap-2 rounded-md p-1 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
            >
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-full border',
                  active ? 'border-primary' : 'border-muted-foreground/50'
                )}
              >
                {active ? <span className="size-2 rounded-full bg-primary" /> : null}
              </span>
              {heading}
            </button>
          ) : (
            <div className="flex items-center gap-2">{heading}</div>
          )}
          <div className="flex items-center gap-2">
            {managed && onUninstall && claude.resolvedPath ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={onUninstall}
                disabled={active || isUninstalling || isDetecting}
                title={
                  active ? 'Switch to the other framework before uninstalling Claude' : undefined
                }
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
}

export { ClaudeStatusCard }
