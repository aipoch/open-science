/* Hallmark · component: async package operation · genre: modern-minimal · theme: project tokens
 * structure: result-led package ledger · states: loading · warning · error · success
 * contrast: pass · pre-emit critique: P5 H5 E5 S5 R5 V5
 */
import type { ToolActivity } from '@/stores/session-store'
import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { WorkspaceActivityIcon } from './WorkspaceActivityIcon'
import type { ToolExecutionPhase } from './tool-execution-phase'
import {
  getManagePackagesFallbackText,
  parseManagePackagesResult
} from './workspace-tool-activity-details'

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

type PackageDetail = {
  name: string
  change?: string
  version?: string
  source?: string
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
  const requestedPackages = Array.isArray(input?.packages)
    ? input.packages.filter((value): value is string => typeof value === 'string')
    : []
  const count = requestedPackages.length
  const isRemoving = input?.operation === 'uninstall'
  const isActive = phase === 'executing'
  const result = parseManagePackagesResult(activity)
  const isFailed = phase === 'failed' || result?.ok === false
  const failureMessage =
    typeof result?.error === 'string' && result.error.trim()
      ? result.error.trim()
      : result
        ? null
        : getManagePackagesFallbackText(activity)
  const needsRestart = result?.needsRestart === true
  const packageChanges = Array.isArray(result?.packageChanges)
    ? result.packageChanges.filter(
        (change): change is Record<string, unknown> =>
          typeof change === 'object' && change !== null && !Array.isArray(change)
      )
    : []
  const detailFromChange = (change: Record<string, unknown>): PackageDetail => {
    const name = typeof change.name === 'string' ? change.name : ''
    const source =
      change.source && typeof change.source === 'object' && !Array.isArray(change.source)
        ? (change.source as Record<string, unknown>)
        : undefined
    const sourceLabel =
      source?.type === 'github' && typeof source.repository === 'string'
        ? `${source.repository}${typeof source.ref === 'string' ? `@${source.ref}` : ''}`
        : source?.type === 'bioconductor'
          ? [t('Bioconductor'), typeof source.version === 'string' ? source.version : null]
              .filter(Boolean)
              .join(' ')
          : undefined
    const beforeVersion =
      typeof change?.beforeVersion === 'string' ? change.beforeVersion.trim() : undefined
    const afterVersion =
      typeof change?.afterVersion === 'string' ? change.afterVersion.trim() : undefined
    const version =
      change?.change === 'updated' && beforeVersion && afterVersion
        ? `${beforeVersion} → ${afterVersion}`
        : isRemoving
          ? beforeVersion
          : afterVersion

    return {
      name,
      change: typeof change?.change === 'string' ? change.change : undefined,
      version: version || undefined,
      source: sourceLabel
    }
  }
  const requestedChanges = packageChanges.filter((change) => change.relationship === 'requested')
  const packageDetails: PackageDetail[] =
    requestedChanges.length > 0
      ? requestedChanges.map(detailFromChange).filter((detail) => detail.name)
      : requestedPackages.map((name) => {
          const change = packageChanges.find(
            (candidate) =>
              typeof candidate.name === 'string' &&
              candidate.name.toLowerCase() === name.toLowerCase()
          )
          return change ? detailFromChange(change) : { name }
        })
  const relatedPackageDetails = packageChanges
    .filter((change) => change.relationship !== 'requested' && change.change !== 'unchanged')
    .map(detailFromChange)
    .filter((detail) => detail.name)
  const languageLabel =
    input?.language === 'r' ? 'R' : input?.language === 'python' ? 'Python' : null
  const installer =
    typeof result?.method === 'string' && result.method.trim()
      ? result.method === 'biocmanager'
        ? t('Bioconductor')
        : result.method === 'github'
          ? 'GitHub'
          : result.method.trim()
      : input?.installer === 'biocmanager'
        ? t('Bioconductor')
        : input?.installer === 'github'
          ? 'GitHub'
          : input?.usePip === true
            ? 'pip'
            : 'conda'
  const environmentName =
    typeof result?.environmentName === 'string' && result.environmentName.trim()
      ? result.environmentName.trim()
      : null
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
      className="rounded-lg px-1.5 pb-2 pt-1"
      data-testid="manage-packages-progress"
      role="status"
      aria-live="polite"
    >
      <div className="flex min-h-[44px] w-full items-start gap-2 py-2 text-[13px] md:min-h-0">
        <span
          className={cn(
            'mt-0.5 inline-flex shrink-0',
            isActive
              ? 'text-status-info-foreground dark:text-status-info-dark-foreground'
              : isFailed
                ? 'text-status-failure-foreground dark:text-status-failure-dark-foreground'
                : needsRestart
                  ? 'text-status-warning-foreground dark:text-status-warning-dark-foreground'
                  : 'text-status-success-foreground dark:text-status-success-dark-foreground'
          )}
        >
          <WorkspaceActivityIcon activity={activity} phase={isFailed ? 'failed' : phase} />
        </span>
        <span className="min-w-0 flex-1 text-left">
          <span className="block font-medium leading-5 text-text-000">{actionLabel}</span>
          <span className="mt-0.5 block text-[12px] leading-4 text-text-100">
            {[languageLabel, environmentName, installer].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className="shrink-0 tabular-nums text-[12px] text-text-100" aria-hidden="true">
          {formatElapsed(elapsedUntil - activity.createdAt)}
        </span>
      </div>
      {packageDetails.length > 0 ? (
        <div className="ml-[26px] border-y border-border-200" data-testid="manage-packages-details">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-border-200 px-2.5 py-1.5 text-[11px] font-medium text-text-200 sm:grid-cols-[minmax(0,1fr)_minmax(76px,auto)_minmax(88px,auto)]">
            <span>{t('Package')}</span>
            <span className="hidden sm:block">{t('Status')}</span>
            <span className="text-right">{t('Version')}</span>
          </div>
          <div className="divide-y divide-border-200">
            {packageDetails.map((detail, index) => {
              const changeLabel = isActive
                ? isRemoving
                  ? t('Removing…')
                  : t('Installing…')
                : detail.change === 'updated'
                  ? t('Updated')
                  : detail.change === 'removed'
                    ? t('Removed')
                    : detail.change === 'unchanged'
                      ? t('Unchanged')
                      : detail.change === 'installed'
                        ? t('Installed')
                        : isFailed
                          ? t('Failed')
                          : t('Installed')

              return (
                <div
                  key={`${detail.name}-${index}`}
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-2.5 py-2 text-[12px] sm:grid-cols-[minmax(0,1fr)_minmax(76px,auto)_minmax(88px,auto)]"
                  data-testid="manage-packages-package-row"
                >
                  <span className="min-w-0" title={detail.name}>
                    <span className="block truncate font-medium text-text-000">{detail.name}</span>
                    {detail.source ? (
                      <span className="block truncate text-[11px] text-text-200">
                        {detail.source}
                      </span>
                    ) : null}
                    <span
                      className={cn(
                        'mt-0.5 block text-[11px] sm:hidden',
                        isActive
                          ? 'text-status-info-foreground dark:text-status-info-dark-foreground'
                          : isFailed
                            ? 'text-status-failure-foreground dark:text-status-failure-dark-foreground'
                            : needsRestart
                              ? 'text-status-warning-foreground dark:text-status-warning-dark-foreground'
                              : 'text-status-success-foreground dark:text-status-success-dark-foreground'
                      )}
                      data-testid="manage-packages-package-status-mobile"
                    >
                      {changeLabel}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'hidden sm:block',
                      isActive
                        ? 'text-status-info-foreground dark:text-status-info-dark-foreground'
                        : isFailed
                          ? 'text-status-failure-foreground dark:text-status-failure-dark-foreground'
                          : needsRestart
                            ? 'text-status-warning-foreground dark:text-status-warning-dark-foreground'
                            : 'text-status-success-foreground dark:text-status-success-dark-foreground'
                    )}
                    data-testid="manage-packages-package-status"
                  >
                    {changeLabel}
                  </span>
                  <span
                    className="truncate text-right font-mono tabular-nums text-text-100"
                    data-testid="manage-packages-package-version"
                  >
                    {detail.version ?? '—'}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ) : null}
      {relatedPackageDetails.length > 0 ? (
        <details className="group ml-[26px] border-b border-border-200 text-[12px]">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 py-2 text-text-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-1.5 font-medium text-text-000">
              <span
                aria-hidden="true"
                className="inline-block transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
              >
                ›
              </span>
              {t('Related changes')}
            </span>
            <span className="tabular-nums">{relatedPackageDetails.length}</span>
          </summary>
          <div className="divide-y divide-border-200 border-t border-border-200">
            {relatedPackageDetails.map((detail, index) => (
              <div
                key={`${detail.name}-${index}`}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-2.5 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(76px,auto)_minmax(88px,auto)]"
                data-testid="manage-packages-related-row"
              >
                <span className="min-w-0 truncate font-medium text-text-000">{detail.name}</span>
                <span className="hidden text-text-100 sm:block">
                  {detail.change === 'updated'
                    ? t('Updated')
                    : detail.change === 'removed'
                      ? t('Removed')
                      : t('Installed')}
                </span>
                <span className="truncate text-right font-mono tabular-nums text-text-100">
                  {detail.version ?? '—'}
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      <div className="ml-[26px] mt-2">
        {isActive ? (
          <>
            <div className="flex items-center justify-between gap-3 text-[11px] text-text-100">
              <span>{t('This can take several minutes')}</span>
              <span className="shrink-0 text-status-info-foreground dark:text-status-info-dark-foreground">
                {isRemoving ? t('Removing…') : t('Installing…')}
              </span>
            </div>
            <div
              className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-border-200"
              aria-hidden="true"
            >
              <div className="install-progress-indeterminate h-full w-1/3 rounded-full bg-status-info-foreground motion-reduce:animate-none dark:bg-status-info-dark-foreground" />
            </div>
          </>
        ) : isFailed ? (
          <p
            className="line-clamp-2 break-words text-[12px] text-status-failure-foreground dark:text-status-failure-dark-foreground"
            title={failureMessage ?? undefined}
          >
            {failureMessage ?? t('Failed')}
          </p>
        ) : needsRestart ? (
          <p className="text-[12px] text-status-warning-foreground dark:text-status-warning-dark-foreground">
            {isRemoving
              ? t('Removed R packages need a kernel restart to unload.')
              : t('Installed R packages need a kernel restart to load.')}
          </p>
        ) : null}
      </div>
    </div>
  )
}

export { WorkspaceManagePackagesActivityRow }
