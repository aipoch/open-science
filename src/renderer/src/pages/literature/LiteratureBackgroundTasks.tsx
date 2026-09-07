import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ListTodo, LoaderCircle, X } from 'lucide-react'
import { LiteratureErrorNotice } from './LiteratureErrorNotice'
import { Button } from '@/components/ui/button'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogPanelClassName,
  dialogOverlayClassName,
  dialogHeaderClassName,
  dialogTitleClassName,
  dialogDescriptionClassName
} from '@/components/ui/dialog-chrome'
import type { LiteratureJobSummary } from '../../../../shared/literature-jobs'

export function LiteratureBackgroundTasks({
  onOpen,
  onChanged,
  hidden = false
}: {
  onOpen: (job: LiteratureJobSummary) => void
  onChanged?: (itemIds: string[]) => void
  hidden?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [jobs, setJobs] = useState<LiteratureJobSummary[]>([])
  const [error, setError] = useState(false)
  const previous = useRef<LiteratureJobSummary[]>([])
  const initialized = useRef(false)
  const receive = useEffectEvent((summaries: LiteratureJobSummary[]) => {
    const changed = summaries.flatMap((job) => {
      const prior = previous.current.find(({ id }) => id === job.id)
      if (!prior) return initialized.current ? (job.completedItemIds ?? []) : []
      if (job.done <= prior.done) return []
      const known = new Set(prior.completedItemIds)
      return (job.completedItemIds ?? []).filter((id) => !known.has(id))
    })
    if (changed.length) onChanged?.([...new Set(changed)])
    previous.current = summaries
    initialized.current = true
    setJobs((current) =>
      JSON.stringify(current) === JSON.stringify(summaries) ? current : summaries
    )
  })
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    let inFlight = false
    let refreshRequested = false
    const poll = async (): Promise<void> => {
      if (inFlight) {
        refreshRequested = true
        return
      }
      inFlight = true
      try {
        const result = await window.api.literature.jobs({ action: 'list' })
        if (active) {
          receive(result.summaries ?? [])
          setError(false)
        }
      } catch {
        if (active) setError(true)
      } finally {
        inFlight = false
        const running = previous.current.some((job) =>
          ['queued', 'running', 'pausing'].includes(job.state)
        )
        if (active)
          timer = setTimeout(
            () => void poll(),
            refreshRequested ? 0 : !document.hidden && running ? 2000 : 30_000
          )
        refreshRequested = false
      }
    }
    void poll()
    const wake = (): void => {
      clearTimeout(timer)
      if (!document.hidden) void poll()
    }
    window.addEventListener('literature-jobs-changed', wake)
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      active = false
      clearTimeout(timer)
      window.removeEventListener('literature-jobs-changed', wake)
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [])
  const labels = {
    queued: t('Queued'),
    running: t('Running'),
    pausing: t('Pausing after the current reference…'),
    paused: t('Paused'),
    review: t('Awaiting review'),
    completed: t('Completed')
  }
  const pending = jobs.filter((job) => job.state !== 'completed' || job.failed > 0 || job.ready > 0)
  const running = pending.filter((job) => job.state === 'running' || job.state === 'pausing')
  const allPaused = pending.every((job) => job.state === 'paused')
  const checked = running.reduce(
    (sum, job) => sum + (job.processed ?? (job.phase === 'search' ? job.checked : job.done)),
    0
  )
  const total = running.reduce((sum, job) => sum + (job.phaseTotal ?? job.total), 0)
  if (hidden || (!pending.length && !open && !error)) return <></>
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button
          variant="ghost"
          className="text-muted-foreground"
          aria-label={t('Background tasks')}
        >
          {error || (!running.length && pending.some((job) => job.failed > 0)) ? (
            <AlertCircle className="size-4 text-status-warning-foreground" aria-hidden="true" />
          ) : running.length ? (
            <LoaderCircle
              className="size-4 animate-spin motion-reduce:animate-none text-primary"
              aria-hidden="true"
            />
          ) : (
            <ListTodo className="size-4" aria-hidden="true" />
          )}
          {error
            ? t('Task list unavailable')
            : running.some((job) => job.state === 'pausing')
              ? t('Pausing…')
              : running.length
                ? running[0].phase === 'search'
                  ? t('Searching…')
                  : running[0].mode === 'full-text'
                    ? t('Downloading…')
                    : t('Saving…')
                : pending.some((job) => job.state === 'queued')
                  ? t('Queued')
                  : pending.some((job) => job.failed > 0)
                    ? t('Failed')
                    : allPaused
                      ? t('Paused')
                      : t('Awaiting review')}
          {!error ? (
            <span className="tabular-nums">
              {running.length ? `${checked}/${total}` : pending.length}
            </span>
          ) : null}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex max-h-[80vh] w-[min(40rem,calc(100vw-2rem))] flex-col p-0'
          )}
        >
          <header className={dialogHeaderClassName}>
            <div>
              <Dialog.Title className={dialogTitleClassName}>{t('Background tasks')}</Dialog.Title>
              <Dialog.Description className={dialogDescriptionClassName}>
                {t(
                  'Completed results are saved. Resume unfinished references after restarting the app.'
                )}
              </Dialog.Description>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('Close')}
              onClick={() => setOpen(false)}
            >
              <X aria-hidden="true" />
            </Button>
          </header>
          <div className="min-h-0 overflow-y-auto px-5 py-3">
            {error ? (
              <LiteratureErrorNotice
                title={t('Background task could not be updated. Try again.')}
                primaryButton={{
                  label: t('Retry'),
                  onClick: () => window.dispatchEvent(new Event('literature-jobs-changed'))
                }}
              />
            ) : null}
            {!jobs.length && !error ? (
              <p className="py-5 text-sm text-muted-foreground">{t('No background tasks yet.')}</p>
            ) : null}
            <ul className="divide-y divide-border-300/60">
              {jobs.map((job) => (
                <li key={job.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">
                      {job.mode === 'metadata' ? t('Complete metadata') : t('Find full-text PDF')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {labels[job.state]} ·{' '}
                      {job.phase === 'search'
                        ? t('Checked {{checked}} of {{total}}', {
                            checked: job.checked,
                            total: job.total
                          })
                        : job.mode === 'metadata'
                          ? t('Metadata updated: {{done}}', { done: job.done })
                          : t('PDFs added: {{done}}', { done: job.done })}
                      {job.failed > 0 ? ` · ${t('Failed')}: ${job.failed}` : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(job.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setOpen(false)
                        onOpen(job)
                      }}
                    >
                      {t('Open')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={['queued', 'running', 'pausing'].includes(job.state)}
                      onClick={() => {
                        void window.api.literature.jobs({ action: 'remove', jobId: job.id }).then(
                          () => setJobs((current) => current.filter(({ id }) => id !== job.id)),
                          () => setError(true)
                        )
                      }}
                    >
                      {t('Remove task')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
