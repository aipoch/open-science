import { useCallback, useEffect, useState } from 'react'
import { Copy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { PreviewToolItem } from '@/stores/preview-workbench-store'

import type {
  NotebookRunRecord,
  NotebookSessionReference,
  NotebookSessionState
} from '../../../../shared/notebook'

export type NotebookPreviewItem = PreviewToolItem & {
  toolKind: 'notebook'
  notebook: NotebookSessionReference
}

type NotebookPreviewProps = {
  item: NotebookPreviewItem
}

const pythonKeywords = new Set([
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'False',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'None',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'True',
  'try',
  'while',
  'with',
  'yield'
])

const pythonBuiltins = new Set([
  'dict',
  'enumerate',
  'float',
  'int',
  'len',
  'list',
  'open',
  'print',
  'range',
  'set',
  'str',
  'sum',
  'tuple',
  'zip'
])

const codeTokenPattern =
  /#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b|\s+|./g

// Converts any IPC failure into displayable text without losing non-Error values.
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// Reuses the stable notebook routing fields for every renderer IPC request.
const createNotebookRequest = (
  notebook: NotebookSessionReference
): {
  projectName: string
  sessionId: string
  workspaceCwd: string
} => ({
  projectName: notebook.projectName,
  sessionId: notebook.sessionId,
  workspaceCwd: notebook.workspaceCwd
})

// Provides lightweight Python token coloring without introducing a full Markdown/code editor.
const highlightPythonCode = (code: string): React.ReactNode[] => {
  const tokens = code.match(codeTokenPattern) ?? []

  return tokens.map((token, index) => {
    const className = token.startsWith('#')
      ? 'text-text-300'
      : token.startsWith('"') || token.startsWith("'")
        ? 'text-primary'
        : /^\d/.test(token)
          ? 'text-action-primary'
          : pythonKeywords.has(token)
            ? 'font-semibold text-action-primary'
            : pythonBuiltins.has(token)
              ? 'text-text-100'
              : 'text-text-000'

    return (
      <span key={`${token}-${index}`} className={className}>
        {token}
      </span>
    )
  })
}

// Collapses stdout, stderr, and traceback into the text block shown under each run.
const getRunOutputText = (run: NotebookRunRecord | undefined): string => {
  if (!run) return ''

  return [run.text.stdout, run.text.stderr, run.text.traceback]
    .filter((text) => text.trim().length > 0)
    .join('\n')
}

// Groups all non-success terminal states that should be styled as diagnostic output.
const isProblemRunStatus = (status: NotebookRunRecord['status']): boolean =>
  status === 'failed' || status === 'timeout' || status === 'interrupted'

// Maps persisted run status to the small status indicator color.
const runStatusClassName = (status: NotebookRunRecord['status']): string =>
  status === 'completed'
    ? 'text-primary'
    : isProblemRunStatus(status)
      ? 'text-danger-000'
      : 'text-action-primary'

// Renders the captured output for one run, preserving whitespace for tracebacks.
const NotebookRunOutput = ({ run }: { run: NotebookRunRecord }): React.JSX.Element | null => {
  const outputText = getRunOutputText(run)

  if (!outputText) return null

  return (
    <details className="mt-2" open>
      <summary className="cursor-pointer text-xs text-text-300 hover:text-text-200">output</summary>
      <pre
        className={cn(
          'mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-bg-200 p-2 font-mono text-xs text-text-200',
          isProblemRunStatus(run.status) && 'border-l-2 border-danger-000/50 text-danger-000'
        )}
      >
        {outputText}
      </pre>
    </details>
  )
}

// Renders code with stable line numbers while keeping the text selectable and scrollable.
const LineNumberedCode = ({ code }: { code: string }): React.JSX.Element => {
  const lines = code.length > 0 ? code.split('\n') : ['']
  const lineNumberWidth = String(lines.length).length + 1

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {lines.map((line, index) => (
        <div key={`${index}-${line}`} className="flex min-w-max">
          <span
            className="inline-block select-none pr-4 text-right text-text-300"
            style={{ minWidth: `${lineNumberWidth + 1}ch` }}
          >
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre">{highlightPythonCode(line)}</span>
        </div>
      ))}
    </div>
  )
}

