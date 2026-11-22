import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Clock3,
  Monitor,
  Info,
  RefreshCw,
  Square,
  LoaderCircle,
  MoreVertical,
  ArrowUpRight,
  Terminal,
  FileCode2,
  ChevronRight
} from 'lucide-react'
import type {
  NotebookProcessMonitorSnapshot,
  NotebookProcessObservation
} from '../../../../shared/notebook-process-monitor'
import { Button } from '@/components/ui/button'
import {
  ActionMenuProvider,
  ActionMenuTarget,
  useActionMenu,
  type ActionMenuDefinition,
  type ActionMenuRecipeEntry
} from '@/components/action-menu'
import { PythonIcon, RIcon } from '@/components/language-icons'
import { ErrorNotice } from '@/components/error-notice'
import { ComputePanel } from './ComputePanel'
import { formatComputeUptime, totalKernelUptime } from './compute-monitor-presentation'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ComputeCellPreview } from './ComputeCellPreview'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'

const SESSION_ACTIONS = {
  open: { labelKey: 'Open session', icon: ArrowUpRight },
  stop: { labelKey: 'Stop all', icon: Square, danger: true }
} satisfies Record<string, ActionMenuDefinition>
const SESSION_RECIPE = [
  { kind: 'action', action: 'open' },
  { kind: 'action', action: 'stop' }
] as const satisfies readonly ActionMenuRecipeEntry<keyof typeof SESSION_ACTIONS>[]

