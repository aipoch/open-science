import { useMemo } from 'react'
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { RuntimeUninstallControl } from './RuntimeUninstallControl'
import type {
  ClaudeInstallProgressEvent,
  ClaudeInstallSource,
  OpencodeInfo
} from '../../../../shared/settings'
import { getOpencodeInstallSources } from '../../../../shared/settings'
import { ClaudeInstallCard } from './ClaudeInstallCard'

type OpencodeStatusCardProps = {
  opencode: OpencodeInfo
  // Whether the detected opencode is actually runnable (preflight ran `--version`). Selection gates on
  // this, not on a mere cached path, so a stale/corrupt binary can't be chosen as the active backend.
  opencodeReady: boolean
  isDetecting: boolean
  onDetect: () => void
  // Install picker (managed / npm / script, managed first) shown when opencode isn't detected.
  // `isInstalling` is OpenCode's OWN install state (drives this card's progress/label); `installBusy`
  // is true while ANY runtime installs and only locks the controls (one install at a time).
  isInstalling: boolean
  installLogs: string[]
  installProgress: ClaudeInstallProgressEvent | null
  installError: string | undefined
  installBusy?: boolean
  npmAvailable: boolean
  onInstall: (source: ClaudeInstallSource) => void
  // Marks this as the runtime the selected agent framework uses, so it stands out when both cards show.
  active?: boolean
  // Selects OpenCode as the active framework (settings only). The card's title acts as a radio option.
  onSelect?: () => void
  // Locks selection (e.g. while an install/uninstall is in flight) so the backend can't be switched
  // mid-operation.
  selectDisabled?: boolean
  // The Uninstall button always shows for a detected runtime (omitting onUninstall hides it entirely).
  // `managed` gates whether it's actionable: only an app-managed binary (one the app owns in its data
  // dir) can be removed in-app. A non-managed (PATH/npm) install shows a greyed button with a `?`
  // explaining manual removal; the active runtime is greyed with a "switch first" `?`.
  managed?: boolean
  isUninstalling?: boolean
  onUninstall?: () => void
}

// Shows whether a runnable opencode executable was found (path + version) plus a re-detect action,
// mirroring ClaudeStatusCard. When not detected it offers an app-managed install (downloads the native
// binary, first recommendation) with a link to opencode's docs for a manual install.
const OpencodeStatusCard = ({
  opencode,
  opencodeReady,
  isDetecting,
  onDetect,
  isInstalling,
  installLogs,
  installProgress,
  installError,
  installBusy,
  npmAvailable,
  onInstall,
  active = false,
  onSelect,
  selectDisabled = false,
  managed = false,
  isUninstalling = false,
  onUninstall
}: OpencodeStatusCardProps): React.JSX.Element => {
  // Any install (this runtime's or another's) locks the uninstall button; default to this card's own.
  const anyInstalling = installBusy ?? isInstalling
  const found = Boolean(opencode.resolvedPath)
  const installSources = useMemo(() => getOpencodeInstallSources(window.api?.platform), [])
  // Only a ready runtime can be chosen as the active framework — switching to a missing or unrunnable
  // agent would strand sessions. Gate on preflight readiness (matches Claude's claudeReady), not a mere
  // cached path, so a stale/corrupt binary shows no radio and isn't clickable.
  const selectable = Boolean(onSelect) && opencodeReady

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
        {found ? 'OpenCode is installed' : 'OpenCode not detected'}
      </span>
      {found ? (
        <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
      ) : (
        <XCircle className="size-4 text-muted-foreground" aria-hidden="true" />
      )}
      {active ? <Badge variant="secondary">Active</Badge> : null}
    </>
  )

  return (
    <Card className={cn('gap-0 rounded-lg py-0', active && 'ring-1 ring-primary')}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3">
          {selectable ? (
            <button
              type="button"
              role="radio"
              aria-checked={active}
              aria-label="Use OpenCode"
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
            {onUninstall && found ? (
              <RuntimeUninstallControl
                label="OpenCode"
                uninstallCommand="npm uninstall -g opencode-ai"
                managed={managed}
                active={active}
                isUninstalling={isUninstalling}
                isDetecting={isDetecting}
                isInstalling={anyInstalling}
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
              <RefreshCw className={isDetecting ? 'animate-spin' : ''} aria-hidden="true" />
              {isDetecting ? 'Detecting…' : 'Re-detect'}
            </Button>
          </div>
        </div>
        {found ? (
          <dl className="mt-3 space-y-1 text-xs text-muted-foreground">
            <div className="flex gap-2">
              <dt className="shrink-0">Path</dt>
              <dd className="truncate font-mono text-foreground/80" title={opencode.resolvedPath}>
                {opencode.resolvedPath}
              </dd>
            </div>
            {opencode.version ? (
              <div className="flex gap-2">
                <dt className="shrink-0">Version</dt>
                <dd className="font-mono text-foreground/80">{opencode.version}</dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <div className="mt-3 space-y-3">
            <p className="text-xs text-muted-foreground">
              OpenCode is required for this framework. Install it below, or install it manually (see{' '}
              <ExternalTextLink href="https://opencode.ai/docs">opencode.ai/docs</ExternalTextLink>)
              and re-detect.
            </p>
            <ClaudeInstallCard
              embedded
              sources={installSources}
              isInstalling={isInstalling}
              installLogs={installLogs}
              installProgress={installProgress}
              installError={installError}
              busy={anyInstalling}
              npmAvailable={npmAvailable}
              onInstall={onInstall}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export { OpencodeStatusCard }
