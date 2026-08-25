import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type {
  ClaudeInstallProgressEvent,
  ClaudeInstallSource,
  ClaudeInstallSourceInfo
} from '../../../../shared/settings'
import { describeInstallProgress } from './claude-install-progress'
import { AgentInstallSourceMenu } from './AgentInstallSourceMenu'
import { RuntimeUninstallControl } from './RuntimeUninstallControl'

/* Hallmark · component: incompatible runtime card · genre: modern-minimal · theme: Settings tokens
 * States: default · hover · focus · active · disabled · loading · error · success.
 * The amber surface always pairs colour with status copy; keyboard focus stays an immediate ring. */
/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V5 · contrast: pass · slop: pass */

type AgentFrameworkCardProps = {
  // Brand mark in the vendor's standard color (lobehub icon component, e.g. <Claude.Color />).
  icon: React.ReactNode
  // Display name ("Claude Agent", "OpenCode", "Codex").
  name: string
  // One-line summary of what the agent is, shown under the name.
  description: React.ReactNode
  // Preflight-passed runtimes are selectable.
  ready: boolean
  // Detection/install found runtime metadata. It may still need repair before it is selectable.
  installed?: boolean
  // Installed but below the minimum supported runtime version. It remains in Installed, is not
  // selectable, and gets an explicit managed-update action instead of generic repair treatment.
  updateRequired?: boolean
  minimumVersion?: string
  // The selected runtime failed the full environment check, even if detection found no path.
  needsRepair: boolean
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
  radioTabIndex?: number
  // Selecting a broken runtime asks the panel to explain and offer repair; it never activates here.
  onRepairRequired?: () => void
  selectDisabled: boolean
  // Uninstall control wiring, shared across frameworks via RuntimeUninstallControl.
  uninstallCommand: string
  managed: boolean
  isUninstalling: boolean
  // A detect run is in flight (the section-level Re-detect triggers all frameworks at once).
  isDetecting: boolean
  // Whether an ACP prompt is currently running; forwarded to RuntimeUninstallControl.
  promptInFlight?: boolean
  onUninstall: () => void
  // Onboarding reuses the framework cards for selection/install, but runtime removal remains a
  // Settings-only action.
  showUninstall?: boolean
  // Install menu + progress wiring (only meaningful on not-ready cards).
  installSources: ClaudeInstallSourceInfo[]
  // This runtime's own install slice from the store (progress/logs/error plus whether THIS card's
  // install runs, which flips the button to "Installing…").
  install: {
    isInstalling: boolean
    installLogs: string[]
    installProgress: ClaudeInstallProgressEvent | null
    installError?: string
  }
  // Global install-in-flight flag (any framework). RuntimeUninstallControl's contract locks every
  // card's Uninstall while ANY install runs; it also locks this card's Install menu.
  installRunning: boolean
  npmAvailable: boolean
  blockedInstallSources: Partial<Record<ClaudeInstallSource, string>>
  onInstall: (source: ClaudeInstallSource) => void
  // Hallmark development seam for the unmounted eight-state preview.
  previewState?: AgentFrameworkCardPreviewState
}

type AgentFrameworkCardPreviewState =
  'default' | 'hover' | 'focus' | 'active' | 'disabled' | 'loading' | 'error' | 'success'