function SessionActions({
  identity,
  items,
  disabled,
  onOpen,
  onStop,
  focusReason
}: {
  identity: string
  items: NotebookProcessObservation[]
  disabled: boolean
  onOpen: () => void
  focusReason: () => void
  onStop: (items: NotebookProcessObservation[], trigger: HTMLButtonElement) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const menu = useActionMenu()
  const trigger = useRef<HTMLButtonElement>(null)
  const stopSelected = useRef(false)
  const targetId = `compute-session-${identity}`
  return (
    <ActionMenuTarget
      asChild
      targetId={targetId}
      identityKey={identity}
      invocation={items}
      catalog={SESSION_ACTIONS}
      recipe={SESSION_RECIPE}
      onRestoreFocus={(restoreDefault) => {
        if (stopSelected.current) {
          stopSelected.current = false
          focusReason()
        } else restoreDefault()
      }}
      bindings={{
        open: { execute: onOpen },
        stop: {
          disabled,
          execute: (selected) => {
            stopSelected.current = true
            if (trigger.current) onStop(selected, trigger.current)
          }
        }
      }}
    >
      <Button
        ref={trigger}
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground"
        aria-label={t('Session actions')}
        aria-haspopup="menu"
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          menu.openMenu({
            targetId,
            pointer: { x: bounds.right, y: bounds.bottom },
            align: 'end',
            focusTarget: event.currentTarget
          })
        }}
      >
        <MoreVertical className="size-4" />
      </Button>
    </ActionMenuTarget>
  )
}

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
  label
}: {
  values: (number | undefined)[]
  label: string
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
      className="mt-1 h-5 w-full text-primary"
      role="img"
      aria-label={label}
    >
      {segments.map((segment, index) => (
        <polyline
          key={index}
          points={segment.join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
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
  const formatDateTime = useDateTimeFormat()
  const [snapshot, setSnapshot] = useState<NotebookProcessMonitorSnapshot>()
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
  const [target, setTarget] = useState<NotebookProcessObservation[]>()
  const [comment, setComment] = useState('')
  const [targetScope, setTargetScope] = useState<'kernel' | 'session'>('kernel')
  const reasonInput = useRef<HTMLTextAreaElement>(null)
  const stopTrigger = useRef<HTMLButtonElement>(null)
  const [history, setHistory] = useState(
    new Map<string, { memory: (number | undefined)[]; cpu: (number | undefined)[] }>()
  )
  const lastSample = useRef(0)
  const selectTarget = (
    items: NotebookProcessObservation[],
    scope: 'kernel' | 'session',
    trigger: HTMLButtonElement
  ): void => {
    stopTrigger.current = trigger
    setTargetScope(scope)
    setComment('')
    setTarget(items)
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
    if (!isActive) return
    let disposed = false
    let polling = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      if (disposed || polling || document.hidden) return
      polling = true
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
  }, [isActive, refresh])

  const terminate = async (): Promise<void> => {
    if (!target) return
    setStopping(target[0].id)
    setActionError(false)
    try {
      await window.api.notebook.terminateMonitoredProcess({
        ...(target.length === 1
          ? { id: target[0].id }
          : {
              ids: target.map((item) => item.id),
              projectId: target[0].projectId,
              sessionId: target[0].sessionId
            }),
        projectId: target[0].projectId,
        sessionId: target[0].sessionId,
        ...(comment.trim() ? { comment: comment.trim() } : {})
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
  }
  const allInstances = snapshot?.instances ?? []
  const instances = allInstances.filter((item) => allProjects || item.projectId === projectId)
  const cpuDescription = (value: number | undefined): string =>
    value === undefined
      ? t('CPU usage')
      : t('{{percent}}% CPU · 100% = 1 core', {
          percent: value > 0 && value < 0.0001 ? '<0.01' : (value * 100).toFixed(2)
        })
  const groups = Map.groupBy(instances, (item) => JSON.stringify([item.projectId, item.sessionId]))
  const host = snapshot?.host
  const uptime = (seconds: number): string => formatComputeUptime(seconds, t)
  const status = (item: NotebookProcessObservation): string => {
    if (item.id === stopping || item.status === 'cleaning') return t('Cleaning up')
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

  const selectedMemory = target?.every((item) => item.memoryBytes !== undefined)
    ? megabytes(target.reduce((sum, item) => sum + item.memoryBytes!, 0))
    : undefined
  const terminationForm = target && (
    <form
      aria-label={
        targetScope === 'session' ? t('Stop all session kernels') : t('Stop this kernel?')
      }
      className="border-t border-border bg-muted/30 px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!stopping) void terminate()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !stopping) {
          event.preventDefault()
          cancelTermination()
        }
      }}
    >
      <p className="text-xs font-medium">
        {targetScope === 'session' ? t('Stop all session kernels') : t('Stop this kernel?')}
        <span className="ml-2 font-normal text-muted-foreground">
          {[...new Set(target.map(kind))].join(' · ')}
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
          {t('Your reason is shared with the agent in its next Notebook tool response.')}
        </p>
      </div>
    </form>
  )

  return (
    <ActionMenuProvider>
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
            onClick={() => void refresh(true)}
            disabled={refreshing}
            aria-label={t('Refresh')}
            title={t('Updates every 3 seconds')}
          >
            <RefreshCw className={refreshing ? 'size-4 animate-spin' : 'size-4'} />
          </Button>
        }
      >
        <div className="p-4">
          {error && (
            <ErrorNotice
              inline
              title={t('Could not refresh process monitoring')}
              description={t('The last successful sample is shown. Try refreshing again.')}
            />
          )}
          <details className="group/system mb-6" data-system-details>
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 rounded-md outline-none focus-visible:keyboard-focus [&::-webkit-details-marker]:hidden">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ChevronRight className="size-3 transition-transform motion-reduce:transition-none group-open/system:rotate-90" />
                {t('System details')}
              </span>
              <span className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
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
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
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
            <div className="flex flex-wrap items-start justify-between gap-3 pb-4">
              <div className="min-w-0">
                <h3 className="text-sm font-medium">{t('Kernels')}</h3>
                <p
                  className="mt-1 flex flex-wrap gap-x-2 text-xs tabular-nums text-muted-foreground"
                  data-testid="kernel-summary"
                >
                  <span>
                    {t('{{count}} kernels', {
                      count: instances.length,
                      defaultValue_one: '{{count}} kernel'
                    })}
                  </span>
                  <span>
                    ·{' '}
                    {t('{{count}} running', {
                      count: instances.filter((item) => item.status === 'running').length
                    })}
                  </span>
                  <span>
                    ·{' '}
                    {resourceTotal(
                      instances.map((item) => item.memoryBytes),
                      megabytes
                    )}
                  </span>
                  <span title={t('CPU usage')}>
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
                className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/50 p-0.5"
                role="group"
                aria-label={t('Notebook processes')}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-foreground aria-pressed:bg-card"
                  onClick={() => selectScope(true)}
                  aria-pressed={allProjects}
                >
                  {t('All kernels')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-foreground aria-pressed:bg-card"
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
            {instances.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                <p>
                  {allProjects
                    ? t('No tracked Notebook processes')
                    : t('No kernels in this project')}
                </p>
                {!allProjects && allInstances.length > 0 && (
                  <Button
                    variant="link"
                    size="sm"
                    className="mt-2"
                    onClick={() => selectScope(true)}
                  >
                    {t('View all kernels ({{total}})', { total: allInstances.length })}
                  </Button>
                )}
              </div>
            )}
            {instances.length > 0 && (
              <div className="grid grid-cols-[minmax(0,1fr)_5rem_4rem] gap-2 pr-8 pb-2 text-xs text-muted-foreground @xl/compute:grid-cols-[minmax(0,1fr)_6rem_5rem]">
                <span>{t('Session')}</span>
                <span className="text-right whitespace-nowrap">{t('Memory usage')}</span>
                <span className="text-right whitespace-nowrap">{t('CPU cores')}</span>
              </div>
            )}
            <div className="divide-y divide-border border-t border-border">
              {[...groups].map(([key, items]) => (
                <section key={key}>
                  <header className="flex items-center gap-2">
                    <button
                      type="button"
                      className="grid min-h-14 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_5rem_4rem] items-center gap-2 rounded-md py-3 text-left outline-none hover:bg-muted/40 focus-visible:keyboard-focus @xl/compute:grid-cols-[minmax(0,1fr)_6rem_5rem]"
                      title={sessionTitles.get(items[0].sessionId) || t('Untitled conversation')}
                      aria-expanded={expandedSessions.has(key)}
                      aria-controls={`${sessionContentId}-${encodeURIComponent(key)}`}
                      onClick={() => {
                        const isOpen = expandedSessions.has(key)
                        setExpandedSessions((previous) => {
                          const next = new Set(previous)
                          if (isOpen) next.delete(key)
                          else next.add(key)
                          return next
                        })
                        if (isOpen) {
                          const ids = new Set(items.map((item) => item.id))
                          setExpanded(
                            (previous) => new Set([...previous].filter((id) => !ids.has(id)))
                          )
                          if (targetScope === 'kernel' && target?.some((item) => ids.has(item.id)))
                            setTarget(undefined)
                        }
                      }}
                    >
                      <span className="flex min-w-0 items-start gap-2">
                        <ChevronRight
                          className={`mt-1 size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${expandedSessions.has(key) ? 'rotate-90' : ''}`}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {sessionTitles.get(items[0].sessionId) || t('Untitled conversation')}
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
                            <span className="whitespace-nowrap">
                              {t('{{count}} kernels', {
                                count: items.length,
                                defaultValue_one: '{{count}} kernel'
                              })}
                            </span>
                            <span
                              className="inline-flex items-center gap-1 whitespace-nowrap"
                              title={t('Sum of current kernel uptimes, including idle time.')}
                              aria-label={t('Total kernel uptime: {{duration}}', {
                                duration: uptime(totalKernelUptime(items, snapshot!.sampledAt))
                              })}
                            >
                              <Clock3 className="size-3" aria-hidden="true" />
                              <span data-session-uptime>
                                {uptime(totalKernelUptime(items, snapshot!.sampledAt))}
                              </span>
                            </span>
                            {items.some((item) => item.status === 'running') && (
                              <span>
                                {t('{{count}} running', {
                                  count: items.filter((item) => item.status === 'running').length
                                })}
                              </span>
                            )}
                            {items.some((item) => item.status === 'cleanup-failed') && (
                              <span className="text-status-failure-strong">
                                {t('Cleanup failed')}
                              </span>
                            )}
                            {items.some(
                              (item) => item.status === 'cleaning' || item.id === stopping
                            ) && <span>{t('Cleaning up')}</span>}
                          </span>
                        </span>
                      </span>
                      <span
                        className="text-right text-xs tabular-nums whitespace-nowrap"
                        title={t('Process memory')}
                      >
                        {resourceTotal(
                          items.map((item) => item.memoryBytes),
                          megabytes
                        )}
                      </span>
                      <span
                        className="text-right text-xs tabular-nums whitespace-nowrap"
                        title={t('CPU cores')}
                      >
                        {resourceTotal(
                          items.map((item) => item.cpuCores),
                          cores
                        )}
                      </span>
                    </button>
                    <SessionActions
                      identity={key}
                      items={items}
                      disabled={
                        Boolean(stopping) || items.some((item) => item.status === 'cleaning')
                      }
                      onOpen={() => openSession(items[0].projectId, items[0].sessionId)}
                      focusReason={() => reasonInput.current?.focus()}
                      onStop={(selected, trigger) => selectTarget(selected, 'session', trigger)}
                    />
                  </header>
                  {targetScope === 'session' &&
                    target?.[0].projectId === items[0].projectId &&
                    target[0].sessionId === items[0].sessionId &&
                    terminationForm}
                  <div
                    id={`${sessionContentId}-${encodeURIComponent(key)}`}
                    hidden={!expandedSessions.has(key)}
                  >
                    {expandedSessions.has(key) &&
                      items.map((item) => (
                        <div key={item.id} className="border-b border-border last:border-b-0">
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
                            <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_5rem_4rem_1.5rem] items-center gap-2 rounded-md py-3 hover:bg-muted/40 [&::-webkit-details-marker]:hidden @xl/compute:grid-cols-[minmax(0,1fr)_6rem_5rem_1.5rem]">
                              <div className="flex min-w-0 items-center gap-2 pl-3 @md/compute:pl-5">
                                <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-open/kernel:rotate-90" />
                                <span
                                  className="inline-flex size-5 shrink-0"
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
                                  <p className="truncate text-sm">{status(item)}</p>
                                  <p
                                    className="truncate text-xs text-muted-foreground"
                                    title={t('Uptime')}
                                  >
                                    {uptime(
                                      Math.max(0, snapshot!.sampledAt - item.startedAt) / 1000
                                    )}
                                    {item.environment && (
                                      <span className="hidden @lg/compute:inline">
                                        {' '}
                                        · {item.environment}
                                      </span>
                                    )}
                                  </p>
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
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                className="text-muted-foreground hover:text-destructive"
                                disabled={Boolean(stopping) || item.status === 'cleaning'}
                                aria-expanded={
                                  targetScope === 'kernel' && target?.[0].id === item.id
                                }
                                aria-label={
                                  item.status === 'cleanup-failed'
                                    ? t('Retry cleanup')
                                    : t('Terminate')
                                }
                                title={
                                  item.status === 'cleanup-failed'
                                    ? t('Retry cleanup')
                                    : t('Terminate')
                                }
                                onClick={(event) => {
                                  event.preventDefault()
                                  selectTarget([item], 'kernel', event.currentTarget)
                                }}
                              >
                                {stopping === item.id ? (
                                  <LoaderCircle className="size-3.5 animate-spin" />
                                ) : (
                                  <Square className="size-3.5" />
                                )}
                              </Button>
                            </summary>
                            {expanded.has(item.id) && (
                              <div className="border-t border-border bg-muted/30 px-4 py-3">
                                <div className="mb-4 grid grid-cols-2 gap-6 text-xs text-muted-foreground">
                                  <div>
                                    <p>{t('Memory usage')}</p>
                                    <Sparkline
                                      values={history.get(item.id)?.memory ?? []}
                                      label={t('Memory usage')}
                                    />
                                  </div>
                                  <div>
                                    <p>{t('CPU usage')}</p>
                                    <Sparkline
                                      values={history.get(item.id)?.cpu ?? []}
                                      label={t('CPU usage')}
                                    />
                                  </div>
                                </div>
                                {expanded.has(item.id) &&
                                  (item.lastCell ? (
                                    <ComputeCellPreview
                                      code={item.lastCell.code}
                                      kind={item.kind}
                                      truncated={item.lastCell.truncated}
                                    />
                                  ) : (
                                    <p className="mb-4 text-xs text-muted-foreground">
                                      {item.hasLastCell ? t('Loading…') : t('No cell executed yet')}
                                    </p>
                                  ))}
                                {item.processes.length > 0 && (
                                  <>
                                    <div className="mb-3 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                                      <span>
                                        {t('Process tree')} · {item.processes.length}
                                      </span>
                                      <span>
                                        {t('Started')} · {formatDateTime(item.startedAt)}
                                      </span>
                                    </div>
                                    <div className="overflow-x-auto">
                                      <table className="min-w-[26rem] w-full table-fixed text-left text-xs tabular-nums">
                                        <thead className="text-muted-foreground">
                                          <tr>
                                            <th className="w-20 pb-2 pr-3 font-medium">
                                              {t('Process ID')}
                                            </th>
                                            <th className="pb-2 font-medium">
                                              {t('Process tree')}
                                            </th>
                                            <th className="w-28 pb-2 text-right font-medium whitespace-nowrap">
                                              {t('Process memory')}
                                            </th>
                                            <th className="w-20 pb-2 text-right font-medium">
                                              {t('CPU cores')}
                                            </th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {item.processes.map((child) => (
                                            <tr key={child.pid}>
                                              <td className="py-1 font-mono">{child.pid}</td>
                                              <td className="truncate py-1 pr-3">
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
                          {targetScope === 'kernel' &&
                            target?.[0].id === item.id &&
                            terminationForm}
                        </div>
                      ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
          <footer className="space-y-2 pt-3 text-xs text-muted-foreground">
            {snapshot && (!snapshot.processMetricsAvailable || host?.platform === 'win32') && (
              <p className="text-xs text-muted-foreground">
                {!snapshot.processMetricsAvailable
                  ? t('Process metrics are temporarily unavailable. Missing values are shown as —.')
                  : t('Per-process CPU usage is unavailable on Windows.')}
              </p>
            )}
            <div className="flex justify-end">
              <TooltipProvider>
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
              </TooltipProvider>
            </div>
          </footer>
        </div>
      </ComputePanel>
    </ActionMenuProvider>
  )
}
