import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Clock3,
  Monitor,
  Info,
  RefreshCw,
  LoaderCircle,
  Terminal,
  FileCode2,
  ChevronRight,
  Square
} from 'lucide-react'
import type {
  NotebookProcessMonitorSnapshot,
  NotebookProcessObservation
} from '../../../../shared/notebook-process-monitor'
import { Button } from '@/components/ui/button'
import { PythonIcon, RIcon } from '@/components/language-icons'
import { ErrorNotice } from '@/components/error-notice'
import type {
  NotebookProjectResources,
  NotebookSessionResources
} from '../../../../shared/notebook-resources'
import { NotebookResourcePanel, ResourceDetails } from './NotebookResourcePanel'
import { ComputePanel } from './ComputePanel'
import { ComputeOpenSessionButton, ResourceActionTooltip } from './ComputeResourceActions'
import {
  formatComputeUptime,
  releaseBlockedLabel,
  totalKernelUptime
} from './compute-monitor-presentation'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ComputeCellPreview } from './ComputeCellPreview'
import { useProjectStore } from '@/stores/project-store'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'

const resourceColumns =
  'grid grid-cols-[minmax(0,1fr)_3.5rem_3.25rem_5rem] items-center gap-x-1.5 @xl/compute:grid-cols-[minmax(0,1fr)_5.5rem_4rem_5.5rem]'

const resourceStopIconClassName =
  'justify-self-end text-muted-foreground hover:bg-destructive/10 hover:text-status-failure-strong dark:hover:bg-destructive/10 dark:hover:text-status-failure-dark-emphasis'

