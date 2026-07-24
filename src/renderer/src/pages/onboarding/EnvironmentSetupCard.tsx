import {
  CheckCircle2,
  CircleAlert,
  HardDrive,
  KeyRound,
  Loader2,
  MonitorCog,
  Wifi,
  XCircle
} from 'lucide-react'

import type {
  EnvironmentCheckId,
  EnvironmentCheckItem,
  EnvironmentCheckResult
} from '../../../../shared/settings'
import { cn } from '@/lib/utils'

type EnvironmentSetupCardProps = {
  environment: EnvironmentCheckResult | undefined
  error?: string
}

const CHECK_LABELS: Array<{ id: EnvironmentCheckId; label: string }> = [
  { id: 'system', label: 'System compatibility' },
  { id: 'storage', label: 'App storage permission' },
  { id: 'secure-storage', label: 'Secure credential storage' },
  { id: 'install-network', label: 'Installation network' }
]

const HOST_CHECK_IDS: readonly EnvironmentCheckId[] = CHECK_LABELS.map((check) => check.id)

const CHECK_ICONS = {
  system: MonitorCog,
  storage: HardDrive,
  'secure-storage': KeyRound,
  'install-network': Wifi
} satisfies Partial<Record<EnvironmentCheckId, typeof MonitorCog>>

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

const PendingCheckRow = ({ id, label }: (typeof CHECK_LABELS)[number]): React.JSX.Element => {
  const Icon = CHECK_ICONS[id] ?? MonitorCog

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
  const Icon = CHECK_ICONS[check.id] ?? MonitorCog

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

// Host-only requirement list for the first onboarding step. Agent installation and notebook runtime
// management live in their dedicated steps and must not leak back into this surface.
const EnvironmentSetupCard = ({
  environment,
  error
}: EnvironmentSetupCardProps): React.JSX.Element => {
  const visibleChecks = environment?.checks.filter((check) => HOST_CHECK_IDS.includes(check.id))
  const hostNeedsAction = visibleChecks?.some((check) => check.status === 'failed') ?? false

  return (
    <div className="space-y-4">
      <ul
        className="divide-y divide-border-200"
        aria-label="Environment requirements"
        aria-live="polite"
      >
        {environment
          ? visibleChecks?.map((check) => <EnvironmentCheckRow key={check.id} check={check} />)
          : CHECK_LABELS.map((check) => <PendingCheckRow key={check.id} {...check} />)}
      </ul>

      {hostNeedsAction ? (
        <div className="rounded-lg bg-bg-10 px-4 py-4 ring-1 ring-border-200">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Resolve the items marked Action needed, then choose Check again.
          </p>
        </div>
      ) : null}

      {error ? (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"
          role="alert"
        >
          <p className="text-xs font-semibold text-destructive">Setup could not be completed</p>
          <p className="mt-1 break-words text-xs text-destructive/90">{error}</p>
        </div>
      ) : null}
    </div>
  )
}

export { EnvironmentSetupCard }
