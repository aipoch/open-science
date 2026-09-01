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
import { useTranslation } from 'react-i18next'

import type { EnvironmentCheckId, EnvironmentCheckItem } from '../../../shared/settings'
import { cn } from '@/lib/utils'

// Shared check-row rendering: the onboarding environment step and the settings Network panel
// present the same "one requirement, one row" shape (status-tinted icon tile, label, status
// pill, summary, optional detail).
const CHECK_ICONS: Partial<Record<EnvironmentCheckId, typeof MonitorCog>> = {
  system: MonitorCog,
  storage: HardDrive,
  'secure-storage': KeyRound,
  'install-network': Wifi
}

const STATUS_COPY = {
  passed: 'Ready',
  warning: 'Review',
  failed: 'Action needed'
} satisfies Record<EnvironmentCheckItem['status'], string>

const getStatusLabel = (
  status: EnvironmentCheckItem['status'],
  t: (key: string) => string
): string => {
  return t(STATUS_COPY[status])
}

const statusIcon = (status: EnvironmentCheckItem['status']): React.JSX.Element => {
  if (status === 'passed') {
    return <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
  }
  if (status === 'warning') {
    return <CircleAlert className="size-4 text-session-waiting" aria-hidden="true" />
  }

  return <XCircle className="size-4 text-destructive" aria-hidden="true" />
}

type PendingCheckRowProps = {
  id: EnvironmentCheckId
  label: string
  pendingText?: string
}

const PendingCheckRow = ({ id, label, pendingText }: PendingCheckRowProps): React.JSX.Element => {
  const { t } = useTranslation()
  const Icon = CHECK_ICONS[id] ?? MonitorCog

  return (
    <li className="flex items-start gap-3 py-3.5">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {pendingText ?? t('Waiting to check…')}
        </p>
      </div>
      <Loader2 className="mt-1 size-4 animate-spin text-muted-foreground" aria-hidden="true" />
    </li>
  )
}

type EnvironmentCheckRowProps = {
  check: EnvironmentCheckItem
  // Overrides the id-derived tile icon — e.g. the settings Network panel swaps it by
  // connection type (Wi-Fi vs Ethernet) and state (WifiOff while offline).
  icon?: typeof MonitorCog
}

const EnvironmentCheckRow = ({ check, icon }: EnvironmentCheckRowProps): React.JSX.Element => {
  const { t } = useTranslation()
  const Icon = icon ?? CHECK_ICONS[check.id] ?? MonitorCog

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
            {getStatusLabel(check.status, t)}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{check.summary}</p>
        {check.detail ? (
          <p className="mt-1 break-words text-[11px] leading-relaxed text-muted-foreground">
            {check.detail}
          </p>
        ) : null}
      </div>
    </li>
  )
}

export { EnvironmentCheckRow, PendingCheckRow }
