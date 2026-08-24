import type { ToolActivity } from '@/stores/session-store'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { WorkspaceActivityIcon } from './WorkspaceActivityIcon'

type WorkspaceManagePackagesActivityRowProps = {
  activity: ToolActivity
}

const ELAPSED_TICK_MS = 1_000
const MANAGE_PACKAGES_IDENTITY = 'Notebook · manage_packages'

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
  activity
}: WorkspaceManagePackagesActivityRowProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  const input = managePackagesInput(activity)
  const count = Array.isArray(input?.packages)
    ? input.packages.filter((value): value is string => typeof value === 'string').length
    : 0
  const isRemoving = input?.operation === 'uninstall'

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  return (
    <div
      className="rounded-lg pb-1.5"
      data-testid="manage-packages-progress"
      role="status"
      aria-live="polite"
    >
      <div className="flex min-h-[44px] w-full items-start gap-2 px-1.5 py-2 text-[13px] md:min-h-0 md:py-[5px]">
        <span className="mt-0.5 inline-flex shrink-0 md:mt-0">
          <WorkspaceActivityIcon activity={activity} phase="executing" />
        </span>
        <span className="min-w-0 flex-1 text-left">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-medium text-text-000">
              {isRemoving
                ? count > 0
                  ? t('Removing {{count}} packages', {
                      count,
                      defaultValue_one: 'Removing {{count}} package'
                    })
                  : t('Removing packages')
                : count > 0
                  ? t('Installing {{count}} packages', {
                      count,
                      defaultValue_one: 'Installing {{count}} package'
                    })
                  : t('Installing packages')}
            </span>
            <span className="hidden shrink-0 text-text-300 sm:inline">·</span>
            <span className="hidden min-w-0 truncate font-normal text-text-100 sm:inline">
              {MANAGE_PACKAGES_IDENTITY}
            </span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
            <span className="font-medium text-text-000">{t('Preparing the runtime')}</span>
            <span className="tabular-nums text-text-100" aria-hidden="true">
              {t('{{elapsed}} elapsed', { elapsed: formatElapsed(now - activity.createdAt) })}
            </span>
            <span className="text-text-100">{t('This can take several minutes')}</span>
          </span>
        </span>
        <span className="mt-0.5 shrink-0 rounded-full bg-status-info-surface px-1.5 py-0.5 text-[11px] font-medium text-status-info-foreground dark:bg-status-info-dark-surface dark:text-status-info-dark-foreground">
          {t('Running')}
        </span>
      </div>
      <div
        className="mx-2 ml-[30px] h-0.5 overflow-hidden rounded-full bg-border-200"
        aria-hidden="true"
      >
        <div className="install-progress-indeterminate h-full w-1/3 rounded-full bg-primary motion-reduce:animate-none" />
      </div>
    </div>
  )
}

export { WorkspaceManagePackagesActivityRow }