// Shows the executed script for a run with a lightweight copy affordance.
const NotebookCodeBlock = ({ code }: { code: string }): React.JSX.Element => (
  <div className="relative group w-full overflow-auto bg-bg-200">
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute right-2 top-2 bg-bg-300/80 text-text-300 opacity-60 backdrop-blur-sm hover:bg-bg-300 hover:text-text-100 focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
            aria-label="Copy to clipboard"
            onClick={() => {
              void navigator.clipboard.writeText(code)
            }}
          >
            <Copy className="size-3.5" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copy to clipboard</TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <pre className="m-0 w-max min-w-full overflow-auto p-4 font-mono text-[13px] leading-[1.5]">
      <code>
        <LineNumberedCode code={code} />
      </code>
    </pre>
  </div>
)

// Displays one durable execution record from run.json in chronological order.
const NotebookRunCell = ({ run }: { run: NotebookRunRecord }): React.JSX.Element => (
  <div className="px-4 py-3" data-testid="notebook-cell">
    <div className="mb-2 flex items-center justify-between text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span className="font-mono text-text-300">[{run.executionCount ?? ''}]</span>
        <span className="rounded bg-bg-300 px-1.5 py-0.5 text-text-200">python</span>
        {run.source === 'user' ? (
          <span className="rounded bg-accent px-1.5 py-0.5 font-medium text-accent">you</span>
        ) : null}
        {isProblemRunStatus(run.status) ? (
          <span className="rounded bg-danger-900 px-1.5 py-0.5 text-danger-000">{run.status}</span>
        ) : null}
      </div>
      <span className={cn('font-mono text-text-300', runStatusClassName(run.status))}>
        {run.status === 'running' ? 'running' : ''}
      </span>
    </div>
    <NotebookCodeBlock code={run.script} />
    <NotebookRunOutput run={run} />
  </div>
)

// Mirrors terminal-originated runs in the bottom terminal scrollback.
const TerminalScrollback = ({ runs }: { runs: NotebookRunRecord[] }): React.JSX.Element => (
  <div
    className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-5"
    data-testid="kernel-terminal-scrollback"
  >
    {runs
      .filter((run) => run.inputKind === 'terminal')
      .map((run) => (
        <div key={run.runId} className="whitespace-pre-wrap">
          <div>
            <span className="text-text-300">&gt;&gt;&gt; </span>
            <span className="text-text-100">{run.script}</span>
          </div>
          {getRunOutputText(run) ? (
            <div className={isProblemRunStatus(run.status) ? 'text-danger-000' : 'text-text-200'}>
              {getRunOutputText(run)}
            </div>
          ) : null}
        </div>
      ))}
  </div>
)

// Captures one-line terminal code and submits on Enter while Shift+Enter keeps editing.
const TerminalInput = ({
  code,
  disabled,
  onChange,
  onSubmit
}: {
  code: string
  disabled: boolean
  onChange: (value: string) => void
  onSubmit: () => void
}): React.JSX.Element => {
  // Match Python REPL ergonomics while avoiding submit during IME composition.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return

    event.preventDefault()
    onSubmit()
  }

  return (
    <div className="flex items-start gap-2 border-t border-border-100/60 px-3 py-2">
      <span className="pt-0.5 font-mono text-xs text-primary">&gt;&gt;&gt;</span>
      <textarea
        rows={1}
        value={code}
        disabled={disabled}
        placeholder="run code in this kernel..."
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        className="min-h-0 flex-1 resize-none bg-transparent font-mono text-xs text-text-000 outline-none placeholder:text-text-300 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="kernel-terminal-input"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
    </div>
  )
}

