import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { ResearchRecordingCoverage } from '@/lib/replay/recorded-time'
import { recordingAtTime, recordingTargetKey } from './recording-timeline-follow'

type Target = ResearchRecordingCoverage['target']

/** Presentation-only selection: this adapter deliberately has no playback/seek authority. */
export const RecordingTimelineFollow = ({
  enabled,
  following,
  onFollowingChange,
  coverage,
  availableTargets,
  recordedAt,
  selected,
  onSelect,
  children
}: {
  enabled: boolean
  following: boolean
  onFollowingChange: (following: boolean) => void
  coverage: readonly ResearchRecordingCoverage[]
  availableTargets: readonly Target[]
  recordedAt?: number
  selected?: Target
  onSelect: (target: Target) => void
  children: ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  const match = recordingAtTime(coverage, recordedAt)
  const next = enabled && following && match.kind === 'recording' ? match.target : undefined
  const unavailable = Boolean(
    next &&
    !availableTargets.some((target) => recordingTargetKey(target) === recordingTargetKey(next))
  )
  const switching = Boolean(
    next && !unavailable && (!selected || recordingTargetKey(next) !== recordingTargetKey(selected))
  )
  useEffect(() => {
    if (switching && next) onSelect(next)
  }, [switching, next, onSelect])
  const ambiguous = enabled && following && match.kind === 'ambiguous'
  return (
    <>
      {enabled ? (
        <div className="flex shrink-0 items-center border-b border-border-200 px-2 py-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            aria-pressed={following}
            onClick={() => onFollowingChange(!following)}
          >
            {following ? t('Following replay') : t('Follow replay')}
          </Button>
        </div>
      ) : null}
      {ambiguous ? (
        <p role="status" className="p-3 text-sm text-muted-foreground">
          {t('Recordings overlap at this time. Choose a recording to view it.')}
        </p>
      ) : unavailable ? (
        <p role="status" className="p-3 text-sm text-muted-foreground">
          {t('This recorded media file is not included.')}
        </p>
      ) : switching ? (
        <p role="status" className="p-3 text-sm text-muted-foreground">
          {t('Preparing recorded material…')}
        </p>
      ) : (
        children
      )}
    </>
  )
}
