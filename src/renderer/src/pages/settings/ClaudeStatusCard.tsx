import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { ClaudeInfo } from '../../../../shared/settings'
import { RuntimeUninstallControl } from './RuntimeUninstallControl'

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
  // Whether an install is running (global, either framework); locks the Uninstall button mid-operation.
  isInstalling?: boolean
  // The Uninstall button always shows for a detected runtime (omitting onUninstall, as onboarding does,
  // hides it entirely). `managed` gates whether it's actionable: only an app-managed binary (one the app
  // owns in its data dir) can be removed in-app. A non-managed (PATH/npm) install shows a greyed button
  // with a `?` explaining manual removal; the active runtime is greyed with a "switch first" `?`.
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
  isInstalling = false,
  onUninstall
}: ClaudeStatusCardProps): React.JSX.Element => {
  // Only an installed runtime can be chosen as the active framework — switching to an uninstalled one
  // would leave sessions with no agent. An uninstalled card shows no radio and isn't clickable.
  const selectable = Boolean(onSelect) && claudeReady

  const heading = (
    <>
      {selectable ? (
        <span
          aria-hidden="true"
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-full border',
            active ? 'border-primary' : 'border-muted-foreground/50'
          )}
        >
          {active ? <span className="size-2 rounded-full bg-primary" /> : null}
        </span>
      ) : null}
      <span className="text-sm font-medium text-foreground">
        {claudeReady ? 'Claude is installed' : 'Claude not detected'}
      </span>
      {claudeReady ? (
        <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
      ) : (
        <XCircle className="size-4 text-muted-foreground" aria-hidden="true" />
      )}
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
          {selectable ? (
            <button
              type="button"
              role="radio"
              aria-checked={active}
              aria-label="Use Claude Code"
              onClick={onSelect}
              disabled={selectDisabled}
              className="-m-1 flex cursor-pointer items-center gap-2 rounded-md p-1 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
            >
              {heading}
            </button>
          ) : (
            <div className="flex items-center gap-2">{heading}</div>
          )}
          <div className="flex items-center gap-2">
            {onUninstall && claude.resolvedPath ? (
              <RuntimeUninstallControl
                label="Claude"
                uninstallCommand="npm uninstall -g @anthropic-ai/claude-code"
                managed={managed}
                active={active}
                isUninstalling={isUninstalling}
                isDetecting={isDetecting}
                isInstalling={isInstalling}
                onUninstall={onUninstall}
              />
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
