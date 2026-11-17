import type { TFunction } from 'i18next'

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
