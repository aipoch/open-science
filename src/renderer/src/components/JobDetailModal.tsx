import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ExternalLink, X } from 'lucide-react'
import { Dialog } from 'radix-ui'

import type { JobSummary } from '../../../shared/compute'
import { useSessionJobStore } from '@/stores/session-job-store'
import { Button } from '@/components/ui/button'
import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'
import { JobStatusBadge } from './JobStatusBadge'
import { JobTerminalOutput } from './JobTerminalOutput'
import { formatDuration, jobElapsedMs } from './remote-job-badge-utils'
import { FileBrowserModal } from '../pages/settings/FileBrowserModal'

// How often the terminal output auto-refreshes (design.md §15.3: ≈15s).
const TERMINAL_REFRESH_MS = 15_000

// ─── Session jobs list view (Back view inside the modal) ─────────────────────

type SessionJobsListProps = {
  sessionId: string
  onSelectJob: (job: JobSummary) => void
  onClose: () => void
}

function SessionJobsList({
  sessionId,
  onSelectJob,
  onClose
}: SessionJobsListProps): React.JSX.Element {
  const jobsById = useSessionJobStore((s) => s.jobsById)
  const jobs = Array.from(jobsById.values())
    .filter((j) => j.session_id === sessionId)
    .sort((a, b) => b.created_at - a.created_at)

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <>
      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-testid="session-jobs-list">
        {jobs.length === 0 ? (
          <div className="flex flex-1 items-center justify-center py-10 text-sm text-muted-foreground">
            No remote jobs in this session.
          </div>
        ) : (
          jobs.map((job) => {
            const isRunning = job.status === 'running' || job.status === 'submitted'
            const elapsedMs = jobElapsedMs(job, now)
            const elapsedStr = formatDuration(elapsedMs)
            const intentDisplay =
              job.intent.length > 55 ? `${job.intent.slice(0, 52)}…` : job.intent

            return (
              <button
                key={job.job_id}
                type="button"
                data-testid="session-job-row"
                className="flex cursor-pointer items-start gap-2.5 border-b border-border px-4.5 py-3 text-left hover:bg-muted/50 transition-colors last:border-b-0"
                onClick={() => onSelectJob(job)}
              >
                <div className="flex flex-1 flex-col gap-1.5 min-w-0">
                  <span className="text-[13px] text-foreground truncate">{intentDisplay}</span>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="rounded bg-muted px-2 py-0.5 text-xs text-secondary-foreground">
                      {job.display_name}
                    </span>
                    <JobStatusBadge status={job.status} />
                  </div>
                </div>
                <span className="shrink-0 text-[12px] text-muted-foreground">
                  {isRunning ? elapsedStr : ''}
                </span>
              </button>
            )
          })
        )}
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </>
  )
}

// ─── Job detail view ──────────────────────────────────────────────────────────

type ActiveTab = 'stdout' | 'stderr'

type JobDetailViewProps = {
  job: JobSummary
  onBack: () => void
  onOpenFileBrowser: (path: string, providerId: string) => void
}

function JobDetailView({ job, onBack, onOpenFileBrowser }: JobDetailViewProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<ActiveTab>('stdout')

  // Pull latest data from the store on every render (store subscribes to compute:job-updated).
  const latestJob = useSessionJobStore((s) => s.jobsById.get(job.job_id)) ?? job

  // Track elapsed time for running jobs
  const [now, setNow] = useState(() => Date.now())
  const isRunning = latestJob.status === 'running' || latestJob.status === 'submitted'

  // Tick for elapsed time
  useEffect(() => {
    if (!isRunning) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isRunning])

  // ≈15s refresh trigger for terminal output (store already updates via compute:job-updated broadcast
  // which the app subscribes to; this force-tick ensures the component re-renders with fresh tail).
  const [refreshTick, setRefreshTick] = useState(0)
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!isRunning) {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
      return
    }
    refreshTimerRef.current = setInterval(() => {
      setRefreshTick((t) => t + 1)
    }, TERMINAL_REFRESH_MS)
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
    }
  }, [isRunning])

  // Suppress unused variable warning — refreshTick is consumed to trigger re-render cycle
  void refreshTick

  // Compute runtime display
  const runtimeDisplay = (): string => {
    if (latestJob.finished_at && latestJob.started_at) {
      return formatDuration(latestJob.finished_at - latestJob.started_at)
    }
    if (isRunning) {
      return formatDuration(jobElapsedMs(latestJob, now))
    }
    return '—'
  }

  const tabContent = activeTab === 'stdout' ? latestJob.stdout_tail : latestJob.stderr_tail

  return (
    <>
      {/* Sub-header: Back + job title + status badge */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-4 py-2.5">
        <button
          type="button"
          data-testid="job-detail-back"
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          onClick={onBack}
        >
          <ArrowLeft size={13} aria-hidden="true" />
          Back
        </button>
        <span className="flex-1 min-w-0 truncate text-[13px] font-medium">{latestJob.intent}</span>
        <JobStatusBadge status={latestJob.status} />
      </div>

      {/* Meta info grid */}
      <div
        className="grid shrink-0 grid-cols-2 bg-muted/40 border-b border-border"
        data-testid="job-meta"
      >
        <MetaRow label="Provider" value={latestJob.display_name} />
        <MetaRow label="Status" value={latestJob.status} />
        <MetaRow label="Runtime" value={runtimeDisplay()} />
        <MetaRow
          label="Remote workdir"
          value={latestJob.remote_workdir ?? '—'}
          isLink={!!latestJob.remote_workdir}
          onLinkClick={
            latestJob.remote_workdir
              ? () => onOpenFileBrowser(latestJob.remote_workdir!, latestJob.provider_id)
              : undefined
          }
        />
        {/* Job ID spans full width (design.md: mono, break-all) */}
        <div className="col-span-2 flex items-baseline gap-2 border-b border-border px-4 py-1.5">
          <span className="min-w-[54px] shrink-0 text-[11px] text-muted-foreground">Job ID</span>
          <span className="break-all font-mono text-[10.5px] text-muted-foreground">
            {latestJob.job_id}
          </span>
        </div>
      </div>

      {/* 3b placeholder: featured outputs / left-on-remote — hidden until harvest data exists */}
      {/* <FeaturedOutputs job={latestJob} /> */}

      {/* stdout / stderr tabs */}
      <div className="flex shrink-0 border-b border-border bg-background px-4">
        <TabButton
          label="stdout"
          active={activeTab === 'stdout'}
          onClick={() => setActiveTab('stdout')}
        />
        <TabButton
          label="stderr"
          active={activeTab === 'stderr'}
          onClick={() => setActiveTab('stderr')}
        />
      </div>

      {/* Terminal output body */}
      <div className="flex min-h-0 flex-1 overflow-auto p-3.5">
        <div className="w-full">
          <JobTerminalOutput content={tabContent} />
        </div>
      </div>
    </>
  )
}