// Renders the notebook preview and keeps it synchronized with main-process runtime events.
const NotebookPreview = ({ item }: NotebookPreviewProps): React.JSX.Element => {
  const [notebookState, setNotebookState] = useState<NotebookSessionState | undefined>()
  const [terminalCode, setTerminalCode] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Keeps state assignment isolated so load paths and event paths share the same update hook.
  const applyNotebookState = useCallback((nextState: NotebookSessionState): void => {
    setNotebookState(nextState)
  }, [])

  // Reads the latest notebook state from main, including full run history from run.json.
  const loadNotebookState = useCallback(async (): Promise<void> => {
    setIsLoading(true)

    try {
      const nextState = await window.api.notebook.state(createNotebookRequest(item.notebook))

      applyNotebookState(nextState)
      setActionError(null)
    } catch (error) {
      setActionError(getErrorMessage(error))
    } finally {
      setIsLoading(false)
    }
  }, [applyNotebookState, item.notebook])

  // Defer the initial state load until after the component has mounted.
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadNotebookState()
    }, 0)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [loadNotebookState])

  // Reload whenever the shared runtime publishes a change for this notebook session.
  useEffect(() => {
    return window.api.notebook.onChanged((event) => {
      if (event.sessionId === item.notebook.sessionId) {
        void loadNotebookState()
      }
    })
  }, [item.notebook.sessionId, loadNotebookState])

  // Sends terminal code through the same notebook interpreter and history path as agent code.
  const submitTerminalCode = async (): Promise<void> => {
    const code = terminalCode.trim()

    if (!code || notebookState?.activeWrite?.source === 'agent' || notebookState?.activeRunId) {
      return
    }

    // Clear optimistically so a running terminal command feels like a REPL submission.
    setTerminalCode('')
    setIsSubmitting(true)
    setActionError(null)

    try {
      await window.api.notebook.execute({
        ...createNotebookRequest(item.notebook),
        code,
        source: 'user',
        inputKind: 'terminal'
      })

      await loadNotebookState()
    } catch (error) {
      setTerminalCode(code)
      setActionError(getErrorMessage(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  // Agent writes and active executions lock terminal input to avoid interleaving code streams.
  const isAgentWriting = notebookState?.activeWrite?.source === 'agent'
  const isNotebookBusy = isSubmitting || Boolean(notebookState?.activeRunId)
  const isTerminalLocked =
    isLoading || isSubmitting || isAgentWriting || Boolean(notebookState?.activeRunId)
  const runs = notebookState?.runs ?? notebookState?.recentRuns ?? []

  return (
    <section
      className="flex h-full min-w-0 flex-col overflow-hidden bg-bg-000"
      data-testid="kernel-notebook-pane"
    >
      <header
        className="flex shrink-0 items-center border-b border-border-100 px-2 py-1.5"
        data-testid="kernel-switcher"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-bg-300 px-2 py-1 text-xs text-text-000">
            Python
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col" data-testid="operon-notebook-terminal-split">
        <div className="min-h-0 flex-[4_1_0] overflow-visible" data-testid="notebook-cells-panel">
          <div className="flex h-full min-h-0 flex-col overflow-auto">
            <div className="min-h-0 flex-1 overflow-y-auto" data-testid="notebook-cells">
              <div className="divide-y divide-border-100">
                {runs.map((run) => (
                  <NotebookRunCell key={run.runId} run={run} />
                ))}
              </div>
            </div>
          </div>
        </div>

        <div
          aria-orientation="horizontal"
          className="group relative flex shrink-0 select-none items-center justify-between gap-2 border-y border-border-200 bg-bg-200/70 px-3 py-1 text-[11px] text-text-300 outline-none transition-colors hover:bg-bg-200"
          data-testid="notebook-terminal-divider"
          role="separator"
        >
          <span>Python kernel · shared with the agent</span>
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-1 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border-100 opacity-60 transition duration-150 group-hover:opacity-100" />
          <span>{isNotebookBusy ? 'running' : 'idle'}</span>
        </div>

        <div className="min-h-0 flex-[1_1_0]" data-testid="notebook-terminal-panel">
          <div className="flex h-full min-h-0 flex-col bg-bg-200" data-testid="kernel-terminal">
            {actionError ? (
              <div className="border-b border-border-100/60 px-3 py-2 font-mono text-xs text-danger-000">
                {actionError}
              </div>
            ) : null}
            <TerminalScrollback runs={runs} />
            <TerminalInput
              code={terminalCode}
              disabled={isTerminalLocked}
              onChange={setTerminalCode}
              onSubmit={() => {
                void submitTerminalCode()
              }}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

export { NotebookPreview }
