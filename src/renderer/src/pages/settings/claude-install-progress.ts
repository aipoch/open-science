import type { ClaudeInstallProgressEvent } from '../../../../shared/settings'

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1)

// Maps one progress tick to a human label and (when determinate) a 0..1 fill fraction. A missing
// fraction marks an indeterminate phase (npm/official, or an unknown download size). Pure so it can be
// unit-tested and shared without pulling in the framework-card component.
export const describeInstallProgress = (
  progress: ClaudeInstallProgressEvent
): { label: string; fraction?: number } => {
  switch (progress.phase) {
    case 'resolving':
      return { label: 'Resolving…' }
    case 'downloading':
      if (progress.totalBytes && progress.receivedBytes != null) {
        return {
          label: `Downloading — ${mb(progress.receivedBytes)} / ${mb(progress.totalBytes)} MB`,
          fraction: progress.receivedBytes / progress.totalBytes
        }
      }
      return { label: 'Downloading…' }
    case 'extracting':
      return { label: 'Extracting…' }
    case 'installing':
      return { label: 'Installing…' }
  }
}
