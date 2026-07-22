import { useState } from 'react'
import { ChevronDown, Download, Loader2 } from 'lucide-react'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type {
  ClaudeInstallProgressEvent,
  ClaudeInstallSource,
  ClaudeInstallSourceInfo
} from '../../../../shared/settings'
import { describeInstallProgress } from './claude-install-progress'
import { RuntimeUninstallControl } from './RuntimeUninstallControl'

type AgentFrameworkCardProps = {
  // Brand mark in the vendor's standard color (lobehub icon component, e.g. <Claude.Color />).
  icon: React.ReactNode
  // Display name ("Claude Agent", "OpenCode", "Codex").
  name: string
  // One-line summary of what the agent is, shown under the name.
  description: React.ReactNode
  // Preflight-passed runtimes are selectable and sit in the Installed group.
  ready: boolean
  // Detected version, rendered as a muted `vX.Y.Z` right after the name.
  version?: string
  // Resolved runtime/adapter path; its presence also gates the Uninstall control.
  path?: string
  // Repository/docs link shown under the path (e.g. the ACP adapter repo for ACP-based runtimes).
  sourceLabel: string
  sourceUrl: string
  // Explainer copy under a not-ready card (install/repair guidance).
  notReadyHint: React.ReactNode
  active: boolean
  onSelect: () => void
  selectDisabled: boolean
  // Uninstall control wiring, shared across frameworks via RuntimeUninstallControl.
  uninstallCommand: string
  managed: boolean
  isUninstalling: boolean
  // A detect run is in flight (the section-level Re-detect triggers all frameworks at once).
  isDetecting: boolean
  onUninstall: () => void
  // Install menu + progress wiring (only meaningful on not-ready cards).
  installSources: ClaudeInstallSourceInfo[]
  // True while THIS card's install is running: the button reads "Installing…" and the bar shows.
  installing: boolean
  // Global install-in-flight flag (any framework). RuntimeUninstallControl's contract locks every
  // card's Uninstall while ANY install runs — do not narrow this to this card's `installing`.
  installRunning: boolean
  // A global operation (another framework's install, or any uninstall) locks this card's Install.
  installDisabled: boolean
  installLogs: string[]
  installProgress: ClaudeInstallProgressEvent | null
  installError?: string
  npmAvailable: boolean
  onInstall: (source: ClaudeInstallSource) => void
}

// Install-source picker behind the card's single Install button. Choosing a source starts the
// install immediately; the trigger then flips to a disabled "Installing…" until the run ends.
const InstallSourceMenu = ({
  name,
  sources,
  installing,
  disabled,
  npmAvailable,
  onInstall
}: {
  name: string
  sources: ClaudeInstallSourceInfo[]
  installing: boolean
  disabled: boolean
  npmAvailable: boolean
  onInstall: (source: ClaudeInstallSource) => void
}): React.JSX.Element => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        size="sm"
        disabled={installing || disabled}
        aria-label={`Install ${name}`}
      >
        {installing ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <Download aria-hidden="true" />
        )}
        {installing ? 'Installing…' : 'Install'}
        {!installing ? <ChevronDown aria-hidden="true" /> : null}
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-80">
      <DropdownMenuLabel>Install source</DropdownMenuLabel>
      {sources.map((item) => {
        // Sources needing npm are disabled (not hidden) when npm is missing, so the option stays
        // discoverable with its unavailability spelled out.
        const npmMissing = item.requiresNpm && !npmAvailable
        return (
          <DropdownMenuItem
            key={item.id}
            disabled={npmMissing}
            onSelect={() => onInstall(item.id)}
            className="flex flex-col items-start gap-0.5"
          >
            <span>
              {item.label}
              {npmMissing ? ' (npm not found)' : ''}
            </span>
            {item.description ? (
              <span className="text-xs text-muted-foreground">{item.description}</span>
            ) : item.displayCommand ? (
              <span className="font-mono text-xs text-muted-foreground">{item.displayCommand}</span>
            ) : null}
          </DropdownMenuItem>
        )
      })}
    </DropdownMenuContent>
  </DropdownMenu>
)

