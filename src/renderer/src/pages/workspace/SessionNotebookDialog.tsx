import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, LoaderCircle, X } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ChatSession } from '@/stores/session-store'

import { resolveDataKernelForTab } from '../../../../shared/notebook'
import type {
  NotebookKernelKind,
  NotebookRunPage,
  NotebookRunHistorySummary,
  NotebookRunRecord
} from '../../../../shared/notebook'
import { NotebookCodeBlock } from './notebook-code'
import { NotebookRunOutputs } from './NotebookRunOutputs'
import { NotebookInputDataStrip } from './NotebookInputDataStrip'
import {
  isProblemRunStatus,
  kernelKindLabel,
  kernelOriginLabel,
  notebookRunStatusLabel,
  resolveRunErrorLine,
  resolveRunKernelKind
} from './notebook-cell-utils'
import { loadSessionNotebookData } from './session-notebook-data'
import {
  createNotebookFrameFilterOptions,
  notebookFrameFilterForExport,
  notebookFrameLabels,
  projectNotebookRunsForFrame,
  type NotebookFrameFilterValue
} from './session-notebook-projection'
import { followScrollBottomTop, prependAnchoredScrollTop } from './follow-notebook-scroll'

type SessionNotebookStatus = 'loading' | 'error' | 'ready'

// Fixed section order for the per-kernel grouping, mirroring NotebookPreview's tab order.
const KERNEL_KIND_ORDER: NotebookKernelKind[] = ['python', 'r', 'repl', 'bash']
const HISTORY_SUMMARY_CACHE_LIMIT = 20

// Turns an IPC rejection into displayable text without losing non-Error values.
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// One persisted run rendered as a notebook cell: header badges, code, and split stdout/stderr. The
// zero-based index is the cell number shown in [n], aligning the display with a notebook's cells.
const NotebookDialogCell = ({
  run,
  index,
  showInputData = false
}: {
  run: NotebookRunRecord
  index: number
  showInputData?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const isProblem = isProblemRunStatus(run.status)
  const statusLabel = notebookRunStatusLabel(run.status)
  const errorLine = isProblem ? resolveRunErrorLine(run) : undefined
  const kind = resolveRunKernelKind(run)
  const originLabel = kernelOriginLabel(kind)

  return (
    <div className="px-4 py-3" data-testid="session-notebook-cell">
      <div className="mb-2 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="font-mono text-text-300">[{index}]</span>
          <span className="rounded bg-bg-300 px-1.5 py-0.5 text-text-200">{kind}</span>
          {isProblem ? (
            errorLine ? (
              <span className="rounded bg-danger-000 px-1.5 py-0.5 font-medium text-white">
                {t('error (line {{line}})', { line: errorLine })}
              </span>
            ) : (
              <span className="rounded bg-danger-900 px-1.5 py-0.5 text-danger-000">
                {t('error')}
              </span>
            )
          ) : statusLabel ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
              {t(statusLabel)}
            </span>
          ) : null}
        </div>
        {originLabel ? (
          <span className="font-mono text-text-300" data-testid="session-notebook-cell-origin">
            {originLabel}
          </span>
        ) : null}
      </div>
      {showInputData ? (
        <NotebookInputDataStrip
          inputFiles={run.inputFiles ?? []}
          className="mb-2 rounded-md border border-border bg-muted px-2 py-1.5"
        />
      ) : null}
      <NotebookCodeBlock
        code={run.script}
        language={kind === 'repl' ? 'javascript' : kind}
        highlightLine={errorLine}
      />
      <NotebookRunOutputs run={run} />
    </div>
  )
}

type SessionNotebookContentProps = {
  sessionId: string
  projectId?: string
  runs: NotebookRunRecord[]
  runCount?: number
  loadedRunCount?: number
  status: SessionNotebookStatus
  error?: string
  historyPage?: NotebookRunPage
  loadingEarlier?: boolean
  earlierError?: string
  viewportRef?: RefObject<HTMLDivElement | null>
  topSentinelRef?: RefObject<HTMLDivElement | null>
  frameLabels?: Readonly<Record<string, string>>
  onLoadHistorySummary?: (agentFrameId: string) => Promise<NotebookRunHistorySummary | undefined>
  onLoadEarlier?: () => void
  onClose: () => void
  onExport: (kernel: NotebookKernelKind, agentFrameFilter?: string | null) => Promise<void>
  onExportAll: (agentFrameFilter?: string | null) => Promise<string | undefined>
}

