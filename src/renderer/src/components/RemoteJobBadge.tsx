import { useEffect, useMemo, useState } from 'react'
import { Zap } from 'lucide-react'

import type { JobSummary } from '../../../shared/compute'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionJobStore } from '@/stores/session-job-store'
import { formatDuration, jobElapsedMs, jobRowDuration } from './remote-job-badge-utils'

// Badge props — sessionId is used to scope the running job list to the active session.
type RemoteJobBadgeProps = {
  sessionId: string
  onOpenJobList?: () => void
}

// Amber capsule badge placed on the notebook bar right side (design.md §4).
// While any job is in-flight it shows the active counts + elapsed time ("N running · M queued ·
// elapsed"); queued jobs (waiting for a concurrency slot) keep the badge amber so they are never
// hidden. Shows a gray "N jobs" once every job is terminal, and is hidden only when the session has
// no jobs at all. Hover reveals a tooltip listing each in-flight job's host + intent + duration
// (queued rows show "queued" instead of an elapsed time).
export const RemoteJobBadge = ({
  sessionId,
  onOpenJobList
}: RemoteJobBadgeProps): React.JSX.Element | null => {
  // Subscribe to the raw job map (not the allJobsForSession selector fn, whose reference is stable)
  // so the badge re-renders the instant a job is added or changes status — applyUpdate replaces the
  // map on every broadcast. Without this the badge would only refresh on the 1s elapsed-time tick.
  const jobsById = useSessionJobStore((state) => state.jobsById)
  const [now, setNow] = useState(() => Date.now())

  // Tick every second to keep elapsed times fresh.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // Jobs for this session, newest first — recomputed whenever the job map changes.
  const allJobs = useMemo(
    () =>
      Array.from(jobsById.values())
        .filter((j) => j.session_id === sessionId)
        .sort((a, b) => b.created_at - a.created_at),
    [jobsById, sessionId]
  )

  // Running jobs are dispatched to the remote host (running or submitted there);
  // queued jobs are waiting locally for a free concurrency slot. Both are in-flight and
  // keep the badge amber. Terminal jobs (success/failed/timeout/error) only count toward "N jobs".
  const runningJobs = allJobs.filter((j) => j.status === 'running' || j.status === 'submitted')
  const queuedJobs = allJobs.filter((j) => j.status === 'queued')
  const activeJobs = [...runningJobs, ...queuedJobs]

  // Hidden only when session has no jobs at all.
  if (allJobs.length === 0) return null

  const isActive = activeJobs.length > 0

  if (isActive) {
    // Active state: amber badge with "N running [· N queued] · elapsed".
    const oldest = activeJobs.reduce<JobSummary>((a, b) => {
      const aStart = a.started_at ?? a.created_at
      const bStart = b.started_at ?? b.created_at
      return aStart <= bStart ? a : b
    }, activeJobs[0]!)

    const elapsedMs = jobElapsedMs(oldest, now)
    const elapsedStr = formatDuration(elapsedMs)

    // Count segments — only non-zero groups appear, joined with " · ".
    const segments: string[] = []
    if (runningJobs.length > 0) segments.push(`${runningJobs.length} running`)
    if (queuedJobs.length > 0) segments.push(`${queuedJobs.length} queued`)

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onOpenJobList}
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
                cursor: onOpenJobList ? 'pointer' : 'default'
              }}
              aria-label={`${segments.join(', ')} remote job${activeJobs.length !== 1 ? 's' : ''}`}
            >
              <Zap size={11} />
              <span>
                {segments.join(' · ')} · {elapsedStr}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" align="end" className="p-0 overflow-hidden max-w-sm">
            <div className="px-2 py-1.5">
              <p className="text-[10px] font-medium uppercase tracking-wider opacity-60 mb-1.5">
                REMOTE · {activeJobs.length}
              </p>
              {activeJobs.map((job) => (
                <div key={job.job_id} className="flex items-center gap-2 py-0.5">
                  <Zap size={10} style={{ color: 'var(--session-waiting)', flexShrink: 0 }} />
                  <span className="text-[11px] opacity-70 shrink-0">{job.display_name}</span>
                  <span className="text-[11px] flex-1 truncate">{job.intent}</span>
                  <span className="text-[11px] opacity-60 shrink-0 ml-1">
                    {jobRowDuration(job, now)}
                  </span>
                </div>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  // Idle state: gray badge with "N jobs"
  return (
    <button
      type="button"
      onClick={onOpenJobList}
      style={{
        background: 'var(--bg-200)',
        border: '1px solid var(--border-200)',
        color: 'var(--text-100)',
        borderRadius: '12px',
        padding: '3px 10px',
        fontSize: '11.5px',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        cursor: onOpenJobList ? 'pointer' : 'default'
      }}
      aria-label={`${allJobs.length} remote job${allJobs.length !== 1 ? 's' : ''}`}
    >
      <Zap size={11} />
      <span>{allJobs.length} jobs</span>
    </button>
  )
}
