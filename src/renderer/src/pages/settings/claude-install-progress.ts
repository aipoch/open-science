import type { TFunction } from 'i18next'

import type { ClaudeInstallProgressEvent } from '../../../../shared/settings'

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1)

// Maps one progress tick to a human label and (when determinate) a 0..1 fill fraction. A missing
// fraction marks an indeterminate phase (npm/official, or an unknown download size). Takes `t` rather
// than reaching for the i18next singleton, so it stays a pure function of (progress, locale) and can be
// unit-tested against a fixed language without pulling in the framework-card component.
export const describeInstallProgress = (
  progress: ClaudeInstallProgressEvent,
  t: TFunction
): { label: string; fraction?: number } => {
  switch (progress.phase) {
    case 'resolving':
      return { label: t('Resolving…') }
    case 'downloading':
      if (progress.totalBytes && progress.receivedBytes != null) {
        return {
          // Byte counts are numeric, so they interpolate rather than being embedded in the sentence.
          label: t('Downloading — {{received}} / {{total}} MB', {
            received: mb(progress.receivedBytes),
            total: mb(progress.totalBytes)
          }),
          fraction: progress.receivedBytes / progress.totalBytes
        }
      }
      return { label: t('Downloading…') }
    case 'extracting':
      return { label: t('Extracting…') }
    case 'installing':
      return { label: t('Installing…') }
  }
}