// Pure presentational body of the dialog: header summary, empty/loading/error/populated states,
// and the .ipynb export footer. Kept free of data-loading hooks and Dialog context so it renders
// standalone in tests; close is delegated through onClose.
const SessionNotebookContent = ({
  sessionId,
  projectId,
  runs,
  runCount = runs.length,
  loadedRunCount = runs.length,
  status,
  error,
  historyPage,
  loadingEarlier = false,
  earlierError,
  viewportRef,
  topSentinelRef,
  frameLabels = {},
  onLoadHistorySummary,
  onLoadEarlier,
  onClose,
  onExport,
  onExportAll
}: SessionNotebookContentProps): React.JSX.Element => {
  const { t } = useTranslation()
  const { t: tCommon } = useTranslation()
  const [activeKind, setActiveKind] = useState<NotebookKernelKind>('python')
  const [exporting, setExporting] = useState(false)
  const [exportingAll, setExportingAll] = useState(false)
  const [exportError, setExportError] = useState<string>()
  const [exportSuccess, setExportSuccess] = useState<string>()
  const [frameFilter, setFrameFilter] = useState<NotebookFrameFilterValue>()
  const [historySummaries, setHistorySummaries] = useState<
    ReadonlyMap<string, NotebookRunHistorySummary>
  >(() => new Map())
  const historySummaryRequests = useRef(new Set<string>())
  const mounted = useRef(true)
  const shortId = sessionId.slice(0, 8)
  const frameOptions = createNotebookFrameFilterOptions(runs, frameLabels, historySummaries, true)
  const effectiveFrameFilter = frameOptions.some((option) => option.value === frameFilter)
    ? frameFilter
    : (frameOptions.find((option) => (option.count ?? 0) > 0)?.value ?? frameOptions[0]?.value)
  const effectiveAgentFrameId = effectiveFrameFilter?.slice('frame:'.length)
  const historySummary = effectiveAgentFrameId
    ? historySummaries.get(effectiveAgentFrameId)
    : undefined
  const projectedRuns = effectiveFrameFilter
    ? projectNotebookRunsForFrame(runs, effectiveFrameFilter)
    : []
  const agents = frameOptions.filter((option) => (option.count ?? 0) > 0).length

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (
      status !== 'ready' ||
      !effectiveAgentFrameId ||
      !onLoadHistorySummary ||
      historySummaries.has(effectiveAgentFrameId) ||
      historySummaryRequests.current.has(effectiveAgentFrameId)
    ) {
      return
    }

    historySummaryRequests.current.add(effectiveAgentFrameId)
    void onLoadHistorySummary(effectiveAgentFrameId)
      .then((summary) => {
        if (!mounted.current || !summary || summary.agentFrameId !== effectiveAgentFrameId) return
        setHistorySummaries((current) => {
          const next = new Map(current)
          next.delete(effectiveAgentFrameId)
          next.set(effectiveAgentFrameId, summary)
          if (next.size > HISTORY_SUMMARY_CACHE_LIMIT) {
            const oldest = next.keys().next().value
            if (oldest !== undefined) next.delete(oldest)
          }
          return next
        })
      })
      .catch((summaryError: unknown) => {
        console.error('Failed to load notebook history summary:', summaryError)
      })
      .finally(() => {
        historySummaryRequests.current.delete(effectiveAgentFrameId)
      })
  }, [effectiveAgentFrameId, historySummaries, onLoadHistorySummary, status])
  // Only python/r runs are "cells" in the notebook sense; repl/bash are control-plane/shell runs
  // that share the run history but never became a notebook cell.
  const cells = runs.filter((run) => {
    const kind = resolveRunKernelKind(run)
    return kind === 'python' || kind === 'r'
  }).length
  const replCount = runs.filter((run) => resolveRunKernelKind(run) === 'repl').length
  const bashCount = runs.filter((run) => resolveRunKernelKind(run) === 'bash').length
  const extraCounts = [
    replCount > 0 ? t('{{count}} repl', { count: replCount }) : null,
    bashCount > 0 ? t('{{count}} shell', { count: bashCount }) : null
  ].filter((part): part is string => part !== null)

  // Per-kernel tabs, in fixed order, keeping only kinds that actually have a run — same has-runs
  // filtering as NotebookPreview, switchable rather than stacked so the dialog matches the preview.
  const kindsWithRuns = new Set(projectedRuns.map((run) => resolveRunKernelKind(run)))
  if (historySummary) {
    for (const kind of KERNEL_KIND_ORDER) {
      if (historySummary.kernelCounts[kind] > 0) kindsWithRuns.add(kind)
    }
  }
  const visibleKinds = KERNEL_KIND_ORDER.filter((kind) => kindsWithRuns.has(kind))
  const effectiveActiveKind = visibleKinds.includes(activeKind)
    ? activeKind
    : (KERNEL_KIND_ORDER.find((kind) => kindsWithRuns.has(kind)) ?? visibleKinds[0] ?? 'python')
  const visibleRuns = projectedRuns.filter(
    (run) => resolveRunKernelKind(run) === effectiveActiveKind
  )
  const busy = exporting || exportingAll
  const supportsAutomaticHistoryLoading = typeof IntersectionObserver !== 'undefined'

  useEffect(() => {
    const viewport = viewportRef?.current
    const sentinel = topSentinelRef?.current
    if (
      status !== 'ready' ||
      !viewport ||
      !sentinel ||
      !historyPage?.hasEarlierRuns ||
      loadingEarlier ||
      earlierError ||
      !onLoadEarlier ||
      !supportsAutomaticHistoryLoading
    ) {
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadEarlier()
      },
      { root: viewport, rootMargin: '400px 0px 0px 0px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [
    earlierError,
    historyPage?.hasEarlierRuns,
    loadingEarlier,
    onLoadEarlier,
    status,
    supportsAutomaticHistoryLoading,
    topSentinelRef,
    viewportRef
  ])

  // The main button's "current tab" = the kernel whose .ipynb will be saved. repl/bash tabs fold
  // into the most recent data kernel so the file still has a real kernelspec; sessions that never
  // ran a data cell have no .ipynb to download and we hide the button via exportDisabled below.
  const dataKernelsWithRuns = ['python', 'r'].filter((kernel) =>
    kindsWithRuns.has(kernel as NotebookKernelKind)
  )
  const mixedDataKernels = dataKernelsWithRuns.length >= 2
  const resolvedDataKernel =
    effectiveActiveKind === 'repl' || effectiveActiveKind === 'bash'
      ? (historySummary?.latestDataKernel ??
        resolveDataKernelForTab(projectedRuns, effectiveActiveKind))
      : resolveDataKernelForTab(projectedRuns, effectiveActiveKind)
  const exportDisabled =
    status !== 'ready' || !effectiveFrameFilter || dataKernelsWithRuns.length === 0 || busy

  const handleExport = async (): Promise<void> => {
    if (!effectiveFrameFilter) return
    setExporting(true)
    setExportError(undefined)
    setExportSuccess(undefined)
    try {
      await onExport(effectiveActiveKind, notebookFrameFilterForExport(effectiveFrameFilter))
    } catch (exportFailure) {
      // A canceled Save As resolves rather than throws, so reaching here is a real failure —
      // keep a diagnostic trail in addition to the footer banner.
      console.error('Failed to export notebook as .ipynb:', exportFailure)
      setExportError(getErrorMessage(exportFailure))
    } finally {
      setExporting(false)
    }
  }

  const handleExportAll = async (): Promise<void> => {
    if (!effectiveFrameFilter) return
    setExportingAll(true)
    setExportError(undefined)
    setExportSuccess(undefined)
    try {
      const message = await onExportAll(notebookFrameFilterForExport(effectiveFrameFilter))
      if (message) setExportSuccess(message)
    } catch (exportFailure) {
      console.error('Failed to export notebooks by kernel:', exportFailure)
      setExportError(getErrorMessage(exportFailure))
    } finally {
      setExportingAll(false)
    }
  }

  // The "Download all" path is only useful when there's more than one data kernel to write; a
  // single-kernel session's secondary button would just duplicate the main button. The data-kernel
  // count comes from `kindsWithRuns` (control-plane kinds don't generate their own .ipynb).
  const exportAllCount = dataKernelsWithRuns.length

  return (
    <>
      <div className="flex shrink-0 items-center justify-between border-b border-border-300/90 px-5 py-3.5">
        <h2 className="flex min-w-0 items-center gap-3 text-lg font-semibold text-foreground">
          <span>{t('Session notebook')}</span>
          <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs font-normal text-muted-foreground">
            {shortId}
          </span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {t('{{count}} agents', { defaultValue_one: '{{count}} agent', count: agents })} ·{' '}
            {t('{{count}} cells', { defaultValue_one: '{{count}} cell', count: cells })}
            {extraCounts.length > 0 ? ` · ${extraCounts.join(' / ')}` : ''}
          </span>
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="-m-1 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={tCommon('Close')}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        aria-busy={status === 'loading' || loadingEarlier}
        data-testid="session-notebook-scroll-viewport"
      >
        {status === 'loading' ? (
          <p className="px-5 py-16 text-center text-sm text-muted-foreground">
            {t('Loading notebook…')}
          </p>
        ) : status === 'error' ? (
          <p className="px-5 py-16 text-center text-sm text-danger-000">
            {error ?? t('Failed to load notebook.')}
          </p>
        ) : runCount === 0 ? (
          <p className="px-5 py-16 text-center text-sm text-muted-foreground">
            {t('No execution records for this session.')}
          </p>
        ) : frameOptions.length === 0 ? (
          <p className="px-5 py-16 text-center text-sm text-muted-foreground">
            {t('No Main Agent or Subagent execution records for this session.')}
          </p>
        ) : (
          <>
            <div ref={topSentinelRef} className="h-px [overflow-anchor:none]" aria-hidden="true" />
            {loadingEarlier ? (
              <div
                className="border-b border-border bg-muted px-4 py-2 text-center text-xs text-muted-foreground"
                role="status"
              >
                {t('Loading earlier runs…')}
              </div>
            ) : earlierError ? (
              <div
                className="flex items-center justify-between gap-3 border-b border-border bg-muted px-4 py-2 text-xs text-danger-000"
                role="alert"
              >
                <span>{t('Failed to load earlier runs.')}</span>
                <button
                  type="button"
                  className="h-8 shrink-0 rounded-md px-2.5 text-xs text-foreground hover:bg-bg-200 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:translate-y-px"
                  onClick={onLoadEarlier}
                >
                  {t('Retry')}
                </button>
              </div>
            ) : historyPage?.hasEarlierRuns && !supportsAutomaticHistoryLoading ? (
              <button
                type="button"
                className="flex h-9 w-full items-center justify-center border-b border-border bg-muted px-4 text-xs text-foreground hover:bg-bg-200 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 active:translate-y-px"
                onClick={onLoadEarlier}
              >
                {t('Load earlier runs')}
              </button>
            ) : historyPage && !historyPage.hasEarlierRuns ? (
              <div className="border-b border-border px-4 py-2 text-center text-xs text-muted-foreground">
                {t('Beginning of notebook history')}
              </div>
            ) : null}
            {runCount > loadedRunCount ? (
              <p
                className="border-b border-border bg-muted px-4 py-2 text-xs text-muted-foreground"
                role="status"
              >
                {t('Loaded {{loaded}} of {{total}} runs. Scroll up to load earlier history.', {
                  loaded: loadedRunCount,
                  total: runCount
                })}
              </p>
            ) : null}
            <div className="flex max-w-full items-center gap-2 overflow-hidden border-b border-border bg-muted px-3 py-2">
              <label
                htmlFor={`notebook-frame-filter-${sessionId}`}
                className="shrink-0 text-xs text-muted-foreground"
              >
                {t('Agent')}
              </label>
              <Select
                value={effectiveFrameFilter ?? ''}
                onValueChange={(value) => {
                  setFrameFilter(value as NotebookFrameFilterValue)
                  setExportSuccess(undefined)
                }}
              >
                <SelectTrigger
                  id={`notebook-frame-filter-${sessionId}`}
                  aria-label={t('Filter notebook runs by Agent')}
                  title={frameOptions.find(({ value }) => value === effectiveFrameFilter)?.label}
                  className="min-w-0 max-w-full flex-1 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {frameOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                      {option.count !== undefined
                        ? ` · ${t('{{count}} runs', {
                            defaultValue_one: '{{count}} run',
                            count: option.count
                          })}`
                        : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div
              role="tablist"
              data-testid="session-kernel-switcher"
              className="flex shrink-0 items-center gap-1 border-y border-border bg-muted px-3 py-1.5"
            >
              {visibleKinds.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  aria-selected={effectiveActiveKind === kind}
                  data-testid={`session-notebook-tab-${kind}`}
                  onClick={() => {
                    setActiveKind(kind)
                    setExportSuccess(undefined)
                  }}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    effectiveActiveKind === kind
                      ? 'bg-card text-foreground'
                      : 'text-muted-foreground hover:bg-card/70 hover:text-foreground'
                  )}
                >
                  <span>{kernelKindLabel(kind)}</span>
                  <span className="font-mono text-muted-foreground">
                    {historySummary?.kernelCounts[kind] ??
                      projectedRuns.filter((run) => resolveRunKernelKind(run) === kind).length}
                  </span>
                </button>
              ))}
            </div>
            <div
              className="divide-y divide-border-100"
              data-testid={`session-notebook-kernel-${effectiveActiveKind}`}
            >
              {visibleRuns.length === 0 && kindsWithRuns.has(effectiveActiveKind) ? (
                <p className="px-5 py-16 text-center text-sm text-muted-foreground">
                  {t(
                    'No runs from this kernel are in the recent window. Downloads include the complete history.'
                  )}
                </p>
              ) : (
                visibleRuns.map((run, index) => (
                  <div key={run.runId} data-notebook-run-id={run.runId}>
                    <NotebookDialogCell
                      run={run}
                      index={index}
                      showInputData={Boolean(projectId)}
                    />
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border-300/90 px-5 py-3.5">
        <p
          className={cn(
            'min-w-0 truncate text-xs',
            exportError ? 'text-danger-000' : 'text-emerald-600 dark:text-emerald-400'
          )}
          role={exportError ? 'alert' : 'status'}
        >
          {exportError ?? exportSuccess}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {/* Secondary action: only when there's more than one data kernel to write, otherwise
              it would just duplicate the main button. The "Download all (N)" label surfaces the
              count so the user knows how many files they're about to create. */}
          {mixedDataKernels ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <button
                      type="button"
                      disabled={exportDisabled}
                      onClick={() => void handleExportAll()}
                      data-testid="session-notebook-export-all"
                      className="flex items-center justify-center gap-1.5 rounded px-2 py-1 text-xs text-text-200 hover:bg-bg-200 hover:text-text-000 disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={t('Download separate notebooks by kernel ({{count}})', {
                        count: exportAllCount
                      })}
                    >
                      {exportingAll ? (
                        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Download className="size-3.5" aria-hidden="true" />
                      )}
                      {exportingAll
                        ? t('Exporting…')
                        : t('All ({{count}})', { count: exportAllCount })}
                    </button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {t('Save one .ipynb per data kernel ({{count}} files) to a chosen directory.', {
                    count: exportAllCount
                  })}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Wrapper span keeps the tooltip reachable while the button is disabled. */}
                <span>
                  <button
                    type="button"
                    disabled={exportDisabled || resolvedDataKernel === undefined}
                    onClick={() => void handleExport()}
                    data-testid="session-notebook-export"
                    className="flex items-center justify-center gap-1.5 rounded px-2 py-1 text-xs text-text-200 hover:bg-bg-200 hover:text-text-000 disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={
                      resolvedDataKernel
                        ? t('Download {{kernel}} as .ipynb', { kernel: resolvedDataKernel })
                        : t('Download as .ipynb')
                    }
                  >
                    {exporting ? (
                      <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Download className="size-3.5" aria-hidden="true" />
                    )}
                    {exporting ? t('Exporting…') : t('.ipynb')}
                  </button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {resolvedDataKernel
                  ? `${t('Download {{kernel}} cells as .ipynb', {
                      kernel: kernelKindLabel(resolvedDataKernel)
                    })}${
                      effectiveActiveKind !== resolvedDataKernel
                        ? t(' (control tab falls back to most recent data kernel)')
                        : ''
                    }`
                  : t('Run a Python or R cell first to enable .ipynb export.')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </>
  )
}

