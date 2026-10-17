import { useTranslation } from 'react-i18next'
import type { BrowserRecording } from '../../../../../shared/browser-recording'
import { Button } from '@/components/ui/button'

/** Evidence coverage only; a gap never claims what the unobserved program was doing. */
export function RecordedFootageStatus({
  recording,
  recordedAt,
  onSeek,
  onShowNotebook
}: {
  recording: BrowserRecording
  recordedAt?: number
  onSeek: (timestamp: number) => void
  onShowNotebook: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (recordedAt === undefined) return null
  const offset = recordedAt - recording.startedAt
  if (recording.segments.some((segment) => offset >= segment.startMs && offset < segment.endMs))
    return null
  const first = recording.segments[0]
  const last = recording.segments.at(-1)
  const next = recording.segments.find((segment) => segment.startMs > offset)
  const message =
    first && offset < first.startMs
      ? t('The project recording has not started yet.')
      : last && offset >= last.endMs
        ? t('The project recording has ended.')
        : t('No webpage footage was recorded at this time.')
  return (
    <div className="shrink-0 space-y-2 border-b border-border-200 p-3" role="status">
      <p className="text-sm">{message}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onShowNotebook}>
          {t('Notebook')}
        </Button>
        {next ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onSeek(recording.startedAt + next.startMs)}
          >
            {t('Jump to recorded footage')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
