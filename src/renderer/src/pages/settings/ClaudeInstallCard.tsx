import { useMemo, useState } from 'react'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { ClaudeInstallSource } from '../../../../shared/settings'
import { getClaudeInstallSources, getNodeInstallHint } from '../../../../shared/settings'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'

type ClaudeInstallCardProps = {
  isInstalling: boolean
  installLogs: string[]
  // Whether npm is available on the host; disables/deprioritizes the npm source when false.
  npmAvailable: boolean
  onInstall: (source: ClaudeInstallSource) => void
  embedded?: boolean
}

// Source picker + one-click installer with a live log pane and an always-visible, copyable command so
// manual installers are never blocked. Shared by the onboarding wizard and the settings page.
const ClaudeInstallCard = ({
  isInstalling,
  installLogs,
  npmAvailable,
  onInstall,
  embedded = false
}: ClaudeInstallCardProps): React.JSX.Element => {
  // Default to the app-managed download — it needs no Node.js/npm and works behind region blocks.
  const [source, setSource] = useState<ClaudeInstallSource>('managed')
  // Sources carry platform-specific copy (e.g. install.ps1 vs install.sh), so resolve them for the
  // host the app is running on.
  const installSources = useMemo(() => getClaudeInstallSources(window.api?.platform), [])
  const nodeHint = useMemo(() => getNodeInstallHint(window.api?.platform), [])
  const selectedSource = installSources.find((item) => item.id === source)
  const npmMissing = source === 'npm' && !npmAvailable

  // Option label with an inline "(npm not found)" hint for sources that need npm when it's missing.
  const sourceLabel = (item: (typeof installSources)[number]): string =>
    `${item.label}${item.requiresNpm && !npmAvailable ? ' (npm not found)' : ''}`

  return (
    <Card className={cn('gap-0 py-0', embedded && 'rounded-none bg-transparent ring-0')}>
      <CardContent className={cn('p-4', embedded && 'px-0 py-0')}>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="install-source">
            Install source
          </label>
          <Select
            value={source}
            disabled={isInstalling}
            onValueChange={(next) => setSource(next as ClaudeInstallSource)}
          >
            <SelectTrigger id="install-source" aria-label="Install source">
              <span className="truncate">{selectedSource ? sourceLabel(selectedSource) : ''}</span>
            </SelectTrigger>
            <SelectContent>
              {installSources.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {sourceLabel(item)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selectedSource?.description ? (
          <p className="mt-3 text-xs text-muted-foreground">{selectedSource.description}</p>
        ) : null}

        {selectedSource?.displayCommand ? (
          <div className="mt-3">
            <span className="text-xs font-medium text-muted-foreground">Command</span>
            <pre
              className="mt-1 overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground"
              aria-label="Install command"
            >
              {selectedSource.displayCommand}
            </pre>
          </div>
        ) : null}

        {npmMissing ? (
          <div className="mt-2 space-y-1.5 text-xs text-destructive" role="alert">
            <p>
              npm was not found. Switch to the official installer above (it needs no Node.js), or
              install Node.js first — it includes npm.
            </p>
            {nodeHint.command ? (
              <pre
                className="overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-foreground"
                aria-label="Node.js install command"
              >
                {nodeHint.command}
              </pre>
            ) : null}
            <p className="text-muted-foreground">
              Or download it from{' '}
              <ExternalTextLink href={nodeHint.url}>{nodeHint.url}</ExternalTextLink>, then
              re-detect above so npm is picked up.
            </p>
          </div>
        ) : null}

        <Button
          type="button"
          size="sm"
          onClick={() => onInstall(source)}
          disabled={isInstalling || npmMissing}
          className="mt-3"
        >
          {isInstalling ? 'Installing…' : 'Install with one click'}
        </Button>

        {installLogs.length > 0 ? (
          <pre
            className="mt-3 max-h-48 overflow-auto rounded-lg bg-foreground/5 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/80"
            aria-label="Install log"
          >
            {installLogs.join('')}
          </pre>
        ) : null}
      </CardContent>
    </Card>
  )
}

export { ClaudeInstallCard }
