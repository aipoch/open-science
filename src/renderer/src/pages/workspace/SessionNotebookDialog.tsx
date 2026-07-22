import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ChatSession } from '@/stores/session-store'

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

// Export lifecycle for the .ipynb footer button; 'error' surfaces inline until the next attempt.
type IpynbExportStatus = 'idle' | 'saving' | 'error'

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
  // Wired by the container; the button stays disabled when no handler or no runs are available.
  onExportIpynb?: () => void
  ipynbExportStatus?: IpynbExportStatus
}

// Pure presentational body of the dialog: header summary, empty/loading/error/populated states,
// and the .ipynb export footer. Kept free of data-loading hooks and Dialog context so it renders
// standalone in tests; close and export are delegated through props.
const SessionNotebookContent = ({
  sessionId,
  runs,
  status,
  error,
  onClose,
  onExportIpynb,
  ipynbExportStatus = 'idle'
}: SessionNotebookContentProps): React.JSX.Element => {
  const [activeKind, setActiveKind] = useState<NotebookKernelKind>('python')
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

  return (
    <>
      <div className="flex shrink-0 items-center justify-between border-b border-border-300/15 px-5 py-3.5">
        <h2 className="flex min-w-0 items-center gap-3 text-lg font-semibold text-text-000">
          <span>Session notebook</span>
          <span className="rounded bg-bg-200 px-2 py-0.5 font-mono text-xs font-normal text-text-200">
            {shortId}
          </span>
          <span className="truncate text-xs font-normal text-text-300">
            {pluralize(agents, 'agent')} · {pluralize(cells, 'cell')}
            {extraCounts.length > 0 ? ` · ${extraCounts.join(' / ')}` : ''}
          </span>
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="-m-1 rounded p-1 text-text-300 hover:text-text-000"
          aria-label="Close"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {status === 'loading' ? (
          <p className="px-5 py-16 text-center text-sm text-text-300">Loading notebook…</p>
        ) : status === 'error' ? (
          <p className="px-5 py-16 text-center text-sm text-danger-000">
            {error ?? 'Failed to load notebook.'}
          </p>
        ) : runs.length === 0 ? (
          <p className="px-5 py-16 text-center text-sm text-text-300">
            No execution records for this session.
          </p>
        ) : (
          <>
            <div
              role="tablist"
              data-testid="session-kernel-switcher"
              className="flex shrink-0 items-center gap-1 border-y border-border-100 bg-bg-200 px-3 py-1.5"
            >
              {visibleKinds.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  aria-selected={effectiveActiveKind === kind}
                  data-testid={`session-notebook-tab-${kind}`}
                  onClick={() => setActiveKind(kind)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
                    effectiveActiveKind === kind
                      ? 'bg-bg-300 text-text-000'
                      : 'text-text-300 hover:bg-bg-300/60 hover:text-text-100'
                  )}
                >
                  <span>{kernelKindLabel(kind)}</span>
                  <span className="font-mono text-text-300">
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

      <div className="flex items-center justify-end gap-3 border-t border-border-300/15 px-5 py-3.5">
        {ipynbExportStatus === 'error' ? (
          <span className="text-xs text-danger-000">Notebook export failed. Try again.</span>
        ) : null}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Wrapper span keeps the tooltip reachable while the button is disabled. */}
              <span>
                <button
                  type="button"
                  disabled={
                    status !== 'ready' ||
                    runs.length === 0 ||
                    onExportIpynb === undefined ||
                    ipynbExportStatus === 'saving'
                  }
                  onClick={onExportIpynb}
                  className="flex items-center justify-center gap-1.5 rounded px-2 py-1 text-xs text-text-200 hover:bg-bg-200 hover:text-text-000 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Download as .ipynb"
                >
                  <Download className="size-3.5" aria-hidden="true" />
                  {ipynbExportStatus === 'saving' ? 'Exporting…' : '.ipynb'}
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {runs.length === 0 ? 'No runs to export' : 'Download as .ipynb'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
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
  const [ipynbExportStatus, setIpynbExportStatus] = useState<IpynbExportStatus>('idle')

  const sessionId = session?.id
  const projectId = session?.projectId
  const cwd = session?.cwd

  // Reads the freshly projected .ipynb from main (run.json stays the source of truth there) and
  // hands the exact bytes to the shared Save As flow. A canceled dialog is neutral, not an error.
  const handleExportIpynb = async (): Promise<void> => {
    if (!sessionId || ipynbExportStatus === 'saving') return

    setIpynbExportStatus('saving')

    try {
      const exported = await window.api.notebook.exportIpynb({
        sessionId,
        projectName: projectId,
        workspaceCwd: cwd ?? ''
      })

      if (!exported) {
        throw new Error('No notebook found for this session.')
      }

      await window.api.saveBlobFile({
        suggestedName: exported.suggestedName,
        mimeType: 'application/x-ipynb+json',
        data: new TextEncoder().encode(exported.json).buffer
      })
      setIpynbExportStatus('idle')
    } catch (exportError) {
      // A canceled Save As resolves instead of throwing, so reaching here means a real failure —
      // keep a diagnostic trail instead of collapsing it into the generic banner alone.
      console.error('Failed to export notebook as .ipynb:', exportError)
      setIpynbExportStatus('error')
    }
  }

  useEffect(() => {
    if (!sessionId) return

    let cancelled = false

    // Defer state writes out of the synchronous effect body, then load runs read-only.
    const timeoutId = window.setTimeout(() => {
      setStatus('loading')
      setError(undefined)
      setRuns([])
      // The dialog is mounted once and the session prop swaps in place, so per-session export
      // state (notably a prior failure banner) must not leak into the next session.
      setIpynbExportStatus('idle')

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
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100%-2rem)] max-w-5xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border-300/15 bg-bg-000 text-text-100 shadow-xl"
        >
          <Dialog.Title className="sr-only">Session notebook</Dialog.Title>
          {session ? (
            <SessionNotebookContent
              sessionId={session.id}
              runs={runs}
              status={status}
              error={error}
              onClose={onClose}
              onExportIpynb={() => {
                void handleExportIpynb()
              }}
              ipynbExportStatus={ipynbExportStatus}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { SessionNotebookContent, SessionNotebookDialog }
