import { useCallback, useEffect, useState } from 'react'

import type { PreviewToolItem } from '@/stores/preview-workbench-store'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import { cn } from '@/lib/utils'

import type {
  NotebookEnvironmentStatus,
  NotebookKernelKind,
  NotebookLanguage,
  NotebookRunRecord,
  NotebookSessionReference,
  NotebookSessionState
} from '../../../../shared/notebook'
import { EnvProvisionOverlay } from './EnvProvisionOverlay'
import { shouldProvisionR } from './lazy-r'
import { notebookGated } from './provisioning-view'
import { NotebookCodeBlock } from './notebook-code'
import { NotebookRunOutputs } from './NotebookRunOutputs'
import {
  resolveRunErrorLine,
  environmentLabel,
  isProblemRunStatus,
  kernelKindLabel,
  kernelOriginLabel,
  resolveRunEnvironment,
  resolveRunKernelKind
} from './notebook-cell-utils'

// Fixed tab order for the per-kernel switcher.
const KERNEL_KIND_ORDER: NotebookKernelKind[] = ['python', 'r', 'repl', 'bash']

// Small dot color for the per-env status badge, reusing the divider's busy/idle vocabulary plus a
// distinct color for the terminal states (design D6).
const envStatusDotClass = (status: NotebookEnvironmentStatus['status'] | undefined): string => {
  switch (status) {
    case 'running':
    case 'starting':
    case 'restarting':
      return 'bg-accent'
    case 'error':
      return 'bg-danger-000'
    case 'terminated':
    case 'shutdown':
      return 'bg-text-300'
    default:
      return 'bg-text-200'
  }
}

export type NotebookPreviewItem = PreviewToolItem & {
  toolKind: 'notebook'
  notebook: NotebookSessionReference
}

type NotebookPreviewProps = {
  item: NotebookPreviewItem
}

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

// Collapses stdout, stderr, and traceback into the text block shown under each run.
const getRunOutputText = (run: NotebookRunRecord | undefined): string => {
  if (!run) return ''

  return [run.text.stdout, run.text.stderr, run.text.traceback]
    .filter((text) => text.trim().length > 0)
    .join('\n')
}

