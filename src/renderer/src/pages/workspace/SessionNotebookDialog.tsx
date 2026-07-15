import { useEffect, useState } from 'react'
import { ChevronDown, Download, X } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { ChatSession } from '@/stores/session-store'

import type { NotebookRunRecord } from '../../../../shared/notebook'
import { NotebookCodeBlock } from './notebook-code'
import { deriveErrorLine, detectCellLanguage, isProblemRunStatus } from './notebook-cell-utils'
import { loadSessionNotebookRuns } from './session-notebook-data'

type SessionNotebookStatus = 'loading' | 'error' | 'ready'

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
  const errorLine = isProblem ? deriveErrorLine(run.text.traceback) : undefined
  const language = detectCellLanguage(run.script)
  const stdout = run.text.stdout
  const stderr = [run.text.stderr, run.text.traceback]
    .filter((value) => value.trim().length > 0)
    .join('\n')

  return (
    <div className="px-4 py-3" data-testid="session-notebook-cell">
      <div className="mb-2 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="font-mono text-text-300">[{index}]</span>
          <span className="rounded bg-bg-300 px-1.5 py-0.5 text-text-200">{language}</span>
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
        <span className="font-mono text-text-300">{language}</span>
      </div>
      <NotebookCodeBlock code={run.script} highlightLine={errorLine} />
      {stdout.trim().length > 0 || stderr.trim().length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-text-300 hover:text-text-200">
            output
          </summary>
          {stdout.trim().length > 0 ? (
            <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-bg-200 p-2 font-mono text-xs text-text-200">
              {stdout}
            </pre>
          ) : null}
          {stderr.trim().length > 0 ? (
            <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-bg-200 p-2 font-mono text-xs text-danger-000">
              {stderr}
            </pre>
          ) : null}
        </details>
      ) : null}
    </div>
  )
}

type SessionNotebookContentProps = {
  sessionId: string
  runs: NotebookRunRecord[]
  status: SessionNotebookStatus
  error?: string
  onClose: () => void
}

// Pure presentational body of the dialog: header summary, empty/loading/error/populated states,
// and the disabled .ipynb footer. Kept free of data-loading hooks and Dialog context so it renders
// standalone in tests; close is delegated through onClose.
const SessionNotebookContent = ({
  sessionId,
  runs,
  status,
  error,
  onClose
}: SessionNotebookContentProps): React.JSX.Element => {
  const shortId = sessionId.slice(0, 8)
  const agents = runs.some((run) => run.source === 'agent') ? 1 : 0
  const cells = runs.length

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
          <details open className="group/agent">
            <summary className="flex cursor-pointer list-none items-center gap-2 border-y border-border-100 bg-bg-200 px-4 py-2 text-xs hover:bg-bg-300">
              <ChevronDown
                className="size-3.5 -rotate-90 text-text-300 transition-transform group-open/agent:rotate-0"
                aria-hidden="true"
              />
              <span className="font-semibold text-text-100">Open Science</span>
              <span className="font-mono text-text-300">{shortId}</span>
              <span className="text-text-300">·</span>
              <span className="text-text-300">{pluralize(cells, 'cell')}</span>
            </summary>
            <div className="divide-y divide-border-100">
              {runs.map((run, index) => (
                <NotebookDialogCell key={run.runId} run={run} index={index} />
              ))}
            </div>
          </details>
        )}
      </div>

      <div className="flex justify-end gap-3 border-t border-border-300/15 px-5 py-3.5">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Wrapper span keeps the tooltip reachable even though the button is disabled. */}
              <span>
                <button
                  type="button"
                  disabled
                  className="flex items-center justify-center gap-1.5 rounded px-2 py-1 text-xs text-text-200 hover:bg-bg-200 hover:text-text-000 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Download as .ipynb"
                >
                  <Download className="size-3.5" aria-hidden="true" />
                  .ipynb
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Notebook export is coming soon</TooltipContent>
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
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { SessionNotebookContent, SessionNotebookDialog }
