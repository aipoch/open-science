import { formatProgressLine, type DownloadProgress } from '../../../shared/download-progress'

// Single-line download status reused by the update dialog and the provisioning surface. The bar stays
// at the current fraction while reconnecting (pulse animation) so a stall reads as "resuming" rather
// than a reset to zero. An unknown total renders an indeterminate bar.
export const DownloadProgressLine = ({
  progress
}: {
  progress: DownloadProgress
}): React.JSX.Element => {
  const reconnecting = progress.phase === 'reconnecting'
  const known = progress.total != null && progress.percent != null
  return (
    <div className="mt-2">
      <div className="mb-1 text-xs text-muted-foreground tabular-nums">
        {formatProgressLine(progress)}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-300">
        <div
          className={`h-full rounded-full bg-primary transition-all duration-150 ease-out ${
            reconnecting ? 'animate-pulse' : ''
          } ${known ? '' : 'w-1/3 animate-pulse'}`}
          style={known ? { width: `${progress.percent}%` } : undefined}
        />
      </div>
    </div>
  )
}
