import { useMemo } from 'react'
import { CheckCircle2, RefreshCw, Trash2, XCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type {
  ClaudeInstallProgressEvent,
  CodexInstallSource,
  CodexInfo
} from '../../../../shared/settings'
import { getCodexInstallSources } from '../../../../shared/settings'
import { ClaudeInstallCard } from './ClaudeInstallCard'

type CodexStatusCardProps = {
  codex: CodexInfo
  codexReady: boolean
  isDetecting: boolean
  onDetect: () => void
  // `isInstalling` is Codex's OWN install state (drives this card's progress/label); `installBusy` is
  // true while ANY runtime installs and only locks the controls (one install at a time).
  isInstalling: boolean
  installLogs: string[]
  installProgress: ClaudeInstallProgressEvent | null
  installError: string | undefined
  installBusy?: boolean
  npmAvailable: boolean
  onInstall: (source: CodexInstallSource) => void
  active?: boolean
  onSelect?: () => void
  selectDisabled?: boolean
  managed?: boolean
  isUninstalling?: boolean
  onUninstall?: () => void
}

const CodexStatusCard = ({
  codex,
  codexReady,
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
}: CodexStatusCardProps): React.JSX.Element => {
  // Any install (this runtime's or another's) locks the uninstall button; default to this card's own.
  const anyInstalling = installBusy ?? isInstalling
  const found = Boolean(codex.resolvedPath)
  const installSources = useMemo(() => getCodexInstallSources(), [])
  const selectable = Boolean(onSelect) && codexReady
  const statusLabel = codexReady
    ? 'Codex is ready'
    : found
      ? 'Codex installation needs repair'
      : 'Codex not detected'

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
      <span className="text-sm font-medium text-foreground">{statusLabel}</span>
      {codexReady ? (
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
              aria-label="Use Codex"
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
            {managed && onUninstall && found ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={onUninstall}
                disabled={active || isUninstalling || isDetecting || anyInstalling}
                title={
                  active ? 'Switch to the other framework before uninstalling Codex' : undefined
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
              <RefreshCw className={isDetecting ? 'animate-spin' : ''} aria-hidden="true" />
              {isDetecting ? 'Detecting…' : 'Re-detect'}
            </Button>
          </div>
        </div>
        {found ? (
          <dl className="mt-3 space-y-1 text-xs text-muted-foreground">
            <div className="flex gap-2">
              <dt className="shrink-0">Adapter path</dt>
              <dd className="truncate font-mono text-foreground/80" title={codex.resolvedPath}>
                {codex.resolvedPath}
              </dd>
            </div>
            {codex.version ? (
              <div className="flex gap-2">
                <dt className="shrink-0">Adapter version</dt>
                <dd className="font-mono text-foreground/80">{codex.version}</dd>
              </div>
            ) : null}
            {codex.nativeVersion ? (
              <div className="flex gap-2">
                <dt className="shrink-0">Native Codex version</dt>
                <dd className="font-mono text-foreground/80">{codex.nativeVersion}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        {!codexReady ? (
          <div className="mt-3 space-y-3">
            <p className="text-xs text-muted-foreground">
              {found
                ? 'The adapter or its paired native Codex runtime did not pass detection. Reinstall the managed pair below, or repair your manual installation and re-detect.'
                : 'Codex ACP is required for this framework. Install it below, or install it manually and re-detect.'}
            </p>
            <ClaudeInstallCard
              embedded
              sources={installSources}
              isInstalling={isInstalling}
              installLogs={installLogs}
              installProgress={installProgress}
              installError={installError}
              installBusy={anyInstalling}
              npmAvailable={npmAvailable}
              onInstall={(source) => {
                if (source !== 'official-script') onInstall(source)
              }}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

export { CodexStatusCard }