// ─── Shared sub-components ────────────────────────────────────────────────────

type MetaRowProps = {
  label: string
  value: string
  isLink?: boolean
  onLinkClick?: () => void
}

function MetaRow({ label, value, isLink, onLinkClick }: MetaRowProps): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2 border-b border-border px-4 py-1.5">
      <span className="min-w-[54px] shrink-0 text-[11px] text-muted-foreground">{label}</span>
      {isLink && onLinkClick ? (
        <button
          type="button"
          className="flex items-center gap-1 text-[12.5px] text-secondary-foreground hover:underline"
          onClick={onLinkClick}
        >
          <span className="truncate max-w-[160px]">{value}</span>
          <ExternalLink size={11} className="shrink-0" aria-hidden="true" />
        </button>
      ) : (
        <span className="text-[12.5px] text-secondary-foreground truncate">{value}</span>
      )}
    </div>
  )
}

type TabButtonProps = {
  label: string
  active: boolean
  onClick: () => void
}

function TabButton({ label, active, onClick }: TabButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={`tab-${label}`}
      className={`px-3 py-1.5 text-[12px] transition-colors border-b-2 -mb-px ${
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

// ─── JobDetailModal (top-level) ───────────────────────────────────────────────

type ModalView = { kind: 'list' } | { kind: 'detail'; job: JobSummary }

type JobDetailModalProps = {
  open: boolean
  sessionId: string
  // Job to open directly (e.g. when clicking RemoteJobRow). If undefined, shows the list first.
  initialJob?: JobSummary
  onClose: () => void
}

export function JobDetailModal({
  open,
  sessionId,
  initialJob,
  onClose
}: JobDetailModalProps): React.JSX.Element {
  const [view, setView] = useState<ModalView>(() =>
    initialJob ? { kind: 'detail', job: initialJob } : { kind: 'list' }
  )
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false)
  const [fileBrowserState, setFileBrowserState] = useState<{
    providerId: string
    path: string
  } | null>(null)

  // Keep closing content stable for the exit animation, then reset before the next open is committed.
  const [previousInput, setPreviousInput] = useState(() => ({
    open,
    sessionId,
    initialJobId: initialJob?.job_id
  }))
  const inputChanged =
    open !== previousInput.open ||
    sessionId !== previousInput.sessionId ||
    initialJob?.job_id !== previousInput.initialJobId
  if (inputChanged) {
    setPreviousInput({ open, sessionId, initialJobId: initialJob?.job_id })
    if (open) {
      setView(initialJob ? { kind: 'detail', job: initialJob } : { kind: 'list' })
    }
  }

  const handleSelectJob = useCallback((job: JobSummary) => {
    setView({ kind: 'detail', job })
  }, [])

  const handleBack = useCallback(() => {
    setView({ kind: 'list' })
  }, [])

  const handleOpenFileBrowser = useCallback((path: string, providerId: string) => {
    setFileBrowserState({ path, providerId })
    setFileBrowserOpen(true)
  }, [])

  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(o) => {
          if (!o) onClose()
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={cn(dialogOverlayClassName, 'z-[70]')} />
          <Dialog.Content
            className={dialogPanelClassName(
              'z-[70] flex w-[640px] max-w-[calc(100vw-2rem)] max-h-[82vh] flex-col overflow-hidden p-0'
            )}
            aria-label="Remote job details"
            data-testid="job-detail-modal"
          >
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
              <span className="text-[14px] font-semibold">Running jobs in this session</span>
              <Dialog.Close asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Close">
                  <X className="size-4" />
                </Button>
              </Dialog.Close>
            </div>

            {/* View: list or detail */}
            {view.kind === 'list' ? (
              <SessionJobsList
                sessionId={sessionId}
                onSelectJob={handleSelectJob}
                onClose={onClose}
              />
            ) : (
              <JobDetailView
                job={view.job}
                onBack={handleBack}
                onOpenFileBrowser={handleOpenFileBrowser}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* FileBrowserModal for remote workdir navigation */}
      {fileBrowserState && (
        <FileBrowserModal
          open={fileBrowserOpen}
          onClose={() => setFileBrowserOpen(false)}
          initialProviderId={fileBrowserState.providerId}
          initialPath={fileBrowserState.path}
        />
      )}
    </>
  )
}
