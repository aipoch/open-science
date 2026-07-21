import {
  CheckCircle2,
  CircleAlert,
  HardDrive,
  KeyRound,
  Loader2,
  MonitorCog,
  RefreshCw,
  TerminalSquare,
  Wifi,
  XCircle
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import type {
  ClaudeInstallProgressEvent,
  EnvironmentCheckId,
  EnvironmentCheckItem,
  EnvironmentCheckResult
} from '../../../../shared/settings'
import { cn } from '@/lib/utils'
import { describeInstallProgress } from '../settings/claude-install-progress'

type EnvironmentSetupCardProps = {
  environment: EnvironmentCheckResult | undefined
  isChecking: boolean
  isInstalling: boolean
  installLogs: string[]
  installProgress?: ClaudeInstallProgressEvent | null
  error?: string
  onCheck: () => void
  onInstall: () => void
}

const CHECK_LABELS: Array<{ id: EnvironmentCheckId; label: string }> = [
  { id: 'system', label: 'System compatibility' },
  { id: 'storage', label: 'App storage permission' },
  { id: 'secure-storage', label: 'Secure credential storage' },
  { id: 'install-network', label: 'Installation network' },
  { id: 'python', label: 'Python for Notebook (optional)' },
  { id: 'agent', label: 'Agent runtime' }
]

const CHECK_ICONS = {
  system: MonitorCog,
  storage: HardDrive,
  'secure-storage': KeyRound,
  'install-network': Wifi,
  python: TerminalSquare,
  agent: TerminalSquare
} satisfies Record<EnvironmentCheckId, typeof MonitorCog>

const STATUS_COPY = {
  passed: 'Ready',
  warning: 'Review',
  failed: 'Action needed'
} satisfies Record<EnvironmentCheckItem['status'], string>

const statusIcon = (status: EnvironmentCheckItem['status']): React.JSX.Element => {
  if (status === 'passed') {
    return <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
  }
  if (status === 'warning') {
    return <CircleAlert className="size-4 text-session-waiting" aria-hidden="true" />
  }

  return <XCircle className="size-4 text-destructive" aria-hidden="true" />
}

const progressFromLogs = (logs: string[]): number | undefined => {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const match = logs[index]?.match(/([\d.]+) MB\s*\/\s*([\d.]+) MB/i)
    if (!match) continue

    const received = Number(match[1])
    const total = Number(match[2])
    if (Number.isFinite(received) && Number.isFinite(total) && total > 0) {
      return Math.min(100, Math.round((received / total) * 100))
    }
  }

  return undefined
}

const PendingCheckRow = ({ id, label }: (typeof CHECK_LABELS)[number]): React.JSX.Element => {
  const Icon = CHECK_ICONS[id]

  return (
    <li className="flex items-start gap-3 py-3.5">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Waiting to check…</p>
      </div>
      <Loader2 className="mt-1 size-4 animate-spin text-muted-foreground" aria-hidden="true" />
    </li>
  )
}

const EnvironmentCheckRow = ({ check }: { check: EnvironmentCheckItem }): React.JSX.Element => {
  const Icon = CHECK_ICONS[check.id]

  return (
    <li className="flex items-start gap-3 py-3.5">
      <span
        className={cn(
          'mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg',
          check.status === 'passed' && 'bg-primary/10 text-primary',
          check.status === 'warning' && 'bg-session-waiting/10 text-session-waiting',
          check.status === 'failed' && 'bg-destructive/10 text-destructive'
        )}
      >
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-foreground">{check.label}</p>
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase',
              check.status === 'passed' && 'bg-primary/10 text-primary',
              check.status === 'warning' && 'bg-session-waiting/10 text-session-waiting',
              check.status === 'failed' && 'bg-destructive/10 text-destructive'
            )}
          >
            {statusIcon(check.status)}
            {STATUS_COPY[check.status]}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{check.summary}</p>
        {check.detail ? (
          <p className="mt-1 break-words text-[11px] leading-relaxed text-muted-foreground/80">
            {check.detail}
          </p>
        ) : null}
      </div>
    </li>
  )
}

