import { useTranslation } from 'react-i18next'
import { formatProgressLine } from '../../../shared/download-progress'
import type { DownloadProgress } from '@aipoch/resilient-download'
import { ProgressBar } from './ui/progress-bar'

// Single-line download status reused by the update dialog and the provisioning surface. The bar stays
// at the current fraction while reconnecting (pulse animation) so a stall reads as "resuming" rather
// than a reset to zero. An unknown total renders an indeterminate bar.
export const DownloadProgressLine = ({
  progress,
  compact = false
}: {
  progress: DownloadProgress
  compact?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const reconnecting = progress.phase === 'reconnecting'
  const known = progress.total != null && progress.percent != null
  const progressBar = (
    <ProgressBar
      label={t('Download progress')}
      value={known ? progress.percent : undefined}
      pulse={reconnecting}
    />
  )

  if (compact) {
    return (
      <div className="min-w-0 flex-1 space-y-1 text-xs">
        <p className="truncate text-muted-foreground tabular-nums">
          {formatProgressLine(t, progress)}
        </p>
        {progressBar}
      </div>
    )
  }

  return (
    <div className="mt-2">
      <div className="mb-1 text-xs text-muted-foreground tabular-nums">
        {formatProgressLine(t, progress)}
      </div>
      {progressBar}
    </div>
  )
}
