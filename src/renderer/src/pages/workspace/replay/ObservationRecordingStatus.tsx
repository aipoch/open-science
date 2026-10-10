import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { RunObservationRecordingStatus } from '../../../../../shared/run-observation-recording-status'

export const ObservationRecordingStatus = ({
  status,
  onOpenArchive,
  openingArchive = false
}: {
  status: RunObservationRecordingStatus
  onOpenArchive?: () => void
  openingArchive?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const label =
    status.state === 'recording'
      ? t('Recording observations')
      : status.state === 'saving'
        ? t('Saving observation archive…')
        : status.state === 'saved'
          ? t('Observation archive saved')
          : status.state === 'failed'
            ? t('Observation recording could not be saved. The Run status is separate.')
            : status.state === 'capacity'
              ? t('Observation recording reached its capacity limit.')
              : t('This Run has no saved observation recording.')
  const capacity =
    status.capacityLimit === 'snapshots'
      ? t(
          'Recording stopped at the observation count limit. Earlier records are preserved; later activity was not recorded.'
        )
      : status.capacityLimit === 'record-bytes'
        ? t(
            'Recording stopped at this recording’s size limit. Earlier records are preserved; later activity was not recorded.'
          )
        : status.capacityLimit === 'global-bytes'
          ? t(
              'Recording stopped at the total recording storage limit. Earlier records are preserved; later activity was not recorded.'
            )
          : undefined
  return (
    <div className="space-y-1 text-xs" role="status">
      <p>{label}</p>
      {capacity ? <p className="text-status-warning-foreground">{capacity}</p> : null}
      {status.archive && onOpenArchive ? (
        <Button size="sm" variant="outline" onClick={onOpenArchive} disabled={openingArchive}>
          {openingArchive ? t('Loading…') : t('View archived replay')}
        </Button>
      ) : null}
    </div>
  )
}