// Displays one durable execution record from run.json in chronological order. The zero-based index
// is the cell number shown in [n], and a failed run marks the offending line.
const NotebookRunCell = ({
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
    <div className="px-4 py-3" data-testid="notebook-cell">
      <div className="mb-2 flex items-center justify-between text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-text-300">[{index}]</span>
          <span className="rounded bg-bg-300 px-1.5 py-0.5 text-text-200">{kind}</span>
          {run.source === 'user' ? (
            <span className="rounded bg-accent px-1.5 py-0.5 font-medium text-accent">you</span>
          ) : null}
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
          <span className="font-mono text-text-300" data-testid="notebook-cell-origin">
            {originLabel}
          </span>
        ) : null}
      </div>
      <NotebookCodeBlock code={run.script} highlightLine={errorLine} />
      <NotebookRunOutputs run={run} />
    </div>
  )
}

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
  const [isRestarting, setIsRestarting] = useState(false)
  const [activeKind, setActiveKind] = useState<NotebookKernelKind>('python')
  // Selected environment within the active python/r pane; undefined lets the effective-env
  // computation below default to the first (canonical-default-first) environment.
  const [activeEnv, setActiveEnv] = useState<string | undefined>(undefined)

  // Greys the pane while python is unavailable or an upgrade is running (spec §6.5).
  const envStatus = useNotebookEnvStore((s) => s.status)
  const provisionUi = useNotebookEnvStore((s) => s.ui)
  const retryProvision = useNotebookEnvStore((s) => s.retry)
  const provision = useNotebookEnvStore((s) => s.provision)
  const gated = notebookGated(envStatus, provisionUi, item.notebook.sessionId)
  const isPreparingR =
    provisionUi.kind === 'preparing' &&
    provisionUi.scope === 'r' &&
    (!provisionUi.sessionId || provisionUi.sessionId === item.notebook.sessionId)

  // First-time R selection kicks off the lazy ~1GB R download in the background; Python stays
  // usable throughout (D6 — see lazy-r.ts). R-kernel execution routing is wired later in E5.
  const onSelectLanguage = (lang: NotebookLanguage): void => {
    if (shouldProvisionR(envStatus, lang)) void provision('r')
  }

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
    isLoading || isSubmitting || isAgentWriting || Boolean(notebookState?.activeRunId) || gated
  const runs = notebookState?.runs ?? notebookState?.recentRuns ?? []

  // Surface a tab only for kernel kinds that actually produced a run — no default python/r tabs on a
  // fresh notebook; a kernel's tab appears once it has been used.
  const kindsWithRuns = new Set(runs.map(resolveRunKernelKind))
  const visibleKinds = KERNEL_KIND_ORDER.filter((kind) => kindsWithRuns.has(kind))
  // Default to the first kind (in fixed order) that actually has runs; fall back to python only when
  // there are no runs at all (so an empty notebook doesn't render a blank non-python pane).
  const effectiveActiveKind = visibleKinds.includes(activeKind)
    ? activeKind
    : (KERNEL_KIND_ORDER.find((kind) => kindsWithRuns.has(kind)) ?? visibleKinds[0] ?? 'python')
  const kindRuns = runs.filter((run) => resolveRunKernelKind(run) === effectiveActiveKind)

  // Per-environment selector (design D6): only python/r are env-scoped. Distinct env names among
  // this kind's runs, canonical default first, so the selector (when shown) reads default-first.
  const isEnvScopedKind = effectiveActiveKind === 'python' || effectiveActiveKind === 'r'
  const envNames = isEnvScopedKind
    ? Array.from(
        new Set(
          kindRuns.map(resolveRunEnvironment).filter((env): env is string => env !== undefined)
        )
      ).sort((a, b) => {
        const aIsDefault = a === 'default-python' || a === 'default-r'
        const bIsDefault = b === 'default-python' || b === 'default-r'
        if (aIsDefault !== bIsDefault) return aIsDefault ? -1 : 1
        return a.localeCompare(b)
      })
    : []
  // Hide the selector entirely when there's at most one environment — zero visual change for the
  // common single-default-env case.
  const showEnvSelector = envNames.length > 1
  const effectiveActiveEnv = showEnvSelector
    ? envNames.includes(activeEnv ?? '')
      ? (activeEnv as string)
      : envNames[0]
    : undefined
  const visibleRuns = showEnvSelector
    ? kindRuns.filter((run) => resolveRunEnvironment(run) === effectiveActiveEnv)
    : kindRuns

  // Live status for one env option in the selector, matched by (kind, env) against the per-env
  // status view (defaulting the env name the same way resolveRunEnvironment does).
  const envOptionStatus = (envName: string): NotebookEnvironmentStatus['status'] | undefined =>
    notebookState?.environments.find((entry) => {
      if (entry.kind !== effectiveActiveKind) return false
      const entryEnvName =
        entry.environment ?? (entry.kind === 'r' ? 'default-r' : 'default-python')
      return entryEnvName === envName
    })?.status

  // R-only restart prompt: an R install/uninstall flags the active R env until its kernel restarts.
  const activeEnvName =
    effectiveActiveEnv ?? (effectiveActiveKind === 'r' ? 'default-r' : 'default-python')
  const restartRecommended =
    effectiveActiveKind === 'r' &&
    (notebookState?.environments.find((entry) => {
      if (entry.kind !== 'r') return false
      return (entry.environment ?? 'default-r') === activeEnvName
    })?.restartRecommended ??
      false)

  // Restarts the shared interpreter, replacing state with the fresh snapshot so the banner clears.
  const handleRestart = async (): Promise<void> => {
    setIsRestarting(true)
    setActionError(null)
    try {
      const next = await window.api.notebook.restart(createNotebookRequest(item.notebook))
      applyNotebookState(next)
    } catch (error) {
      setActionError(getErrorMessage(error))
    } finally {
      setIsRestarting(false)
    }
  }

  return (
    <section
      className="relative flex h-full min-w-0 flex-col overflow-hidden bg-bg-000"
      data-testid="kernel-notebook-pane"
    >
      {gated ? (
        <EnvProvisionOverlay ui={provisionUi} onRetry={() => void retryProvision()} />
      ) : null}
      <header
        className="flex shrink-0 items-center border-b border-border-100 px-2 py-1.5"
        data-testid="kernel-switcher"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {visibleKinds.map((kind) =>
            kind === 'r' ? (
              // R additionally kicks off lazy provisioning on first selection (D6 — see lazy-r.ts).
              <button
                key="r"
                type="button"
                data-testid="kernel-switcher-r"
                onClick={() => {
                  setActiveKind('r')
                  onSelectLanguage('r')
                }}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
                  effectiveActiveKind === 'r'
                    ? 'bg-bg-300 text-text-000'
                    : 'text-text-300 hover:bg-bg-200 hover:text-text-100'
                )}
              >
                {isPreparingR ? 'R (preparing…)' : 'R'}
              </button>
            ) : (
              <button
                key={kind}
                type="button"
                data-testid={`kernel-switcher-${kind}`}
                onClick={() => setActiveKind(kind)}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
                  effectiveActiveKind === kind
                    ? 'bg-bg-300 text-text-000'
                    : 'text-text-300 hover:bg-bg-200 hover:text-text-100'
                )}
              >
                {kernelKindLabel(kind)}
              </button>
            )
          )}
        </div>
      </header>

      {showEnvSelector ? (
        <div
          className="flex shrink-0 items-center gap-1 border-b border-border-100 px-2 py-1"
          data-testid="env-selector"
        >
          {envNames.map((envName) => (
            <button
              key={envName}
              type="button"
              data-testid={`env-option-${envName}`}
              onClick={() => setActiveEnv(envName)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] transition-colors',
                effectiveActiveEnv === envName
                  ? 'bg-bg-200 text-text-100'
                  : 'text-text-300 hover:bg-bg-200 hover:text-text-100'
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  envStatusDotClass(envOptionStatus(envName))
                )}
                data-testid={`env-option-${envName}-status`}
              />
              {environmentLabel(envName)}
            </button>
          ))}
        </div>
      ) : null}

      {restartRecommended ? (
        <div
          className="flex shrink-0 items-center justify-between gap-2 border-b border-border-100 bg-bg-300 px-3 py-1.5 text-[11px] text-text-100"
          data-testid="r-restart-banner"
        >
          <span>Installed R packages need a kernel restart to load.</span>
          <button
            type="button"
            disabled={isRestarting}
            onClick={() => void handleRestart()}
            className="shrink-0 rounded-md border border-border-200 px-2 py-0.5 font-medium text-text-100 transition-colors hover:bg-bg-200 disabled:opacity-50"
            data-testid="r-restart-button"
          >
            {isRestarting ? 'Restarting…' : 'Restart R kernel'}
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col" data-testid="operon-notebook-terminal-split">
        <div className="min-h-0 flex-[4_1_0] overflow-visible" data-testid="notebook-cells-panel">
          <div className="flex h-full min-h-0 flex-col overflow-auto">
            <div className="min-h-0 flex-1 overflow-y-auto" data-testid="notebook-cells">
              <div className="divide-y divide-border-100">
                {visibleRuns.map((run, index) => (
                  <NotebookRunCell key={run.runId} run={run} index={index} />
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
