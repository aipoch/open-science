import { CheckCircle2, Download, RefreshCw, XCircle } from 'lucide-react'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { ClaudeInstallProgressEvent, OpencodeInfo } from '../../../../shared/settings'

type OpencodeStatusCardProps = {
  opencode: OpencodeInfo
  isDetecting: boolean
  onDetect: () => void
  // App-managed install (first recommendation, like Claude) shown when opencode isn't detected.
  isInstalling: boolean
  installProgress: ClaudeInstallProgressEvent | null
  installError: string | undefined
  onInstall: () => void
}

// Shows whether a runnable opencode executable was found (path + version) plus a re-detect action,
// mirroring ClaudeStatusCard. When not detected it offers an app-managed install (downloads the native
// binary, first recommendation) with a link to opencode's docs for a manual install.
const OpencodeStatusCard = ({
  opencode,
  isDetecting,
  onDetect,
  isInstalling,
  installProgress,
  installError,
  onInstall
}: OpencodeStatusCardProps): React.JSX.Element => {
  const found = Boolean(opencode.resolvedPath)

  return (
    <Card className="gap-0 rounded-lg py-0">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {found ? (
              <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
            ) : (
              <XCircle className="size-4 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="text-sm font-medium text-foreground">
              {found ? 'OpenCode is installed' : 'OpenCode not detected'}
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDetect}
            disabled={isDetecting}
          >
            <RefreshCw className={isDetecting ? 'animate-spin' : ''} aria-hidden="true" />
            {isDetecting ? 'Detecting…' : 'Re-detect'}
          </Button>
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
              Install OpenCode with one click, or install it manually (see{' '}
              <ExternalTextLink href="https://opencode.ai/docs">opencode.ai/docs</ExternalTextLink>)
              and re-detect.
            </p>
            <Button type="button" onClick={onInstall} disabled={isInstalling}>
              <Download className={isInstalling ? 'animate-pulse' : ''} aria-hidden="true" />
              {isInstalling ? 'Installing…' : 'Install OpenCode'}
            </Button>
            {isInstalling && installProgress ? (
              <p className="text-xs text-muted-foreground" role="status">
                {installProgress.phase === 'downloading' && installProgress.totalBytes
                  ? `Downloading… ${Math.round(((installProgress.receivedBytes ?? 0) / installProgress.totalBytes) * 100)}%`
                  : `${installProgress.phase}…`}
              </p>
            ) : null}
            {installError ? (
              <p className="text-xs text-destructive" role="alert">
                {installError}
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export { OpencodeStatusCard }
