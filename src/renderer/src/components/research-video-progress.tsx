import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ProgressBar } from './ui/progress-bar'
import type { ResearchVideoProgress } from '@aipoch/research-film/contracts'

export function ResearchVideoProgressLine({
  progress
}: {
  progress: ResearchVideoProgress
}): React.JSX.Element {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  const terminal = ['completed', 'cancelled', 'failed'].includes(progress.phase)
  useEffect(() => {
    if (terminal) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [terminal])
  const labels = {
    preparing: t('Preparing research materials…'),
    writing: t('Writing research film…'),
    loading: t('Loading narration engine…'),
    voice:
      progress.totalLines === undefined
        ? t('Generating narration…')
        : t('Generating narration and aligning captions…'),
    alignment: t('Aligning captions…'),
    mixing: t('Mixing narration…'),
    build: t('Building player and source package…'),
    publishing: t('Saving results…'),
    rendering: t('Rendering video frames…'),
    encoding: t('Finishing video encoding…'),
    verifying: t('Verifying video…'),
    completed: t('Research film ready'),
    cancelled: t('Research video cancelled'),
    failed: t('Research video failed')
  }
  const counted = progress.total !== undefined && progress.completed !== undefined
  return (
    <div className="min-w-0 space-y-2 text-xs text-muted-foreground">
      <div role="status" className="space-y-1">
        <p className="text-sm font-medium text-foreground">{labels[progress.phase]}</p>
        {counted && (
          <p className="tabular-nums">
            {progress.totalLines === undefined
              ? t('{{completed}} / {{total}} completed', {
                  completed: progress.completed,
                  total: progress.total
                })
              : t('Speech steps: {{completed}} / {{total}} · Lines: {{lines}} / {{totalLines}}', {
                  completed: progress.completed,
                  total: progress.total,
                  lines: progress.completedLines ?? 0,
                  totalLines: progress.totalLines
                })}
          </p>
        )}
      </div>
      {!terminal && (
        <ProgressBar
          value={
            counted && progress.total! > 0
              ? (progress.completed! / progress.total!) * 100
              : undefined
          }
          label={labels[progress.phase]}
        />
      )}
      <p className="tabular-nums">
        {t('Elapsed: {{seconds}} s', {
          seconds: Math.max(0, Math.floor(((progress.endedAt ?? now) - progress.startedAt) / 1000))
        })}
      </p>
    </div>
  )
}
