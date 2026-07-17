import { useMemo } from 'react'
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type {
  ClaudeInstallProgressEvent,
  ClaudeInstallSource,
  OpencodeInfo
} from '../../../../shared/settings'
import { getOpencodeInstallSources } from '../../../../shared/settings'
import { ClaudeInstallCard } from './ClaudeInstallCard'

type OpencodeStatusCardProps = {
  opencode: OpencodeInfo
  isDetecting: boolean
  onDetect: () => void
  // Install picker (managed / npm / script, managed first) shown when opencode isn't detected.
  isInstalling: boolean
  installLogs: string[]
  installProgress: ClaudeInstallProgressEvent | null
  installError: string | undefined
  npmAvailable: boolean
  onInstall: (source: ClaudeInstallSource) => void
}

// Shows whether a runnable opencode executable was found (path + version) plus a re-detect action,
// mirroring ClaudeStatusCard. When not detected it offers an app-managed install (downloads the native
// binary, first recommendation) with a link to opencode's docs for a manual install.
const OpencodeStatusCard = ({
  opencode,
  isDetecting,
  onDetect,
  isInstalling,
  installLogs,
  installProgress,
  installError,
  npmAvailable,
  onInstall
}: OpencodeStatusCardProps): React.JSX.Element => {
  const found = Boolean(opencode.resolvedPath)
  const installSources = useMemo(() => getOpencodeInstallSources(window.api?.platform), [])

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
