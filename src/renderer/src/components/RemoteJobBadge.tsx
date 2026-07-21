import { useEffect, useState } from 'react'
import { Zap } from 'lucide-react'

import type { JobSummary } from '../../../shared/compute'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionJobStore } from '@/stores/session-job-store'
import { formatDuration, jobElapsedMs } from './remote-job-badge-utils'

// Badge props — sessionId is used to scope the running job list to the active session.
type RemoteJobBadgeProps = {
  sessionId: string
}

// Amber capsule badge placed on the notebook bar right side (design.md §4).
// Hidden when no jobs are running; shows running count + elapsed time of the oldest running job.
// Hover reveals a tooltip listing each running job's host + intent + duration.
export const RemoteJobBadge = ({ sessionId }: RemoteJobBadgeProps): React.JSX.Element | null => {
  const runningJobsForSession = useSessionJobStore((state) => state.runningJobsForSession)
  const [now, setNow] = useState(() => Date.now())

  // Tick every second to keep elapsed times fresh.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const running = runningJobsForSession(sessionId)

  // Hidden when no running jobs — the badge only appears while something is actively running.
  if (running.length === 0) return null

  // Use the oldest started job for the main badge elapsed time (the one that's been running longest).
  const oldest = running.reduce<JobSummary>((a, b) => {
    const aStart = a.started_at ?? a.created_at
    const bStart = b.started_at ?? b.created_at
    return aStart <= bStart ? a : b
  }, running[0]!)

  const elapsedMs = jobElapsedMs(oldest, now)
  const elapsedStr = formatDuration(elapsedMs)

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            style={{
              background: 'color-mix(in srgb, var(--session-waiting) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--session-waiting) 25%, transparent)',
              color: 'var(--session-waiting)',
              borderRadius: '12px',
              padding: '3px 10px',
              fontSize: '11.5px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              cursor: 'default'
            }}
            aria-label={`${running.length} running remote job${running.length !== 1 ? 's' : ''}`}
          >
            <Zap size={11} />
            <span>
              {running.length} running · {elapsedStr}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" align="end" className="p-0 overflow-hidden max-w-sm">
          <div className="px-2 py-1.5">
            <p className="text-[10px] font-medium uppercase tracking-wider opacity-60 mb-1.5">
              REMOTE · {running.length}
            </p>
            {running.map((job) => (
              <div key={job.job_id} className="flex items-center gap-2 py-0.5">
                <Zap size={10} style={{ color: 'var(--session-waiting)', flexShrink: 0 }} />
                <span className="text-[11px] opacity-70 shrink-0">{job.display_name}</span>
                <span className="text-[11px] flex-1 truncate">{job.intent}</span>
                <span className="text-[11px] opacity-60 shrink-0 ml-1">
                  {formatDuration(jobElapsedMs(job, now))}
                </span>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
