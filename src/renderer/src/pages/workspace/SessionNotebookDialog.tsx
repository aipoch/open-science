import { useEffect, useState } from 'react'
import { Download, LoaderCircle, X } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ChatSession } from '@/stores/session-store'

import { resolveDataKernelForTab } from '../../../../shared/notebook'
import type { NotebookKernelKind, NotebookRunRecord } from '../../../../shared/notebook'
import { NotebookCodeBlock } from './notebook-code'
import { NotebookRunOutputs } from './NotebookRunOutputs'
import {
  isProblemRunStatus,
  kernelKindLabel,
  kernelOriginLabel,
  resolveRunErrorLine,
  resolveRunKernelKind
} from './notebook-cell-utils'
import { loadSessionNotebookRuns } from './session-notebook-data'

type SessionNotebookStatus = 'loading' | 'error' | 'ready'

// Fixed section order for the per-kernel grouping, mirroring NotebookPreview's tab order.
const KERNEL_KIND_ORDER: NotebookKernelKind[] = ['python', 'r', 'repl', 'bash']

// Turns an IPC rejection into displayable text without losing non-Error values.
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// Renders "N word" with correct singular/plural for the summary counts.
const pluralize = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`

// One persisted run rendered as a notebook cell: header badges, code, and split stdout/stderr. The
// zero-based index is the cell number shown in [n], aligning the display with a notebook's cells.
const NotebookDialogCell = ({
  run,
  index
}: {
  run: NotebookRunRecord
  index: number
}): React.JSX.Element => {
  const isProblem = isProblemRunStatus(run.status)
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
                error (line {errorLine})
              </span>
            ) : (
              <span className="rounded bg-danger-900 px-1.5 py-0.5 text-danger-000">error</span>
            )
          ) : null}
        </div>
        {originLabel ? (
          <span className="font-mono text-text-300" data-testid="session-notebook-cell-origin">
            {originLabel}
          </span>
        ) : null}
      </div>
      <NotebookCodeBlock code={run.script} highlightLine={errorLine} />
      <NotebookRunOutputs run={run} />
    </div>
  )
}

type SessionNotebookContentProps = {
  sessionId: string
  runs: NotebookRunRecord[]
  status: SessionNotebookStatus
  error?: string
  onClose: () => void
  onExport: (kernel: NotebookKernelKind) => Promise<void>
  onExportAll: () => Promise<string | undefined>
}

// Pure presentational body of the dialog: header summary, empty/loading/error/populated states,
// and the .ipynb export footer. Kept free of data-loading hooks and Dialog context so it renders
// standalone in tests; close is delegated through onClose.
const SessionNotebookContent = ({
  sessionId,
  runs,
  status,
  error,
  onClose,
  onExport,
  onExportAll
}: SessionNotebookContentProps): React.JSX.Element => {
  const [activeKind, setActiveKind] = useState<NotebookKernelKind>('python')
  const [exporting, setExporting] = useState(false)
  const [exportingAll, setExportingAll] = useState(false)
  const [exportError, setExportError] = useState<string>()
  const [exportSuccess, setExportSuccess] = useState<string>()
  const shortId = sessionId.slice(0, 8)
  const agents = runs.some((run) => run.source === 'agent') ? 1 : 0
  // Only python/r runs are "cells" in the notebook sense; repl/bash are control-plane/shell runs
  // that share the run history but never became a notebook cell.
  const cells = runs.filter((run) => {
    const kind = resolveRunKernelKind(run)
    return kind === 'python' || kind === 'r'
  }).length
  const replCount = runs.filter((run) => resolveRunKernelKind(run) === 'repl').length
  const bashCount = runs.filter((run) => resolveRunKernelKind(run) === 'bash').length
  const extraCounts = [
    replCount > 0 ? `${replCount} repl` : null,
    bashCount > 0 ? `${bashCount} shell` : null
  ].filter((part): part is string => part !== null)

  // Per-kernel tabs, in fixed order, keeping only kinds that actually have a run — same has-runs
  // filtering as NotebookPreview, switchable rather than stacked so the dialog matches the preview.
  const kindsWithRuns = new Set(runs.map((run) => resolveRunKernelKind(run)))
  const visibleKinds = KERNEL_KIND_ORDER.filter((kind) => kindsWithRuns.has(kind))
  const effectiveActiveKind = visibleKinds.includes(activeKind)
    ? activeKind
    : (KERNEL_KIND_ORDER.find((kind) => kindsWithRuns.has(kind)) ?? visibleKinds[0] ?? 'python')
  const visibleRuns = runs.filter((run) => resolveRunKernelKind(run) === effectiveActiveKind)
  const busy = exporting || exportingAll
  const exportDisabled = status !== 'ready' || runs.length === 0 || busy

  // The main button's "current tab" = the kernel whose .ipynb will be saved. repl/bash tabs fold
  // into the most recent data kernel so the file still has a real kernelspec; sessions that never
  // ran a data cell have no .ipynb to download and we hide the button via exportDisabled below.
  const dataKernelsWithRuns = ['python', 'r'].filter((kernel) =>
    kindsWithRuns.has(kernel as NotebookKernelKind)
  )
  const mixedDataKernels = dataKernelsWithRuns.length >= 2
  const resolvedDataKernel = resolveDataKernelForTab(runs, effectiveActiveKind)

  const handleExport = async (): Promise<void> => {
    setExporting(true)
    setExportError(undefined)
    setExportSuccess(undefined)
    try {
      await onExport(effectiveActiveKind)
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
    setExportingAll(true)
    setExportError(undefined)
    setExportSuccess(undefined)
    try {
      const message = await onExportAll()
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
      <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
        <h2 className="flex min-w-0 items-center gap-3 text-lg font-semibold text-foreground">
          <span>Session notebook</span>
          <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs font-normal text-muted-foreground">
            {shortId}
          </span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {pluralize(agents, 'agent')} · {pluralize(cells, 'cell')}
            {extraCounts.length > 0 ? ` · ${extraCounts.join(' / ')}` : ''}
          </span>
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="-m-1 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {status === 'loading' ? (
          <p className="px-5 py-16 text-center text-sm text-muted-foreground">Loading notebook…</p>
        ) : status === 'error' ? (
          <p className="px-5 py-16 text-center text-sm text-danger-000">
            {error ?? 'Failed to load notebook.'}
          </p>
        ) : runs.length === 0 ? (
          <p className="px-5 py-16 text-center text-sm text-muted-foreground">
            No execution records for this session.
          </p>
        ) : (
          <>
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
                    'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
                    effectiveActiveKind === kind
                      ? 'bg-card text-foreground'
                      : 'text-muted-foreground hover:bg-card/70 hover:text-foreground'
                  )}
                >
                  <span>{kernelKindLabel(kind)}</span>
                  <span className="font-mono text-muted-foreground">
                    {runs.filter((run) => resolveRunKernelKind(run) === kind).length}
                  </span>
                </button>
              ))}
            </div>
            <div
              className="divide-y divide-border-100"
              data-testid={`session-notebook-kernel-${effectiveActiveKind}`}
            >
              {visibleRuns.map((run, index) => (
                <NotebookDialogCell key={run.runId} run={run} index={index} />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border-300/15 px-5 py-3.5">
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
                      aria-label={`Download separate notebooks by kernel (${exportAllCount})`}
                    >
                      {exportingAll ? (
                        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Download className="size-3.5" aria-hidden="true" />
                      )}
                      {exportingAll ? 'Exporting…' : `All (${exportAllCount})`}
                    </button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Save one .ipynb per data kernel ({exportAllCount} files) to a chosen directory.
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
                        ? `Download ${resolvedDataKernel} as .ipynb`
                        : 'Download as .ipynb'
                    }
                  >
                    {exporting ? (
                      <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Download className="size-3.5" aria-hidden="true" />
                    )}
                    {exporting ? 'Exporting…' : '.ipynb'}
                  </button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {resolvedDataKernel
                  ? `Download ${kernelKindLabel(resolvedDataKernel)} cells as .ipynb${
                      effectiveActiveKind !== resolvedDataKernel
                        ? ' (control tab falls back to most recent data kernel)'
                        : ''
                    }`
                  : 'Run a Python or R cell first to enable .ipynb export.'}
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
  const [runs, setRuns] = useState<NotebookRunRecord[]>([])
  const [status, setStatus] = useState<SessionNotebookStatus>('loading')
  const [error, setError] = useState<string | undefined>(undefined)
  const dialogSession = useRetainedDialogValue(session)

  const sessionId = session?.id
  const projectId = session?.projectId
  const cwd = session?.cwd

  useEffect(() => {
    if (!sessionId) return

    let cancelled = false

    // Defer state writes out of the synchronous effect body, then load runs read-only.
    const timeoutId = window.setTimeout(() => {
      setStatus('loading')
      setError(undefined)
      setRuns([])

      void loadSessionNotebookRuns(window.api.notebook, {
        sessionId,
        projectName: projectId,
        workspaceCwd: cwd ?? ''
      })
        .then((loadedRuns) => {
          if (cancelled) return

          setRuns(loadedRuns)
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
  }, [sessionId, projectId, cwd])

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
          <Dialog.Title className="sr-only">Session notebook</Dialog.Title>
          {dialogSession ? (
            <SessionNotebookContent
              // Remount per session: the dialog is mounted once and the session prop swaps in
              // place, so per-session export state (a failure banner, an in-flight setState from
              // a superseded export) must be discarded rather than leak into the next session.
              key={dialogSession.id}
              sessionId={dialogSession.id}
              runs={runs}
              status={status}
              error={error}
              onClose={onClose}
              onExport={async (kernel) => {
                await window.api.notebook.exportIpynb({
                  sessionId: dialogSession.id,
                  projectName: dialogSession.projectId,
                  workspaceCwd: dialogSession.cwd ?? '',
                  kernel
                })
              }}
              onExportAll={async () => {
                const result = await window.api.notebook.exportIpynbAll({
                  sessionId: dialogSession.id,
                  projectName: dialogSession.projectId,
                  workspaceCwd: dialogSession.cwd ?? ''
                })
                if (result.saved) {
                  return `Saved ${result.files.length} notebooks to ${result.directory}`
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

export { SessionNotebookContent, SessionNotebookDialog }