// Unified agent-framework card for the settings Model panel. The whole card is the radio option
// that switches the active framework (only ready runtimes are selectable); the action column on
// the right carries the single relevant action — Uninstall for detected runtimes, an Install
// source menu otherwise — and stops the click from bubbling into a selection.
const AgentFrameworkCard = ({
  icon,
  name,
  description,
  ready,
  version,
  path,
  sourceLabel,
  sourceUrl,
  notReadyHint,
  active,
  onSelect,
  selectDisabled,
  uninstallCommand,
  managed,
  isUninstalling,
  isDetecting,
  onUninstall,
  installSources,
  installing,
  installRunning,
  installDisabled,
  installLogs,
  installProgress,
  installError,
  npmAvailable,
  onInstall
}: AgentFrameworkCardProps): React.JSX.Element => {
  const [showLog, setShowLog] = useState(false)

  // A runtime with a resolved path (even a broken one) shows its path/link and the Uninstall control.
  const found = Boolean(path)

  // Show the bar while this card's install runs; fall back to an indeterminate label before the
  // first progress tick arrives.
  const progress = installProgress
    ? describeInstallProgress(installProgress)
    : installing
      ? { label: 'Starting…' }
      : null
  const percent = progress?.fraction != null ? Math.round(progress.fraction * 100) : undefined

  // A failed install force-shows the log for triage; otherwise it stays behind the toggle.
  const logVisible = showLog || Boolean(installError)

  return (
    <Card
      role={ready ? 'radio' : undefined}
      aria-checked={ready ? active : undefined}
      aria-label={ready ? `Use ${name}` : undefined}
      aria-disabled={ready && selectDisabled ? true : undefined}
      tabIndex={ready ? 0 : undefined}
      onClick={ready && !selectDisabled ? onSelect : undefined}
      onKeyDown={
        ready && !selectDisabled
          ? // Radio semantics expect Space/Enter to activate; the card has no inner <button>,
            // so the keyboard toggle is handled here (Space would otherwise scroll the page).
            (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect()
              }
            }
          : undefined
      }
      className={cn(
        'gap-0 rounded-lg py-0',
        ready && 'cursor-pointer transition-colors',
        // Unselected-but-selectable cards fill with a faint wash on hover to advertise the
        // whole-card click target; the active card keeps its primary tint instead.
        ready && !active && 'hover:bg-muted/60',
        ready && selectDisabled && 'pointer-events-none opacity-60',
        // Active gets the strongest treatment (primary ring + faint tint); a not-installed card
        // recedes with a dashed "placeholder" outline so the two groups read differently at a glance.
        active && 'bg-primary/[0.04] ring-1 ring-primary',
        !ready && 'border-dashed bg-muted/40'
      )}
    >
      <CardContent className="p-3">
        <div className="flex items-start gap-3">
          {ready ? (
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                active ? 'border-primary' : 'border-muted-foreground/50'
              )}
            >
              {active ? <span className="size-2 rounded-full bg-primary" /> : null}
            </span>
          ) : null}
          <span
            aria-hidden="true"
            className={cn(
              'flex size-6 shrink-0 items-center justify-center',
              !ready && 'opacity-50'
            )}
          >
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{name}</span>
              {version ? (
                <span className="shrink-0 text-xs text-muted-foreground">v{version}</span>
              ) : null}
              {ready ? (
                active ? (
                  <Badge>Active</Badge>
                ) : (
                  <Badge variant="secondary">Installed</Badge>
                )
              ) : (
                <Badge variant="outline" className="text-muted-foreground">
                  Not installed
                </Badge>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            {found ? (
              <div className="mt-1.5 space-y-1">
                <code
                  className="block w-fit max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80"
                  title={path}
                >
                  {path}
                </code>
                {/* The repo link is informational — keep it from toggling the framework selection. */}
                <div onClick={(event) => event.stopPropagation()}>
                  <ExternalTextLink href={sourceUrl} className="text-xs">
                    {sourceLabel}
                  </ExternalTextLink>
                </div>
              </div>
            ) : null}
          </div>
          {/* Actions live outside the selection gesture: clicks here must not switch frameworks. */}
          <div
            className="flex shrink-0 items-center gap-2"
            onClick={(event) => event.stopPropagation()}
          >
            {found ? (
              <RuntimeUninstallControl
                label={name}
                uninstallCommand={uninstallCommand}
                managed={managed}
                active={active}
                isUninstalling={isUninstalling}
                isDetecting={isDetecting}
                // Global by contract: an install of ANY framework locks every card's Uninstall.
                isInstalling={installRunning}
                onUninstall={onUninstall}
              />
            ) : null}
            {!ready ? (
              <InstallSourceMenu
                name={name}
                sources={installSources}
                installing={installing}
                disabled={installDisabled}
                npmAvailable={npmAvailable}
                onInstall={onInstall}
              />
            ) : null}
          </div>
        </div>

        {!ready ? (
          <div className="mt-2 space-y-3">
            <p className="text-xs text-muted-foreground">{notReadyHint}</p>

            {progress ? (
              // Determinate bar when the installer reports bytes, indeterminate slide otherwise —
              // same markup and `install-progress-indeterminate` animation as the legacy install card.
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{progress.label}</span>
                  {percent != null ? <span>{percent}%</span> : null}
                </div>
                <div
                  role="progressbar"
                  aria-label="Install progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  data-indeterminate={percent == null ? 'true' : undefined}
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className={
                      percent != null
                        ? 'h-full rounded-full bg-primary transition-[width] duration-300'
                        : 'install-progress-indeterminate h-full w-1/3 rounded-full bg-primary'
                    }
                    style={percent != null ? { width: `${percent}%` } : undefined}
                  />
                </div>
              </div>
            ) : null}

            {installError ? (
              <p className="text-xs text-destructive" role="alert">
                {installError}
              </p>
            ) : null}

            {installLogs.length > 0 ? (
              <div>
                {!installError ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      // Defensive: not-ready cards aren't selectable today, but keep the toggle
                      // from ever bubbling into a card-level selection handler.
                      event.stopPropagation()
                      setShowLog((visible) => !visible)
                    }}
                    className="text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    {logVisible ? 'Hide log' : 'Show log'}
                  </button>
                ) : null}
                {logVisible ? (
                  <pre
                    className="mt-2 max-h-48 overflow-auto rounded-lg bg-foreground/5 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/80"
                    aria-label="Install log"
                  >
                    {installLogs.join('')}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

export { AgentFrameworkCard }
