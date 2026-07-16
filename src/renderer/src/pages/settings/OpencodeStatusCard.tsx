import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { OpencodeInfo } from '../../../../shared/settings'

type OpencodeStatusCardProps = {
  opencode: OpencodeInfo
  isDetecting: boolean
  onDetect: () => void
}

// Shows whether a runnable opencode executable was found (with its resolved path) plus a re-detect
// action, mirroring ClaudeStatusCard. opencode is installed by the user (e.g. `brew install opencode`);
// the app only detects it, so a missing binary links to opencode's install docs rather than offering
// an in-app install.
const OpencodeStatusCard = ({
  opencode,
  isDetecting,
  onDetect
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
              {found ? 'opencode is installed' : 'opencode not detected'}
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
          </dl>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            Install opencode (see{' '}
            <ExternalTextLink href="https://opencode.ai/docs">opencode.ai/docs</ExternalTextLink>),
            then re-detect. Your opencode providers and login are used as-is.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export { OpencodeStatusCard }
