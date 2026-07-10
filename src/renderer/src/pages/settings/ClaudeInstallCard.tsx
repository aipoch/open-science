import { useState } from 'react'

import type { ClaudeInstallSource } from '../../../../shared/settings'
import { CLAUDE_INSTALL_SOURCES } from '../../../../shared/settings'

type ClaudeInstallCardProps = {
  isInstalling: boolean
  installLogs: string[]
  // Whether npm is available on the host; disables/deprioritizes the npm-mirror source when false.
  npmAvailable: boolean
  onInstall: (source: ClaudeInstallSource) => void
}

// Source picker + one-click installer with a live log pane and an always-visible, copyable command so
// manual installers are never blocked. Shared by the onboarding wizard and the settings page.
const ClaudeInstallCard = ({
  isInstalling,
  installLogs,
  npmAvailable,
  onInstall
}: ClaudeInstallCardProps): React.JSX.Element => {
  const [source, setSource] = useState<ClaudeInstallSource>(
    npmAvailable ? 'npm-mirror' : 'official-script'
  )
  const selectedSource = CLAUDE_INSTALL_SOURCES.find((item) => item.id === source)
  const npmMissing = source === 'npm-mirror' && !npmAvailable

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="install-source">
          Install source
        </label>
        <select
          id="install-source"
          aria-label="Install source"
          value={source}
          disabled={isInstalling}
          onChange={(event) => setSource(event.target.value as ClaudeInstallSource)}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring"
        >
          {CLAUDE_INSTALL_SOURCES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
              {item.requiresNpm && !npmAvailable ? ' (npm not found)' : ''}
            </option>
          ))}
        </select>
      </div>

      {selectedSource ? (
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
        <p className="mt-2 text-xs text-destructive" role="alert">
          npm was not found on this machine. Use the official script or install npm first.
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => onInstall(source)}
        disabled={isInstalling || npmMissing}
        className="mt-3 rounded-lg border border-primary bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
      >
        {isInstalling ? 'Installing…' : 'Install with one click'}
      </button>

      {installLogs.length > 0 ? (
        <pre
          className="mt-3 max-h-48 overflow-auto rounded-lg bg-foreground/5 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/80"
          aria-label="Install log"
        >
          {installLogs.join('')}
        </pre>
      ) : null}
    </div>
  )
}

export { ClaudeInstallCard }
