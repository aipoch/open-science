import type { JobSummary } from '../../../shared/compute'

// Formats elapsed milliseconds as "Xm Ys" (e.g. "3m 33s") or "Xs" for under a minute.
export const formatDuration = (ms: number): string => {
  const totalSecs = Math.max(0, Math.floor(ms / 1000))
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  if (mins === 0) return `${secs}s`
  return `${mins}m ${secs}s`
}

// Returns the elapsed time in ms for a job, measuring from started_at (or created_at as fallback).
export const jobElapsedMs = (job: JobSummary, now: number): number => {
  const start = job.started_at ?? job.created_at
  return now - start
}