const bytes = (value: number): string => `${(value / 1024 ** 3).toFixed(1)} GB`
const megabytes = (value: number): string => `${(value / 1024 ** 2).toFixed(1)} MB`
const formatCpuCores = (value: number | undefined): string => {
  if (value === undefined) return '—'
  if (value > 0 && value < 0.001) return '<0.001'
  return value.toFixed(value > 0 && value < 0.01 ? 3 : 2)
}
const cores = formatCpuCores
const resourceTotal = (
  values: (number | undefined)[],
  format: (value: number) => string
): string => {
  const known = values.filter((value): value is number => value !== undefined)
  if (values.length === 0) return format(0)
  if (known.length === 0) return '—'
  const total = format(known.reduce((sum, value) => sum + value, 0))
  if (known.length === values.length) return total
  return total.startsWith('<') ? '> 0' : `≥ ${total}`
}
function Sparkline({
  values,
  label,
  tone
}: {
  values: (number | undefined)[]
  label: string
  tone: 'memory' | 'cpu'
}): React.JSX.Element {
  const max = Math.max(0.001, ...values.map((value) => value ?? 0))
  const points = values.map((value, index) =>
    value === undefined
      ? undefined
      : `${(index * 100) / Math.max(1, values.length - 1)},${23 - (value * 21) / max}`
  )
  const segments: string[][] = [[]]
  for (const point of points) {
    if (point === undefined) segments.push([])
    else segments[segments.length - 1].push(point)
  }
  return (
    <svg
      viewBox="0 0 100 26"
      preserveAspectRatio="none"
      className={`mt-1 h-5 w-full ${tone === 'cpu' ? 'text-status-info-foreground dark:text-status-info-dark-foreground' : 'text-primary'}`}
      role="img"
      aria-label={label}
    >
      <line x1="0" x2="100" y1="24" y2="24" className="stroke-border" />
      {segments.map((segment, index) => (
        <polyline
          key={index}
          points={segment.join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  )
}
// Live backend metrics and explicit per-instance termination.
export function ComputeProcessMonitor({
  isActive = true,
  projectId,
  sessionTitles,
  openSession
}: {
  isActive?: boolean
  projectId?: string
  sessionTitles: ReadonlyMap<string, string>
  openSession: (projectId: string, sessionId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const stopLabel = t('Stop')
  const stopAllLabel = t('Stop all')
  const formatDateTime = useDateTimeFormat()
  const projects = useProjectStore((state) => state.projects)
  const [snapshot, setSnapshot] = useState<NotebookProcessMonitorSnapshot>()
  const resourceProjectIds = snapshot?.resourceProjectIds
  const [allProjects, setAllProjects] = useState(true)
  const sessionContentId = useId()
  const [expandedSessions, setExpandedSessions] = useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const sourceIds = useRef<string[]>([])
  const active = useRef(isActive)
  useLayoutEffect(() => {
    active.current = isActive
    return () => {
      active.current = false
    }
  }, [isActive])
  const refreshInFlight = useRef(false)
  const [error, setError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [target, setTarget] = useState<NotebookProcessObservation>()
  const [comment, setComment] = useState('')
  const [confirmation, setConfirmation] = useState<NotebookSessionResources>()
  const preparingSessionStop = useRef(false)
  const sessionStopTrigger = useRef<HTMLButtonElement>(null)
  const allProjectsButton = useRef<HTMLButtonElement>(null)
  const [sessionStopError, setSessionStopError] = useState<{
    description: string
    diagnostics?: string
  }>()
  const [resourceReadFailures, setResourceReadFailures] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [resourceSnapshots, setResourceSnapshots] = useState(
    new Map<string, { value: NotebookProjectResources; observedAt: number }>()
  )
  const discoveredProjects = useRef<ReadonlySet<string>>(new Set())
  const unsettledProjects = useRef(new Set<string>())
  const resourceReads = useRef(new Map<string, Promise<NotebookProjectResources>>())
  const readResources = useCallback(
    (id: string, afterCommand = false): Promise<NotebookProjectResources> => {
      const pending = resourceReads.current.get(id)
      if (pending && !afterCommand) return pending
      const read: Promise<NotebookProjectResources> = window.api.notebook
        .getProjectResources({ projectId: id })
        .then(
          (value) => {
            if (active.current && !document.hidden && resourceReads.current.get(id) === read) {
              if (value.releases.some(({ status }) => status !== 'released'))
                unsettledProjects.current.add(id)
              else unsettledProjects.current.delete(id)
              setResourceSnapshots((previous) =>
                new Map(previous).set(id, { value, observedAt: Date.now() })
              )
              setResourceReadFailures((previous) => {
                if (!previous.has(id)) return previous
                const remaining = new Set(previous)
                remaining.delete(id)
                return remaining
              })
            }
            return value
          },
          (error: unknown) => {
            if (active.current && !document.hidden && resourceReads.current.get(id) === read) {
              setResourceReadFailures((previous) =>
                previous.has(id) ? previous : new Set(previous).add(id)
              )
            }
            throw error
          }
        )
        .finally(() => {
          if (resourceReads.current.get(id) === read) resourceReads.current.delete(id)
        })
      resourceReads.current.set(id, read)
      return read
    },
    []
  )
  const refreshResources = useCallback(
    (id: string, afterCommand = false): void => {
      if (!window.api.notebook.getProjectResources) return
      void readResources(id, afterCommand).catch(() => undefined)
    },
    [readResources]
  )
  const refreshVisibleResources = useCallback((): void => {
    const projectIds = new Set(projectId ? [projectId] : [])
    if (allProjects) {
      for (const id of discoveredProjects.current) projectIds.add(id)
      for (const id of unsettledProjects.current) projectIds.add(id)
    }
    for (const id of projectIds) refreshResources(id)
  }, [allProjects, projectId, refreshResources])
  const prepareSessionStop = async (
    id: string,
    sessionId: string,
    trigger: HTMLButtonElement
  ): Promise<void> => {
    if (preparingSessionStop.current || confirmation) return
    preparingSessionStop.current = true
    sessionStopTrigger.current = trigger
    setSessionStopError(undefined)
    try {
      const view = await readResources(id)
      if (!active.current || !trigger.isConnected) return
      const group = view.groups.find((entry) => entry.sessionId === sessionId)
      if (!group) {
        setSessionStopError({
          description: t('Notebook resources changed. Refresh and review the current resources.')
        })
        return
      }
      if (group.releaseBlockedReason) {
        setSessionStopError({ description: releaseBlockedLabel(group.releaseBlockedReason, t) })
        return
      }
      setTarget(undefined)
      setConfirmation(group)
    } catch (error) {
      if (active.current && trigger.isConnected) {
        setSessionStopError({
          description: t('Could not refresh Notebook resources'),
          diagnostics: error instanceof Error ? error.message : String(error)
        })
      }
    } finally {
      preparingSessionStop.current = false
    }
  }
  const reasonInput = useRef<HTMLTextAreaElement>(null)
  const stopTrigger = useRef<HTMLButtonElement>(null)
  const [history, setHistory] = useState(
    new Map<string, { memory: (number | undefined)[]; cpu: (number | undefined)[] }>()
  )
  const lastSample = useRef(0)
  const selectTarget = (item: NotebookProcessObservation, trigger: HTMLButtonElement): void => {
    stopTrigger.current = trigger
    setComment('')
    setTarget(item)
  }
  useEffect(() => {
    if (target) reasonInput.current?.focus()
  }, [target])
  const cancelTermination = (): void => {
    setTarget(undefined)
    stopTrigger.current?.focus()
  }
  const [stopping, setStopping] = useState<string>()
  const [actionError, setActionError] = useState(false)
  const refresh = useCallback(async (showIndicator = false): Promise<void> => {
    if (!active.current || document.hidden || refreshInFlight.current) return
    refreshInFlight.current = true
    if (showIndicator) setRefreshing(true)
    try {
      const value = await window.api.notebook.getProcessMonitor({ sourceIds: sourceIds.current })
      if (!active.current || document.hidden) return
      if (value.sampledAt > lastSample.current) {
        const liveIds = new Set(value.instances.map((item) => item.id))
        setExpanded((previous) => {
          const next = new Set([...previous].filter((id) => liveIds.has(id)))
          return next.size === previous.size ? previous : next
        })
        setHistory((previousHistory) => {
          const next = new Map<
            string,
            { memory: (number | undefined)[]; cpu: (number | undefined)[] }
          >()
          for (const item of value.instances) {
            const previous = previousHistory.get(item.id)
            next.set(item.id, {
              memory: [...(previous?.memory ?? []), item.memoryBytes].slice(-30),
              cpu: [...(previous?.cpu ?? []), item.cpuCores].slice(-30)
            })
          }
          return next
        })
        lastSample.current = value.sampledAt
      }
      if (value.sampledAt >= lastSample.current) setSnapshot(value)
      setError(false)
    } catch {
      setError(true)
    } finally {
      refreshInFlight.current = false
      if (showIndicator) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    sourceIds.current = [...expanded]
    if (isActive && expanded.size) queueMicrotask(() => void refresh())
  }, [expanded, isActive, refresh])

  useEffect(() => {
    if (!isActive || !allProjects || document.hidden || !resourceProjectIds) return
    const previous = discoveredProjects.current
    const next = new Set(resourceProjectIds)
    discoveredProjects.current = next
    for (const id of next) if (!previous.has(id) && id !== projectId) refreshResources(id)
    // Re-read departures after the monitoring sample so a prior read cannot leave a stale row.
    for (const id of previous) if (!next.has(id)) refreshResources(id, true)
  }, [allProjects, isActive, projectId, refreshResources, resourceProjectIds])

  useEffect(() => {
    if (!isActive) return
    let disposed = false
    let polling = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      if (disposed || polling || document.hidden) return
      polling = true
      refreshVisibleResources()
      await refresh()
      polling = false
      if (!disposed && !document.hidden) timer = setTimeout(() => void poll(), 3000)
    }
    const onVisibility = (): void => {
      clearTimeout(timer)
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', onVisibility)
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [isActive, refresh, refreshVisibleResources])

  const terminate = async (item: NotebookProcessObservation, force = false): Promise<void> => {
    if (stopping) return
    setStopping(item.id)
    setActionError(false)
    try {
      await window.api.notebook.terminateMonitoredProcess({
        id: item.id,
        projectId: item.projectId,
        sessionId: item.sessionId,
        ...(force ? { force: true } : comment.trim() ? { comment: comment.trim() } : {})
      })
    } catch {
      setActionError(true)
    } finally {
      setTarget(undefined)
      setStopping(undefined)
      await refresh()
    }
  }
  const selectScope = (all: boolean): void => {
    if (all === allProjects) return
    setAllProjects(all)
    setExpanded(new Set())
    setTarget(undefined)
    setConfirmation(undefined)
    setSessionStopError(undefined)
  }
  const instances = (snapshot?.instances ?? []).filter(
    (item) => allProjects || item.projectId === projectId
  )
  const resourceInScope = (id: string): boolean =>
    id === projectId || (allProjects && (!resourceProjectIds || resourceProjectIds.includes(id)))
  const resourceReadFailed = [...resourceReadFailures].some(
    (id) =>
      resourceInScope(id) ||
      (allProjects &&
        resourceSnapshots.get(id)?.value.releases.some(({ status }) => status !== 'released'))
  )
  const cpuDescription = (value: number | undefined): string =>
    value === undefined
      ? t('CPU usage')
      : t('{{percent}}% CPU · 100% = 1 core', {
          percent: value > 0 && value < 0.0001 ? '<0.01' : (value * 100).toFixed(2)
        })
  const groupKey = (item: { projectId: string; sessionId: string }): string =>
    JSON.stringify([item.projectId, item.sessionId])
  const groups = Map.groupBy(instances, groupKey)
  const resourceGroups = new Map(
    [...resourceSnapshots.entries()].flatMap(([id, { value }]) =>
      resourceInScope(id) ? value.groups.map((group) => [groupKey(group), group] as const) : []
    )
  )
  for (const [key, group] of resourceGroups) {
    if (!groups.has(key) && group.resources.some(({ group }) => group !== 'operation'))
      groups.set(key, [])
  }
  const host = snapshot?.host
  const uptime = (seconds: number): string => formatComputeUptime(seconds, t)
  const status = (item: NotebookProcessObservation): string => {
    if (item.id === stopping || item.status === 'cleaning') return t('Cleaning up')
    if (item.canForceClose) return t('Stop timed out')
    if (item.status === 'cleanup-failed') return t('Cleanup failed')
    return item.status === 'running' ? t('Running') : t('Idle')
  }
  const kind = (item: NotebookProcessObservation): string =>
    item.kind === 'python'
      ? 'Python'
      : item.kind === 'r'
        ? 'R'
        : item.kind === 'repl'
          ? t('JavaScript REPL')
          : t('Shell')

  const selectedMemory =
    target?.memoryBytes === undefined ? undefined : megabytes(target.memoryBytes)
  const terminationForm = target && (
    <form
      aria-label={t('Stop this kernel?')}
      className="border-t border-border bg-muted/30 px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!stopping) void terminate(target)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !stopping) {
          event.preventDefault()
          cancelTermination()
        }
      }}
    >
      <p className="text-xs font-medium">
        {t('Stop this kernel?')}
        <span className="ml-2 font-normal text-muted-foreground">
          {kind(target)}
          {selectedMemory && <> · {t('{{memory}} held', { memory: selectedMemory })}</>}
        </span>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('Stops execution and clears all variables. The agent will need to rebuild its state.')}
      </p>
      <label className="mt-3 block text-xs">
        <span className="sr-only">{t('Reason for stopping (optional)')}</span>
        <textarea
          ref={reasonInput}
          className="min-h-20 w-full rounded-md border border-border bg-card p-3 text-sm"
          value={comment}
          maxLength={2000}
          disabled={Boolean(stopping)}
          onChange={(event) => setComment(event.target.value)}
          placeholder={t('e.g. "This uses too much memory — try smaller batches" (optional)')}
        />
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-foreground"
          disabled={Boolean(stopping)}
          onClick={cancelTermination}
        >
          {t('Cancel')}
        </Button>
        <Button
          type="submit"
          variant="destructive"
          size="sm"
          disabled={Boolean(stopping)}
          aria-label={t('Terminate')}
        >
          {stopping
            ? t('Cleaning up')
            : selectedMemory
              ? t('Stop · free ~{{memory}}', { memory: selectedMemory })
              : t('Terminate')}
        </Button>
        <p className="text-[11px] text-muted-foreground sm:ml-auto">
          {t(
            'A short note helps the agent understand why you stopped and decide what to try next.'
          )}
        </p>
      </div>
    </form>
  )

  return (
    <TooltipProvider>
      <ComputePanel
        title={t('Local computer')}
        icon={Monitor}
        description={host ? `${host.hostname} · ${host.platform}` : t('Loading…')}
        label={t('Local process monitor')}
        action={
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={() => {
              refreshVisibleResources()
              void refresh(true)
            }}
            disabled={refreshing}
            aria-label={t('Refresh')}
            title={t('Updates every 3 seconds')}
          >
            <RefreshCw className={refreshing ? 'size-4 animate-spin' : 'size-4'} />
          </Button>
        }
      >
        <div className="px-3 @md/compute:px-4">
          {error && (
            <ErrorNotice
              inline
              title={t('Could not refresh process monitoring')}
              description={t('The last successful sample is shown. Try refreshing again.')}
            />
          )}
          <details className="group/system border-b border-border" data-system-details>
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-md py-2.5 outline-none focus-visible:keyboard-focus [&::-webkit-details-marker]:hidden">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ChevronRight className="size-3 transition-transform motion-reduce:transition-none group-open/system:rotate-90" />
                {t('System details')}
              </span>
              <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="whitespace-nowrap" title={t('CPU usage')}>
                  {t('CPU usage')}{' '}
                  <strong className="ml-1 font-medium tabular-nums text-foreground">
                    {host?.cpuPercent === undefined ? '—' : `${host.cpuPercent.toFixed(1)}%`}
                  </strong>
                </span>
                <span className="whitespace-nowrap" title={t('System memory, excluding caches')}>
                  {t('Memory usage')}{' '}
                  <strong className="ml-1 font-medium tabular-nums text-foreground">
                    {host
                      ? `${bytes(host.memoryUsedBytes)} / ${bytes(host.memoryTotalBytes)}`
                      : '—'}
                  </strong>
                </span>
                {host?.memoryCommittedBytes !== undefined &&
                host.memoryCommitLimitBytes !== undefined ? (
                  <span className="whitespace-nowrap" title={t('Committed / limit')}>
                    {t('Committed / limit')}{' '}
                    <strong className="ml-1 font-medium tabular-nums text-foreground">
                      {bytes(host.memoryCommittedBytes)} / {bytes(host.memoryCommitLimitBytes)}
                    </strong>
                  </span>
                ) : null}
              </span>
            </summary>
            <div className="mb-3 flex flex-wrap gap-x-5 gap-y-2 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
              {host && (
                <>
                  <span title={t('System uptime')}>
                    {t('Uptime')} · {uptime(host.uptimeSeconds)}
                  </span>
                  <span>
                    {t('{{count}} logical processors', {
                      count: host.cpuCount,
                      defaultValue_one: '{{count}} logical processor'
                    })}
                  </span>
                </>
              )}
              <span>{t('Updates every 3 seconds')}</span>
            </div>
          </details>
          <div>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-4 pb-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">{t('Notebook resources')}</h3>
                <p
                  className="mt-1 flex flex-wrap gap-x-2 text-xs tabular-nums text-muted-foreground"
                  data-testid="kernel-summary"
                >
                  <span>
                    {t('{{count}} processes', {
                      count: instances.length,
                      defaultValue_one: '{{count}} process'
                    })}
                  </span>
                  <span>
                    ·{' '}
                    {t('{{count}} running', {
                      count: instances.filter((item) => item.status === 'running').length
                    })}
                  </span>
                  <span className="sr-only">
                    ·{' '}
                    {resourceTotal(
                      instances.map((item) => item.memoryBytes),
                      megabytes
                    )}
                  </span>
                  <span className="sr-only">
                    ·{' '}
                    {resourceTotal(
                      instances.map((item) => item.cpuCores),
                      cores
                    )}{' '}
                    {t('cores')}
                  </span>
                </p>
              </div>
              <div
                className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/60 p-0.5"
                role="group"
                aria-label={t('Notebook resources')}
              >
                <Button
                  ref={allProjectsButton}
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-xs"
                  onClick={() => selectScope(true)}
                  aria-pressed={allProjects}
                >
                  {t('All projects')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-xs"
                  onClick={() => selectScope(false)}
                  aria-pressed={!allProjects}
                  disabled={!projectId}
                >
                  {t('Current project')}
                </Button>
              </div>
            </div>
            {actionError && (
              <ErrorNotice
                inline
                title={t('Process cleanup could not be confirmed')}
                description={t(
                  'The process remains listed if cleanup is incomplete. Refresh and retry.'
                )}
              />
            )}
            {resourceReadFailed && sessionStopError?.diagnostics === undefined && (
              <ErrorNotice inline role="status" title={t('Could not refresh Notebook resources')} />
            )}
            {sessionStopError && (
              <ErrorNotice
                inline
                role="alert"
                title={t('Notebook resources')}
                description={sessionStopError.description}
                errorCode={sessionStopError.diagnostics}
                diagnosticsLabel={
                  sessionStopError.diagnostics !== undefined ? t('Details') : undefined
                }
                dismissButton={{
                  label: t('Dismiss'),
                  onClick: () => setSessionStopError(undefined)
                }}
              />
            )}
            {groups.size > 0 && (
              <div className={`${resourceColumns} px-2 pb-1.5 text-xs text-muted-foreground`}>
                <span className="ps-5">{t('Session')}</span>
                <span className="text-right">{t('Memory', { context: 'runtime' })}</span>
                <span className="text-right" title={t('CPU cores')}>
                  <span aria-hidden="true" className="@lg/compute:hidden">
                    {t('CPU')}
                  </span>
                  <span className="sr-only @lg/compute:not-sr-only">{t('CPU cores')}</span>
                </span>
              </div>
            )}
            <div
              className={
                groups.size > 0 ? 'divide-y divide-border border-y border-border' : undefined
              }
            >
              {[...groups]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, items]) => {
                  const group = resourceGroups.get(key)
                  const scope = items[0] ?? group!
                  const other =
                    group?.resources.filter(
                      ({ group }) =>
                        group !== 'operation' &&
                        (!items.length || (group !== 'kernel' && group !== 'shell'))
                    ) ?? []
                  const sessionOpen = expandedSessions.has(key)
                  const projectName =
                    projects.find(({ id }) => id === scope.projectId)?.name ?? scope.projectId
                  const contentId = `${sessionContentId}-${encodeURIComponent(key)}`
                  const titleId = `${contentId}-title`
                  const sessionTitle =
                    sessionTitles.get(scope.sessionId) || t('Untitled conversation')
                  return (
                    <section key={key}>
                      <header className={`${resourceColumns} px-2`}>
                        <div className="min-w-0 py-2">
                          <div className="flex min-w-0 items-start gap-0.5">
                            <button
                              type="button"
                              className="flex min-w-0 items-start gap-2 rounded-md text-left outline-none hover:bg-muted/40 focus-visible:keyboard-focus"
                              title={sessionTitle}
                              aria-expanded={sessionOpen}
                              aria-controls={contentId}
                              onClick={() => {
                                setExpandedSessions((previous) => {
                                  const next = new Set(previous)
                                  if (sessionOpen) next.delete(key)
                                  else next.add(key)
                                  return next
                                })
                                if (!sessionOpen) refreshResources(scope.projectId)
                                else {
                                  const ids = new Set(items.map((item) => item.id))
                                  setExpanded(
                                    (previous) =>
                                      new Set([...previous].filter((id) => !ids.has(id)))
                                  )
                                  if (target && ids.has(target.id)) setTarget(undefined)
                                }
                              }}
                            >
                              <ChevronRight
                                aria-hidden="true"
                                className={`mt-1 size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${sessionOpen ? 'rotate-90' : ''}`}
                              />
                              <span
                                id={titleId}
                                className="line-clamp-2 text-sm font-semibold [overflow-wrap:anywhere]"
                              >
                                {sessionTitle}
                              </span>
                            </button>
                            <ComputeOpenSessionButton
                              className="-mt-0.5 shrink-0 self-start"
                              describedBy={titleId}
                              onClick={() => openSession(scope.projectId, scope.sessionId)}
                            />
                          </div>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 ps-5 text-xs tabular-nums text-muted-foreground">
                            {(allProjects || items.length > 0) && (
                              <span className="inline-flex min-w-0 items-center gap-1.5">
                                {allProjects && (
                                  <span className="min-w-0 truncate" title={projectName}>
                                    {projectName}
                                  </span>
                                )}
                                {allProjects && items.length > 0 && (
                                  <span aria-hidden="true" className="shrink-0">
                                    {'·'}
                                  </span>
                                )}
                                {items.length > 0 && (
                                  <span className="shrink-0 whitespace-nowrap">
                                    {t('{{count}} processes', {
                                      count: items.length,
                                      defaultValue_one: '{{count}} process'
                                    })}
                                  </span>
                                )}
                              </span>
                            )}
                            {items.length > 0 && snapshot && (
                              <span
                                className="sr-only"
                                title={t('Sum of current kernel uptimes, including idle time.')}
                                aria-label={t('Total kernel uptime: {{duration}}', {
                                  duration: uptime(totalKernelUptime(items, snapshot.sampledAt))
                                })}
                              >
                                <Clock3 className="size-3" aria-hidden="true" />
                                <span data-session-uptime>
                                  {uptime(totalKernelUptime(items, snapshot.sampledAt))}
                                </span>
                              </span>
                            )}
                            {items.some((item) => item.status === 'cleanup-failed') && (
                              <span className="text-status-failure-strong">
                                {t('Cleanup failed')}
                              </span>
                            )}
                            {(group?.releaseBlockedReason === 'release-in-progress' ||
                              items.some(
                                (item) => item.status === 'cleaning' || item.id === stopping
                              )) && <span>{t('Cleaning up')}</span>}
                          </span>
                        </div>
                        <span
                          className="text-right text-xs font-medium tabular-nums whitespace-nowrap"
                          title={t('Process memory')}
                        >
                          {resourceTotal(
                            items.map((item) => item.memoryBytes),
                            megabytes
                          )}
                        </span>
                        <span
                          className="text-right text-xs font-medium tabular-nums whitespace-nowrap"
                          title={t('CPU cores')}
                        >
                          {resourceTotal(
                            items.map((item) => item.cpuCores),
                            cores
                          )}
                        </span>
                        <ResourceActionTooltip label={stopAllLabel}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className={resourceStopIconClassName}
                            aria-label={stopAllLabel}
                            aria-describedby={titleId}
                            disabled={
                              Boolean(stopping) ||
                              group?.releaseBlockedReason === 'release-in-progress' ||
                              items.some((item) => item.status === 'cleaning')
                            }
                            onClick={(event) =>
                              void prepareSessionStop(
                                scope.projectId,
                                scope.sessionId,
                                event.currentTarget
                              )
                            }
                          >
                            <Square aria-hidden="true" className="size-3.5" strokeWidth={1.7} />
                          </Button>
                        </ResourceActionTooltip>
                      </header>
                      <div
                        id={contentId}
                        hidden={!sessionOpen}
                        className="mb-2 ml-3 divide-y divide-border/70 rounded-md bg-muted/35 @lg/compute:ml-7"
                      >
                        {sessionOpen &&
                          items.map((item) => (
                            <div key={item.id}>
                              <details
                                data-kernel-details
                                open={expanded.has(item.id)}
                                className="group/kernel"
                                onToggle={(event) => {
                                  const open = event.currentTarget.open
                                  setExpanded((previous) => {
                                    if (previous.has(item.id) === open) return previous
                                    const next = new Set(previous)
                                    if (open) next.add(item.id)
                                    else next.delete(item.id)
                                    return next
                                  })
                                }}
                              >
                                <summary
                                  className={`${resourceColumns} cursor-pointer list-none rounded-md px-2 py-2 outline-none hover:bg-muted/60 focus-visible:keyboard-focus [&::-webkit-details-marker]:hidden`}
                                >
                                  <div className="flex min-w-0 items-start gap-1.5">
                                    <ChevronRight className="mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none group-open/kernel:rotate-90" />
                                    <span
                                      className="mt-px inline-flex size-4 shrink-0"
                                      role="img"
                                      aria-label={kind(item)}
                                      title={kind(item)}
                                    >
                                      <span className="size-full" aria-hidden="true">
                                        {item.kind === 'python' ? (
                                          <PythonIcon />
                                        ) : item.kind === 'r' ? (
                                          <RIcon />
                                        ) : item.kind === 'repl' ? (
                                          <FileCode2 className="size-full text-primary" />
                                        ) : (
                                          <Terminal className="size-full text-muted-foreground" />
                                        )}
                                      </span>
                                    </span>
                                    <div className="min-w-0">
                                      <p
                                        className="truncate text-sm leading-5"
                                        title={item.environment ?? kind(item)}
                                      >
                                        {kind(item)}
                                        {item.environment && (
                                          <span className="text-xs text-muted-foreground">
                                            {` · ${item.environment}`}
                                          </span>
                                        )}
                                      </p>
                                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-4 text-muted-foreground">
                                        <span
                                          className="inline-flex items-center gap-1 data-[state=running]:text-status-success-foreground data-[state=timed-out]:text-status-warning-foreground dark:data-[state=running]:text-status-success-dark-foreground dark:data-[state=timed-out]:text-status-warning-dark-foreground"
                                          data-state={
                                            item.canForceClose ? 'timed-out' : item.status
                                          }
                                        >
                                          <span
                                            aria-hidden="true"
                                            className="size-1.5 shrink-0 rounded-full bg-current opacity-75"
                                          />
                                          {status(item)}
                                        </span>
                                        <span
                                          className="inline-flex items-center gap-1 whitespace-nowrap"
                                          title={t('Uptime')}
                                        >
                                          <Clock3 className="size-3" aria-hidden="true" />
                                          {uptime(
                                            Math.max(
                                              0,
                                              (snapshot?.sampledAt ?? item.startedAt) -
                                                item.startedAt
                                            ) / 1000
                                          )}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="min-w-0 text-right">
                                    <p
                                      className="whitespace-nowrap text-xs tabular-nums"
                                      title={t('Process memory')}
                                    >
                                      {item.memoryBytes === undefined
                                        ? '—'
                                        : megabytes(item.memoryBytes)}
                                    </p>
                                  </div>
                                  <div className="min-w-0 text-right">
                                    <p
                                      className="whitespace-nowrap text-xs tabular-nums"
                                      title={cpuDescription(item.cpuCores)}
                                    >
                                      {cores(item.cpuCores)}
                                    </p>
                                  </div>
                                  <ResourceActionTooltip
                                    label={item.canForceClose ? undefined : stopLabel}
                                  >
                                    <Button
                                      type="button"
                                      variant={item.canForceClose ? 'destructive' : 'ghost'}
                                      size={item.canForceClose ? 'xs' : 'icon-sm'}
                                      className={
                                        item.canForceClose
                                          ? 'h-auto min-h-7 max-w-full justify-self-end whitespace-normal [overflow-wrap:anywhere]'
                                          : resourceStopIconClassName
                                      }
                                      aria-label={
                                        !item.canForceClose && stopping !== item.id
                                          ? stopLabel
                                          : undefined
                                      }
                                      disabled={
                                        Boolean(stopping) ||
                                        item.status === 'cleaning' ||
                                        Boolean(group?.operationId)
                                      }
                                      aria-expanded={
                                        !item.canForceClose ? target?.id === item.id : undefined
                                      }
                                      onClick={(event) => {
                                        event.preventDefault()
                                        if (item.canForceClose) void terminate(item, true)
                                        else selectTarget(item, event.currentTarget)
                                      }}
                                    >
                                      {stopping === item.id ? (
                                        <LoaderCircle
                                          className="size-3.5 animate-spin"
                                          aria-label={t('Cleaning up')}
                                        />
                                      ) : item.canForceClose ? (
                                        t('Force close')
                                      ) : (
                                        <Square
                                          aria-hidden="true"
                                          className="size-3.5"
                                          strokeWidth={1.7}
                                        />
                                      )}
                                    </Button>
                                  </ResourceActionTooltip>
                                </summary>
                                {expanded.has(item.id) && (
                                  <div className="mx-2 border-t border-border px-1 pt-3 pb-3">
                                    <div className="mb-3 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                                      <div className="min-w-0 rounded-md border border-border bg-card px-2 py-1.5">
                                        <p>{t('Memory usage')}</p>
                                        <Sparkline
                                          values={history.get(item.id)?.memory ?? []}
                                          label={t('Memory usage')}
                                          tone="memory"
                                        />
                                      </div>
                                      <div className="min-w-0 rounded-md border border-border bg-card px-2 py-1.5">
                                        <p>{t('CPU usage')}</p>
                                        <Sparkline
                                          values={history.get(item.id)?.cpu ?? []}
                                          label={t('CPU usage')}
                                          tone="cpu"
                                        />
                                      </div>
                                    </div>
                                    {item.lastCell ? (
                                      <ComputeCellPreview
                                        code={item.lastCell.code}
                                        kind={item.kind}
                                        truncated={item.lastCell.truncated}
                                      />
                                    ) : (
                                      <p className="mb-4 text-xs text-muted-foreground">
                                        {item.hasLastCell
                                          ? t('Loading…')
                                          : t('No cell executed yet')}
                                      </p>
                                    )}
                                    {item.processes.length > 0 && (
                                      <>
                                        <div className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                                          <span className="font-medium text-foreground">
                                            {t('Process tree')} · {item.processes.length}
                                          </span>
                                          <span>
                                            {t('Started')} · {formatDateTime(item.startedAt)}
                                          </span>
                                        </div>
                                        <div className="overflow-x-auto">
                                          <table className="w-full table-fixed text-left text-[11px] tabular-nums">
                                            <thead className="text-muted-foreground">
                                              <tr>
                                                <th className="w-12 border-t border-border py-1 pr-1 font-medium @md/compute:w-16">
                                                  {t('Process ID')}
                                                </th>
                                                <th className="border-t border-border py-1 font-medium">
                                                  {t('Process tree')}
                                                </th>
                                                <th className="w-16 border-t border-border py-1 text-right font-medium @md/compute:w-20">
                                                  {t('Process memory')}
                                                </th>
                                                <th className="w-14 border-t border-border py-1 text-right font-medium @md/compute:w-16">
                                                  {t('CPU cores')}
                                                </th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {item.processes.map((child) => (
                                                <tr
                                                  key={child.pid}
                                                  className="border-t border-border"
                                                >
                                                  <td className="py-1 font-mono">{child.pid}</td>
                                                  <td className="py-1 pr-1 [overflow-wrap:anywhere]">
                                                    {child.command || kind(item)}
                                                  </td>
                                                  <td className="py-1 text-right">
                                                    {child.memoryBytes === undefined
                                                      ? '—'
                                                      : megabytes(child.memoryBytes)}
                                                  </td>
                                                  <td
                                                    className="py-1 text-right"
                                                    title={cpuDescription(child.cpuCores)}
                                                  >
                                                    {cores(child.cpuCores)}
                                                  </td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      </>
                                    )}
                                  </div>
                                )}
                              </details>
                              {target?.id === item.id && terminationForm}
                            </div>
                          ))}
                        {sessionOpen && other.length > 0 && (
                          <details className="group/other">
                            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-2 text-xs text-muted-foreground hover:bg-muted/60 focus-visible:keyboard-focus [&::-webkit-details-marker]:hidden">
                              <ChevronRight
                                className="size-3 transition-transform motion-reduce:transition-none group-open/other:rotate-90"
                                aria-hidden="true"
                              />
                              {t('Other resources')} ({other.length})
                            </summary>
                            <ul className="mx-2 divide-y divide-border/70 border-t border-border/70 text-xs">
                              {other.map((resource) => (
                                <ResourceDetails
                                  key={resource.id}
                                  resource={resource}
                                  observedAt={
                                    resourceSnapshots.get(scope.projectId)?.observedAt ?? 0
                                  }
                                />
                              ))}
                            </ul>
                          </details>
                        )}
                      </div>
                    </section>
                  )
                })}
            </div>
          </div>
          {[...resourceSnapshots].map(([id, { value, observedAt }]) => (
            <NotebookResourcePanel
              key={id}
              isActive={isActive}
              projectId={id}
              snapshot={value}
              observedAt={observedAt}
              backgroundRuns={[]}
              refresh={() => {
                unsettledProjects.current.add(id)
                refreshResources(id, true)
              }}
              goToSession={(sessionId) => openSession(id, sessionId)}
              desktop={{
                hidden: !allProjects && id !== projectId,
                sessionTitles,
                confirmation: confirmation?.projectId === id ? confirmation : undefined,
                closeConfirmation: () => setConfirmation(undefined),
                restoreConfirmationFocus: (event) => {
                  event.preventDefault()
                  if (!active.current) return
                  const trigger = sessionStopTrigger.current
                  const focusTarget =
                    trigger?.isConnected && !trigger.disabled ? trigger : allProjectsButton.current
                  focusTarget?.focus()
                }
              }}
            />
          ))}
          <footer className="space-y-2 py-1.5 text-xs text-muted-foreground">
            {snapshot && (!snapshot.processMetricsAvailable || host?.platform === 'win32') && (
              <p className="text-xs text-muted-foreground">
                {!snapshot.processMetricsAvailable
                  ? t('Process metrics are temporarily unavailable. Missing values are shown as —.')
                  : t('Per-process CPU usage is unavailable on Windows.')}
              </p>
            )}
            <div className="flex justify-end">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-xs text-muted-foreground">
                    <Info className="size-3.5" />
                    {t('About monitoring')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t(
                    'Process memory is estimated for each tree. Processes from previous app runs are not listed.'
                  )}
                </TooltipContent>
              </Tooltip>
            </div>
          </footer>
        </div>
      </ComputePanel>
    </TooltipProvider>
  )
}
