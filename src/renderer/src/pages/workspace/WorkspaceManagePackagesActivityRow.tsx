/* Hallmark · component: async tool status · genre: modern-minimal · theme: project tokens
 * states: loading · warning · error · success
 * contrast: pass · pre-emit critique: P5 H5 E5 S5 R5 V4
 */
import type { ToolActivity } from '@/stores/session-store'
import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { WorkspaceActivityIcon } from './WorkspaceActivityIcon'
import type { ToolExecutionPhase } from './tool-execution-phase'
import { parseManagePackagesResult } from './workspace-tool-activity-details'

type WorkspaceManagePackagesActivityRowProps = {
  activity: ToolActivity
  phase: ToolExecutionPhase
}

const ELAPSED_TICK_MS = 1_000

const managePackagesInput = (activity: ToolActivity): Record<string, unknown> | undefined => {
  if (
    !activity.rawInput ||
    typeof activity.rawInput !== 'object' ||
    Array.isArray(activity.rawInput)
  ) {
    return undefined
  }
  const input = activity.rawInput as Record<string, unknown>
  const args =
    input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments)
      ? (input.arguments as Record<string, unknown>)
      : input
  return args
}

const formatElapsed = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}` : `${seconds}s`
}

// A renderer-only projection for the long-running package tool. It deliberately derives everything
// from the existing activity so no progress chatter enters the tool result or Agent context.
const WorkspaceManagePackagesActivityRow = ({
  activity,
  phase
}: WorkspaceManagePackagesActivityRowProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  const input = managePackagesInput(activity)
  const count = Array.isArray(input?.packages)
    ? input.packages.filter((value): value is string => typeof value === 'string').length
    : 0
  const isRemoving = input?.operation === 'uninstall'
  const isActive = phase === 'executing'
  const isFailed = phase === 'failed'
  const needsRestart = parseManagePackagesResult(activity)?.needsRestart === true
  const useActionLabel = isActive || isFailed
  const elapsedUntil = isActive ? now : activity.updatedAt
  const actionLabel = isRemoving
    ? useActionLabel
      ? count > 0
        ? t('Removing {{count}} packages', {
            count,
            defaultValue_one: 'Removing {{count}} package'
          })
        : t('Removing packages')
      : count > 0
        ? t('Removed {{count}} packages', {
            count,
            defaultValue_one: 'Removed {{count}} package'
          })
        : t('Removed packages')
    : useActionLabel
      ? count > 0
        ? t('Installing {{count}} packages', {
            count,
            defaultValue_one: 'Installing {{count}} package'
          })
        : t('Installing packages')
      : count > 0
        ? t('Installed {{count}} packages', {
            count,
            defaultValue_one: 'Installed {{count}} package'
          })
        : t('Installed packages')

  useEffect(() => {
    if (!isActive) return undefined
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [isActive])

  return (
    <div
      className="rounded-lg pb-1.5"
      data-testid="manage-packages-progress"
      role="status"
      aria-live="polite"
    >
      <div className="flex min-h-[44px] w-full items-center gap-2 px-1.5 py-2 text-[13px] md:min-h-0 md:py-[5px]">
        <span
          className={cn(
            'inline-flex shrink-0',
            isActive
              ? 'text-status-info-foreground dark:text-status-info-dark-foreground'
              : isFailed
                ? 'text-status-failure-foreground dark:text-status-failure-dark-foreground'
                : needsRestart
                  ? 'text-status-warning-foreground dark:text-status-warning-dark-foreground'
                  : 'text-status-success-foreground dark:text-status-success-dark-foreground'
          )}
        >
          <WorkspaceActivityIcon activity={activity} phase={phase} />
        </span>
        <span className="min-w-0 flex-1 text-left font-medium text-text-000">
          {actionLabel}
          <span className="font-normal text-text-100">
            {isActive
              ? ` · ${t('This can take several minutes')}`
              : isFailed
                ? ` · ${t('Failed')}`
                : needsRestart
                  ? ` · ${t('restart needed')}`
                  : null}
          </span>
        </span>
        <span className="shrink-0 tabular-nums text-[12px] text-text-100" aria-hidden="true">
          {formatElapsed(elapsedUntil - activity.createdAt)}
        </span>
      </div>
      <div
        className="mx-2 ml-[30px] h-0.5 overflow-hidden rounded-full bg-border-200"
        aria-hidden="true"
      >
        <div
          className={cn(
            'h-full rounded-full',
            isActive
              ? 'install-progress-indeterminate w-1/3 bg-status-info-foreground motion-reduce:animate-none dark:bg-status-info-dark-foreground'
              : isFailed
                ? 'w-full bg-status-failure-accent'
                : needsRestart
                  ? 'w-full bg-status-warning-foreground dark:bg-status-warning-dark-foreground'
                  : 'w-full bg-status-success-accent'
          )}
        />
      </div>
    </div>
  )
}

export { WorkspaceManagePackagesActivityRow }
