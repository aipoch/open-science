import { useTranslation } from 'react-i18next'

import { formatDuration } from '@/components/remote-job-badge-utils'
import { cn } from '@/lib/utils'

type BackgroundTasksChipSummary = {
  activeCount: number
  oldestActiveStartedAt: number | undefined
  totalTasks: number
}

type BackgroundTasksChipProps = {
  summary: BackgroundTasksChipSummary
  now: number
  expanded: boolean
  onToggle: () => void
}

// Strip capsule that toggles the "Background tasks" ledger below the composer.
// It replaces RemoteJobBadge and deliberately keeps that badge's two states
// only — amber "N running · elapsed" while anything is active, gray "N tasks"
// otherwise — with no awaiting/needs-attention breakdown. Counts cover local
// background Runs and remote Compute Jobs together.
const BackgroundTasksChip = ({
  summary,
  now,
  expanded,
  onToggle
}: BackgroundTasksChipProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  if (summary.activeCount === 0 && summary.totalTasks === 0) return null

  const isActive = summary.activeCount > 0
  const elapsedMs =
    summary.oldestActiveStartedAt !== undefined
      ? Math.max(0, now - summary.oldestActiveStartedAt)
      : 0

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={
        isActive
          ? t('{{count}} running background tasks', {
              defaultValue_one: '{{count}} running background task',
              count: summary.activeCount
            })
          : t('{{count}} background tasks', {
              defaultValue_one: '{{count}} background task',
              count: summary.totalTasks
            })
      }
      title={t(
        'Local Runs and remote Compute Jobs for this Session. Click to show or hide the ledger.'
      )}
      className="flex h-7 cursor-pointer items-center gap-1 rounded-xl px-2.5 text-[11.5px] transition-colors duration-200 ease-out"
      style={
        isActive
          ? {
              background: 'color-mix(in srgb, var(--session-waiting) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--session-waiting) 25%, transparent)',
              color: 'var(--session-waiting)'
            }
          : {
              background: 'var(--bg-200)',
              border: '1px solid var(--border-200)',
              color: 'var(--text-100)'
            }
      }
      data-active={isActive || undefined}
      data-testid="background-tasks-chip"
    >
      <span aria-hidden="true">{isActive ? '⚡' : '☰'}</span>
      <span>
        {isActive
          ? t('{{count}} running · {{elapsed}}', {
              count: summary.activeCount,
              elapsed: formatDuration(elapsedMs)
            })
          : t('{{count}} tasks', {
              defaultValue_one: '{{count}} task',
              count: summary.totalTasks
            })}
      </span>
      <span
        aria-hidden="true"
        className={cn('text-[9px] transition-transform duration-150', expanded && 'rotate-180')}
      >
        ▾
      </span>
    </button>
  )
}

export { BackgroundTasksChip }
export type { BackgroundTasksChipSummary }
