import { useTranslation } from 'react-i18next'
import { formatProgressLine, type DownloadProgress } from '../../../shared/download-progress'

// Single-line download status reused by the update dialog and the provisioning surface. The bar stays
// at the current fraction while reconnecting (pulse animation) so a stall reads as "resuming" rather
// than a reset to zero. An unknown total renders an indeterminate bar.
export const DownloadProgressLine = ({
  progress
}: {
  progress: DownloadProgress
}): React.JSX.Element => {
  const { t } = useTranslation()
  const reconnecting = progress.phase === 'reconnecting'
  const known = progress.total != null && progress.percent != null
  return (
    <div className="mt-2">
      <div className="mb-1 text-xs text-muted-foreground tabular-nums">
        {formatProgressLine(t, progress)}
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-bg-300"
        role="progressbar"
        aria-label={t('Download progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(progress.percent!) : undefined}
      >
        <div
          className={`h-full origin-left rounded-full bg-primary transition-transform duration-150 ease-out motion-reduce:transition-none ${
            reconnecting ? 'animate-pulse' : ''
          } ${known ? 'w-full' : 'w-1/3 animate-pulse'}`}
          style={known ? { transform: `scaleX(${progress.percent! / 100})` } : undefined}
        />
      </div>
    </div>
  )
}
