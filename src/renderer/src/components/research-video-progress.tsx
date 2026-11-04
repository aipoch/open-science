import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ProgressBar } from './ui/progress-bar'
import type {
  ResearchVideoProgress,
  ResearchVideoProgressRequest
} from '../../../shared/research-video-progress'

export function ResearchVideoProgressLine({
  progress
}: {
  progress: ResearchVideoProgress
}): React.JSX.Element {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
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
      {!['completed', 'cancelled', 'failed'].includes(progress.phase) && (
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
          seconds: Math.max(0, Math.floor((now - progress.startedAt) / 1000))
        })}
      </p>
    </div>
  )
}

export function ResearchVideoGenerationProgress(
  props: ResearchVideoProgressRequest
): React.JSX.Element | null {
  const { projectId, sessionId, branchId } = props
  const requestKey = JSON.stringify([projectId, sessionId, branchId])
  const [snapshot, setSnapshot] = useState<{ key: string; progress?: ResearchVideoProgress }>()
  const progress = snapshot?.key === requestKey ? snapshot.progress : undefined
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      let next: ResearchVideoProgress | undefined
      try {
        next = await window.api.researchVideo.getProgress({ projectId, sessionId, branchId })
      } catch {
        /* A recovering runtime may be unavailable briefly. */
      }
      if (!live) return
      setSnapshot({ key: requestKey, progress: next })
      timer = setTimeout(() => void poll(), next ? 500 : 1500)
    }
    void poll()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [projectId, sessionId, branchId, requestKey])
  return progress ? (
    <div className="mx-4 mb-2 rounded-md border border-border p-3">
      <ResearchVideoProgressLine progress={progress} />
    </div>
  ) : null
}
