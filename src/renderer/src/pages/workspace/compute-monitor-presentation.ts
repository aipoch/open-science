import type { TFunction } from 'i18next'
import type { NotebookResourceRelease } from '../../../../shared/notebook-resources'

// Compact wall-clock uptime, including idle time. Lower units are intentionally omitted.
export function formatComputeUptime(seconds: number, t: TFunction): string {
  const total = Math.max(0, Math.floor(seconds))
  if (total < 60) return t('{{count}}s', { count: total })
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return t('{{count}}m', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return [
      t('{{count}}h', { count: hours }),
      minutes % 60 ? t('{{count}}m', { count: minutes % 60 }) : ''
    ]
      .filter(Boolean)
      .join(' ')
  }
  return [
    t('{{count}}d', { count: Math.floor(hours / 24) }),
    hours % 24 ? t('{{count}}h', { count: hours % 24 }) : ''
  ]
    .filter(Boolean)
    .join(' ')
}

export function totalKernelUptime(
  kernels: readonly { startedAt: number }[],
  sampledAt: number
): number {
  return kernels.reduce((sum, kernel) => sum + Math.max(0, sampledAt - kernel.startedAt), 0) / 1000
}

export const releaseBlockedLabel = (reason: string, t: TFunction): string => {
  if (reason === 'release-in-progress' || reason === 'cleanup-in-progress')
    return t('Notebook cleanup is already in progress.')
  if (reason === 'session-exporting')
    return t('This Session is being exported. Wait, then review the resources again.')
  if (reason === 'runtime-binding-changing')
    return t('The Notebook environment is changing. Wait, then review the resources again.')
  if (reason === 'application-stopping') return t('Open-Science is shutting down.')
  if (reason === 'application-updating')
    return t('An update is in progress. Wait, then review the resources again.')
  if (reason === 'package-handoff')
    return t('Session files are being transferred. Wait, then review the resources again.')
  if (reason === 'data-migration')
    return t('Data is being moved. Wait, then review the resources again.')
  if (reason === 'session-unavailable')
    return t('This Session is unavailable or you do not have permission to manage it.')
  return t('Notebook release is currently unavailable. Refresh and review the resources again.')
}

export const resourceReleaseStatus = (release: NotebookResourceRelease, t: TFunction): string =>
  release.status === 'releasing'
    ? release.phase === 'retry'
      ? t('Retrying Notebook cleanup…')
      : release.phase === 'force-close'
        ? t('Force closing Notebook processes…')
        : t('Releasing Notebook resources')
    : release.status === 'partial'
      ? t('Cleanup incomplete')
      : t('Notebook resources released')