// Unframed environment summary rendered inside the onboarding work Card: a re-check control, the
// per-requirement checklist, and (when the runtime is the only gap) a one-click app-managed install with
// progress and a copyable technical log. It intentionally carries no card chrome of its own so the
// wizard keeps a single visible work surface.
const EnvironmentSetupCard = ({
  environment,
  isChecking,
  isInstalling,
  installLogs,
  installProgress,
  error,
  onCheck,
  onInstall
}: EnvironmentSetupCardProps): React.JSX.Element => {
  const structuredProgress = installProgress ? describeInstallProgress(installProgress) : undefined
  const progress =
    structuredProgress?.fraction !== undefined
      ? Math.min(100, Math.round(structuredProgress.fraction * 100))
      : progressFromLogs(installLogs)
  const sourceLabel =
    environment?.recommendedRegistry === 'npmmirror' ? 'China-friendly mirror' : 'official registry'

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Open Science checks its core requirements, selects a trusted download source, and reports
          optional Notebook availability.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCheck}
          disabled={isChecking || isInstalling}
        >
          <RefreshCw className={cn(isChecking && 'animate-spin')} aria-hidden="true" />
          {isChecking ? 'Checking…' : 'Check again'}
        </Button>
      </div>

      <ul
        className="divide-y divide-border-200"
        aria-label="Environment requirements"
        aria-live="polite"
      >
        {environment
          ? // Both agent runtimes share id 'agent', so key by index (+id) to avoid a duplicate-key
            // collision that could mis-render or skip an update on one of the two runtime rows.
            environment.checks.map((check, index) => (
              <EnvironmentCheckRow key={`${check.id}-${index}`} check={check} />
            ))
          : CHECK_LABELS.map((check) => <PendingCheckRow key={check.id} {...check} />)}
      </ul>

      {environment && !environment.ready ? (
        <div className="rounded-lg bg-bg-10 px-4 py-4 ring-1 ring-border-200">
          {environment.canAutoInstall ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {(() => {
                    // For Codex with component info, describe what's missing specifically
                    if (
                      environment.agentFrameworkId === 'codex' &&
                      environment.runtime.codexComponents
                    ) {
                      const { nativeCliFound, adapterFound } = environment.runtime.codexComponents
                      if (!nativeCliFound && !adapterFound) {
                        return 'Both native Codex CLI and ACP adapter are missing'
                      }
                      if (!nativeCliFound) {
                        return 'Native Codex CLI is the missing component'
                      }
                      if (!adapterFound) {
                        return 'Codex ACP adapter is the missing component'
                      }
                    }
                    return 'The agent runtime is the only missing item'
                  })()}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {environment.agentFrameworkId === 'codex' &&
                  environment.runtime.codexComponents?.nativeCliFound &&
                  !environment.runtime.codexComponents?.adapterFound
                    ? `Install the Codex ACP adapter into Open Science using the ${sourceLabel}. The installer will set up a managed adapter paired with a bundled Codex CLI; no Node.js, npm, or admin password is required.`
                    : `Install it into Open Science using the ${sourceLabel}, with the other trusted source as fallback; no Node.js, npm, or admin password is required.`}
                </p>
              </div>
              <Button
                type="button"
                onClick={onInstall}
                disabled={isInstalling || isChecking}
                className="shrink-0"
              >
                {isInstalling ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <TerminalSquare aria-hidden="true" />
                )}
                {isInstalling
                  ? 'Installing…'
                  : (() => {
                      // Specify what will be installed based on what's missing
                      if (
                        environment.agentFrameworkId === 'codex' &&
                        environment.runtime.codexComponents
                      ) {
                        const { nativeCliFound, adapterFound } = environment.runtime.codexComponents
                        if (!nativeCliFound && !adapterFound) {
                          return 'Install Codex CLI + adapter'
                        }
                        if (!nativeCliFound) {
                          return 'Install Codex CLI'
                        }
                        if (!adapterFound) {
                          return 'Install ACP adapter'
                        }
                      }
                      return 'Install missing runtime'
                    })()}
              </Button>
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Resolve the items marked “Action needed”, then choose Check again. The manual tab
              keeps the original scripts available for advanced recovery.
            </p>
          )}
        </div>
      ) : null}

      {isInstalling ? (
        <div
          className="rounded-lg bg-bg-10 px-4 py-3 ring-1 ring-border-200"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-foreground">
              {structuredProgress?.label ?? 'Installing agent runtime'}
            </span>
            <span className="text-muted-foreground">
              {progress !== undefined ? `${progress}%` : 'In progress'}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full bg-primary transition-[width] duration-300',
                progress === undefined && 'w-2/3 animate-pulse'
              )}
              style={progress === undefined ? undefined : { width: `${progress}%` }}
            />
          </div>
        </div>
      ) : null}

      {error ? (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"
          role="alert"
        >
          <p className="text-xs font-semibold text-destructive">Setup could not be completed</p>
          <p className="mt-1 break-words text-xs text-destructive/90">{error}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            The technical log below can be copied when reporting this issue.
          </p>
        </div>
      ) : null}

      {installLogs.length > 0 ? (
        <pre
          className="max-h-44 overflow-auto rounded-lg bg-foreground/5 px-4 py-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/75 select-text"
          aria-label="Automatic setup log"
        >
          {installLogs.join('\n')}
        </pre>
      ) : null}
    </div>
  )
}

export { EnvironmentSetupCard }