type SessionNotebookDialogProps = {
  session: ChatSession | undefined
  onClose: () => void
}

// Modal container: owns the read-only load lifecycle and wraps the pure content in a Radix dialog.
const SessionNotebookDialog = ({
  session,
  onClose
}: SessionNotebookDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [runs, setRuns] = useState<NotebookRunRecord[]>([])
  const [runCount, setRunCount] = useState(0)
  const [historyPage, setHistoryPage] = useState<NotebookRunPage>()
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [earlierError, setEarlierError] = useState<string>()
  const [status, setStatus] = useState<SessionNotebookStatus>('loading')
  const [error, setError] = useState<string | undefined>(undefined)
  const dialogSession = useRetainedDialogValue(session)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const topSentinelRef = useRef<HTMLDivElement | null>(null)
  const initialBottomPending = useRef(true)
  const prependScrollSnapshot = useRef<{ scrollHeight: number; scrollTop: number } | undefined>(
    undefined
  )

  const sessionId = session?.id
  const projectId = session?.projectId
  const cwd = session?.cwd
  const activeSessionRef = useRef<{ id: string | undefined; generation: number }>({
    id: sessionId,
    generation: 0
  })
  useLayoutEffect(() => {
    if (activeSessionRef.current.id === sessionId) return
    activeSessionRef.current = {
      id: sessionId,
      generation: activeSessionRef.current.generation + 1
    }
  }, [sessionId])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || status !== 'ready') return
    const snapshot = prependScrollSnapshot.current
    if (snapshot) {
      prependScrollSnapshot.current = undefined
      viewport.scrollTop = prependAnchoredScrollTop(snapshot, viewport.scrollHeight)
      return
    }
    if (initialBottomPending.current) {
      initialBottomPending.current = false
      viewport.scrollTop = followScrollBottomTop(viewport)
    }
  }, [runs, status])

  const loadEarlier = useCallback((): void => {
    if (
      !dialogSession ||
      loadingEarlier ||
      !historyPage?.hasEarlierRuns ||
      !historyPage.oldestCursor
    )
      return
    const request = {
      sessionId: dialogSession.id,
      projectId: dialogSession.projectId,
      workspaceCwd: dialogSession.cwd ?? ''
    }
    const requestGeneration = activeSessionRef.current.generation
    const requestIsCurrent = (): boolean =>
      activeSessionRef.current.id === request.sessionId &&
      activeSessionRef.current.generation === requestGeneration
    const viewport = viewportRef.current
    if (viewport) {
      prependScrollSnapshot.current = {
        scrollHeight: viewport.scrollHeight,
        scrollTop: viewport.scrollTop
      }
    }
    setLoadingEarlier(true)
    setEarlierError(undefined)
    void loadSessionNotebookData(window.api.notebook, request, historyPage.oldestCursor)
      .then((loaded) => {
        if (!requestIsCurrent()) return
        const existingIds = new Set(runs.map((run) => run.runId))
        const earlierRuns = loaded.runs.filter((run) => !existingIds.has(run.runId))
        setRuns([...earlierRuns, ...runs])
        setHistoryPage(loaded.historyPage)
      })
      .catch((loadError: unknown) => {
        if (!requestIsCurrent()) return
        prependScrollSnapshot.current = undefined
        setEarlierError(getErrorMessage(loadError))
      })
      .finally(() => {
        if (requestIsCurrent()) setLoadingEarlier(false)
      })
  }, [dialogSession, historyPage, loadingEarlier, runs])

  const loadHistorySummary = useCallback(
    async (agentFrameId: string): Promise<NotebookRunHistorySummary | undefined> => {
      if (!dialogSession) return undefined
      const state = await window.api.notebook.state({
        sessionId: dialogSession.id,
        projectId: dialogSession.projectId,
        workspaceCwd: dialogSession.cwd ?? '',
        historySummaryFrameId: agentFrameId
      })
      return state.historySummary
    },
    [dialogSession]
  )

  useEffect(() => {
    if (!sessionId) return

    let cancelled = false

    // Defer state writes out of the synchronous effect body, then load runs read-only.
    const timeoutId = window.setTimeout(() => {
      setStatus('loading')
      setError(undefined)
      setRuns([])
      setRunCount(0)
      setHistoryPage(undefined)
      setEarlierError(undefined)
      setLoadingEarlier(false)
      initialBottomPending.current = true
      prependScrollSnapshot.current = undefined

      void loadSessionNotebookData(window.api.notebook, {
        sessionId,
        projectId,
        workspaceCwd: cwd ?? ''
      })
        .then((loaded) => {
          if (cancelled) return

          setRuns(loaded.runs)
          setRunCount(loaded.runCount)
          setHistoryPage(loaded.historyPage)
          setStatus('ready')
        })
        .catch((loadError: unknown) => {
          if (cancelled) return

          setError(getErrorMessage(loadError))
          setStatus('error')
        })
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [cwd, projectId, sessionId])

  return (
    <Dialog.Root
      open={Boolean(session)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          aria-describedby={undefined}
          onInteractOutside={(event) => event.preventDefault()}
          className={dialogPanelClassName(
            'flex max-h-[85vh] w-[calc(100%-2rem)] max-w-5xl flex-col overflow-hidden p-0'
          )}
        >
          <Dialog.Title className="sr-only">{t('Session notebook')}</Dialog.Title>
          {dialogSession ? (
            <SessionNotebookContent
              // Remount per session: the dialog is mounted once and the session prop swaps in
              // place, so per-session export state (a failure banner, an in-flight setState from
              // a superseded export) must be discarded rather than leak into the next session.
              key={dialogSession.id}
              sessionId={dialogSession.id}
              projectId={dialogSession.projectId}
              runs={runs}
              runCount={runCount}
              loadedRunCount={runs.length}
              historyPage={historyPage}
              loadingEarlier={loadingEarlier}
              earlierError={earlierError}
              viewportRef={viewportRef}
              topSentinelRef={topSentinelRef}
              frameLabels={notebookFrameLabels(dialogSession, t)}
              onLoadHistorySummary={loadHistorySummary}
              onLoadEarlier={loadEarlier}
              status={status}
              error={error}
              onClose={onClose}
              onExport={async (kernel, agentFrameFilter) => {
                await window.api.notebook.exportIpynb({
                  sessionId: dialogSession.id,
                  projectId: dialogSession.projectId,
                  workspaceCwd: dialogSession.cwd ?? '',
                  kernel,
                  ...(agentFrameFilter !== undefined ? { agentFrameFilter } : {})
                })
              }}
              onExportAll={async (agentFrameFilter) => {
                const result = await window.api.notebook.exportIpynbAll({
                  sessionId: dialogSession.id,
                  projectId: dialogSession.projectId,
                  workspaceCwd: dialogSession.cwd ?? '',
                  ...(agentFrameFilter !== undefined ? { agentFrameFilter } : {})
                })
                if (result.saved) {
                  return t('Saved {{count}} notebooks to {{directory}}', {
                    count: result.files.length,
                    directory: result.directory
                  })
                }
                return undefined
              }}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { NotebookDialogCell, SessionNotebookContent, SessionNotebookDialog }