// Unified agent-framework card for the settings Model panel. The whole card is the radio option
// that switches the active framework (only ready runtimes are selectable); the action column on
// the right carries exactly one action — Uninstall when ready, Repair when a detected runtime
// fails preflight, Install when nothing was detected — and stops clicks bubbling into a selection.
const AgentFrameworkCard = ({
  icon,
  name,
  description,
  ready,
  installed,
  updateRequired = false,
  minimumVersion,
  needsRepair,
  version,
  path,
  sourceLabel,
  sourceUrl,
  notReadyHint,
  active,
  onSelect,
  radioTabIndex,
  onRepairRequired,
  selectDisabled,
  uninstallCommand,
  managed,
  isUninstalling,
  isDetecting,
  promptInFlight,
  onUninstall,
  showUninstall = true,
  installSources,
  install,
  installRunning,
  npmAvailable,
  blockedInstallSources,
  onInstall,
  previewState
}: AgentFrameworkCardProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [showLog, setShowLog] = useState(false)

  // A runtime with a resolved path (even a broken one) shows its path/link.
  const found = Boolean(path)
  const installedRuntime = installed ?? found
  const repair = !updateRequired && (needsRepair || installedRuntime)
  const canRequestRepair = !ready && repair && Boolean(onRepairRequired)
  const activateCard = selectDisabled
    ? undefined
    : ready
      ? onSelect
      : canRequestRepair
        ? onRepairRequired
        : undefined

  const installing = install.isInstalling || previewState === 'loading'
  const installLogs = install.installLogs
  const installError = previewState === 'error' ? t('Update failed') : install.installError
  // Any framework's install (or any uninstall) locks this card's Install menu.
  const installLocked = installRunning || isUninstalling

  // Show the bar while this card's install runs; fall back to an indeterminate label before the
  // first progress tick arrives.
  const progress = install.installProgress
    ? describeInstallProgress(install.installProgress, t)
    : installing
      ? { label: t('Starting…') }
      : null
  const percent = progress?.fraction != null ? Math.round(progress.fraction * 100) : undefined

  // A failed install force-shows the log for triage; otherwise it stays behind the toggle.
  const logVisible = showLog || Boolean(installError)

  return (
    <Card
      role={ready ? 'radio' : canRequestRepair ? 'button' : undefined}
      aria-checked={ready ? active : undefined}
      aria-label={
        ready
          ? t('Use {{name}}', { name })
          : canRequestRepair
            ? t('Repair required for {{name}}', { name })
            : undefined
      }
      aria-disabled={(ready || canRequestRepair) && selectDisabled ? true : undefined}
      tabIndex={ready ? radioTabIndex : canRequestRepair ? 0 : undefined}
      onClick={activateCard}
      onKeyDown={
        activateCard
          ? // Card selection and repair requests both support Space/Enter; Space would otherwise
            // scroll the page because the card itself is not a native button.
            (event) => {
              // Nested links and action buttons own their keyboard events; only the card's own focus
              // may activate selection or the explanatory repair dialog.
              if (event.target !== event.currentTarget) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                activateCard()
              }
            }
          : undefined
      }
      className={cn(
        'gap-0 rounded-lg py-0',
        (ready || canRequestRepair) && 'cursor-pointer transition-colors',
        // Unselected-but-selectable cards fill with a faint wash on hover to advertise the
        // whole-card click target; the active card keeps its primary tint instead.
        ((ready && !active) || canRequestRepair) && 'hover:bg-muted/60',
        (ready || canRequestRepair) && selectDisabled && 'pointer-events-none opacity-60',
        // Active gets the strongest treatment (primary ring + faint tint); a not-installed card
        // recedes with a dashed "placeholder" outline so the two groups read differently at a glance.
        ready && active && 'bg-primary/[0.04] ring-1 ring-primary',
        !ready && !updateRequired && !installedRuntime && 'border-dashed bg-muted/40',
        updateRequired &&
          'border-status-warning-foreground/30 bg-status-warning-surface/40 dark:border-status-warning-dark-foreground/30 dark:bg-status-warning-dark-surface/20',
        previewState === 'hover' && 'bg-status-warning-surface/70',
        previewState === 'focus' && 'ring-3 ring-ring/50',
        previewState === 'active' && 'translate-y-px',
        previewState === 'disabled' && 'pointer-events-none opacity-50'
      )}
    >
      <CardContent className="p-3">
        <div className="flex flex-wrap items-start gap-3">
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
              !ready && !updateRequired && !installedRuntime && 'opacity-50'
            )}
          >
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{name}</span>
              {version ? (
                <span className="shrink-0 text-xs text-muted-foreground">v{version}</span>
              ) : null}
              {ready ? (
                active ? (
                  <Badge>{t('Active', { context: 'inUse' })}</Badge>
                ) : (
                  <Badge variant="secondary">{t('Installed')}</Badge>
                )
              ) : updateRequired ? (
                <Badge
                  variant="outline"
                  className="border-status-warning-foreground/40 bg-status-warning-surface text-status-warning-foreground dark:border-status-warning-dark-foreground/40 dark:bg-status-warning-dark-surface/40 dark:text-status-warning-dark-foreground"
                >
                  {t('Update required')}
                </Badge>
              ) : repair ? (
                // A detected-but-broken runtime (preflight failed) is not "not installed".
                <Badge
                  variant="outline"
                  className="border-amber-500/40 text-amber-600 dark:text-amber-400"
                >
                  {t('Needs repair')}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-muted-foreground">
                  {t('Not installed')}
                </Badge>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            {updateRequired && minimumVersion ? (
              <p className="mt-1 font-mono text-[11px] text-status-warning-foreground dark:text-status-warning-dark-foreground">
                {t('Requires Codex ACP v{{version}} or later', { version: minimumVersion })}
              </p>
            ) : null}
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
          {/* Actions live outside the selection gesture: clicks here must not switch frameworks.
              Exactly one action per card: Uninstall when ready, Repair when detected-but-broken,
              Install when nothing was detected. */}
          {!ready || showUninstall ? (
            <div
              className="ml-auto flex shrink-0 items-center gap-2"
              onClick={(event) => event.stopPropagation()}
            >
              {ready ? (
                <RuntimeUninstallControl
                  label={name}
                  uninstallCommand={uninstallCommand}
                  managed={managed}
                  active={active}
                  isUninstalling={isUninstalling}
                  isDetecting={isDetecting}
                  // Global by contract: an install of ANY framework locks every card's Uninstall.
                  isInstalling={installRunning}
                  promptInFlight={promptInFlight}
                  onUninstall={onUninstall}
                />
              ) : (
                <AgentInstallSourceMenu
                  name={name}
                  intent={updateRequired ? 'update' : repair ? 'repair' : 'install'}
                  sources={installSources}
                  installing={installing}
                  disabled={installLocked}
                  npmAvailable={npmAvailable}
                  blockedInstallSources={blockedInstallSources}
                  onInstall={onInstall}
                />
              )}
            </div>
          ) : null}
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
                  aria-label={updateRequired ? t('Update progress') : t('Install progress')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  data-indeterminate={percent == null ? 'true' : undefined}
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className={
                      percent != null
                        ? 'h-full w-full origin-left rounded-full bg-primary transition-transform duration-300 motion-reduce:transition-none'
                        : 'install-progress-indeterminate h-full w-1/3 rounded-full bg-primary'
                    }
                    style={percent != null ? { transform: `scaleX(${percent / 100})` } : undefined}
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
                    onClick={() => setShowLog((visible) => !visible)}
                    className="text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    {logVisible ? t('Hide log') : t('Show log')}
                  </button>
                ) : null}
                {logVisible ? (
                  <pre
                    className="mt-2 max-h-48 overflow-auto rounded-lg bg-foreground/5 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/80"
                    aria-label={t('Install log')}
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
export type { AgentFrameworkCardPreviewState }
