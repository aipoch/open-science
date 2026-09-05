import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type RefObject
} from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, TriangleAlert, Variable, X } from 'lucide-react'

import { usePreviewWorkbenchStore, type PreviewToolItem } from '@/stores/preview-workbench-store'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSessionStore } from '@/stores/session-store'
import { ErrorNotice } from '@/components/error-notice'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

import type {
  NotebookEnvironmentStatus,
  NotebookKernelKind,
  NotebookLanguage,
  NotebookNamespaceSnapshot,
  NotebookNamespaceVariable,
  NotebookRunRecord,
  NotebookRunStaleness,
  NotebookSessionReference,
  NotebookSessionState
} from '../../../../shared/notebook'
import { isCurrentInFlight } from '../../../../shared/in-flight-promise'
import { resolveProjectId } from '../../../../shared/project-scope'
import { EnvProvisionOverlay } from './EnvProvisionOverlay'
import { shouldProvisionR } from './lazy-r'
import { hasActiveRuntimeTarget, notebookGated } from './provisioning-view'
import { NotebookCodeBlock } from './notebook-code'
import { NotebookRunOutputs } from './NotebookRunOutputs'
import { NotebookInputDataStrip } from './NotebookInputDataStrip'
import { isCurrentSessionNotebookView } from './follow-notebook-scroll'
import { useFollowScrollBottom } from './use-follow-scroll-bottom'
import { useHorizontalScrollFade } from './use-horizontal-scroll-fade'
import {
  resolveRunErrorLine,
  environmentLabel,
  isProblemRunStatus,
  kernelKindLabel,
  kernelOriginLabel,
  notebookRunStatusLabel,
  resolveRunEnvironment,
  resolveRunKernelKind
} from './notebook-cell-utils'
import {
  createNotebookFrameFilterOptions,
  notebookFrameLabels,
  normalizeNotebookRootFrameRuns,
  projectNotebookRunsForFrame,
  type NotebookFrameFilterValue
} from './session-notebook-projection'

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

type NotebookNamespaceViewStatus =
  'empty' | 'loading' | 'ready' | 'stale' | 'refreshing' | 'unavailable' | 'error'

type AvailableNotebookNamespace = Extract<NotebookNamespaceSnapshot, { status: 'available' }>

// Converts any IPC failure into displayable text without losing non-Error values.
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const formatNamespaceSize = (sizeBytes: number | undefined): string => {
  if (sizeBytes === undefined) return '—'
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

// Reuses the stable notebook routing fields for every renderer IPC request.
const createNotebookRequest = (
  notebook: NotebookSessionReference
): {
  projectId: string
  sessionId: string
  workspaceCwd: string
} => ({
  projectId: resolveProjectId(notebook),
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

const DependencyStatusBadge = ({
  staleness,
  causedByRunIndex
}: {
  staleness: Exclude<NotebookRunStaleness, { state: 'clear' }>
  causedByRunIndex?: number
}): React.JSX.Element => {
  const { t } = useTranslation()
  const isStale = staleness.state === 'stale'
  const label = isStale ? t('Variable changed after this run') : t('Variable tracking is limited')
  const detail = isStale
    ? t(
        'Run [{{index}}] later changed {{names}}. This output is the snapshot recorded before that change; this run completed normally.',
        { names: staleness.names.join(', '), index: causedByRunIndex }
      )
    : t(
        'This run completed normally. Some variable relationships in this code could not be determined automatically, so later variable changes may not be linked back to this run.'
      )

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex cursor-help items-center gap-1 rounded px-1.5 py-0.5',
              isStale ? 'bg-warning-100 text-warning-900' : 'bg-bg-300 text-text-200'
            )}
            data-testid={isStale ? 'notebook-cell-stale' : 'notebook-cell-dependency-unknown'}
          >
            <Variable className="size-3 shrink-0" aria-hidden="true" />
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[320px] px-3 py-2 leading-5">
          {detail}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// Displays one durable execution record from run.json in chronological order. The zero-based index
// is the cell number shown in [n], and a failed run marks the offending line.
const NotebookRunCell = ({
  run,
  index,
  staleness,
  causedByRunIndex
}: {
  run: NotebookRunRecord
  index: number
  staleness?: NotebookRunStaleness
  causedByRunIndex?: number
}): React.JSX.Element => {
  const { t } = useTranslation()
  const isProblem = isProblemRunStatus(run.status)
  const statusLabel = notebookRunStatusLabel(run.status)
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
            <span className="rounded bg-blue-500/10 px-1.5 py-0.5 font-medium text-blue-700 dark:text-blue-300">
              {t('you')}
            </span>
          ) : null}
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
            <span className="rounded bg-bg-300 px-1.5 py-0.5 text-text-200">{t(statusLabel)}</span>
          ) : null}
          {staleness?.state === 'stale' ? (
            <DependencyStatusBadge staleness={staleness} causedByRunIndex={causedByRunIndex} />
          ) : staleness?.state === 'unknown' ? (
            <DependencyStatusBadge staleness={staleness} />
          ) : null}
        </div>
        {originLabel ? (
          <span className="font-mono text-text-300" data-testid="notebook-cell-origin">
            {originLabel}
          </span>
        ) : null}
      </div>
      <NotebookInputDataStrip
        inputFiles={run.inputFiles ?? []}
        className="mb-2 rounded-md border border-border-100 bg-bg-100 px-2 py-1.5"
      />
      <NotebookCodeBlock
        code={run.script}
        language={kind === 'repl' ? 'javascript' : kind}
        highlightLine={errorLine}
      />
      <NotebookRunOutputs run={run} />
    </div>
  )
}

// Mirrors terminal-originated runs in the bottom terminal scrollback.
const TerminalScrollback = ({
  runs,
  language,
  viewportRef
}: {
  runs: NotebookRunRecord[]
  language: NotebookLanguage
  viewportRef: RefObject<HTMLDivElement | null>
}): React.JSX.Element => {
  const prompt = language === 'r' ? '>' : '>>>'

  return (
    <div
      ref={viewportRef}
      className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-5"
      data-testid="kernel-terminal-scrollback"
    >
      <div>
        {runs
          .filter((run) => run.inputKind === 'terminal')
          .map((run) => (
            <div key={run.runId} className="whitespace-pre-wrap">
              <div>
                <span className="text-text-300">{prompt} </span>
                <span className="text-text-100">{run.script}</span>
              </div>
              {getRunOutputText(run) ? (
                <div
                  className={isProblemRunStatus(run.status) ? 'text-danger-000' : 'text-text-200'}
                >
                  {getRunOutputText(run)}
                </div>
              ) : null}
            </div>
          ))}
      </div>
    </div>
  )
}

const MAX_VARIABLE_SUGGESTIONS = 8

const variablePrefixAtCaret = (
  code: string,
  caretOffset: number
): { prefix: string; start: number } | undefined => {
  const caret = Math.max(0, Math.min(caretOffset, code.length))
  const match = code.slice(0, caret).match(/[\p{L}\p{N}_.]+$/u)
  if (!match?.[0]) return undefined
  return { prefix: match[0], start: caret - match[0].length }
}

// Captures one-line terminal code and submits on Enter while Shift+Enter keeps editing.
const TerminalInput = ({
  code,
  disabled,
  language,
  variables,
  onChange,
  onFocusChange,
  onSubmit
}: {
  code: string
  disabled: boolean
  language: NotebookLanguage
  variables: readonly NotebookNamespaceVariable[]
  onChange: (value: string) => void
  onFocusChange: (focused: boolean) => void
  onSubmit: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const listboxId = useId()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pendingCaretOffset = useRef<number | undefined>(undefined)
  const [focused, setFocused] = useState(false)
  const [caretOffset, setCaretOffset] = useState(code.length)
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0)
  const [dismissedSuggestionKey, setDismissedSuggestionKey] = useState<string>()
  const prefix = variablePrefixAtCaret(code, caretOffset)
  const suggestions = prefix
    ? variables
        .filter(
          (variable) => variable.name !== prefix.prefix && variable.name.startsWith(prefix.prefix)
        )
        .slice(0, MAX_VARIABLE_SUGGESTIONS)
    : []
  const suggestionKey = `${code}\u0000${caretOffset}\u0000${suggestions
    .map((variable) => variable.name)
    .join('\u0000')}`
  const suggestionsOpen =
    focused && !disabled && suggestions.length > 0 && dismissedSuggestionKey !== suggestionKey
  const activeSuggestion = suggestions[activeSuggestionIndex] ?? suggestions[0]
  const activeOptionId = activeSuggestion
    ? `${listboxId}-option-${suggestions.indexOf(activeSuggestion)}`
    : undefined

  useEffect(() => {
    if (pendingCaretOffset.current === undefined) return
    const nextCaretOffset = pendingCaretOffset.current
    pendingCaretOffset.current = undefined
    inputRef.current?.setSelectionRange(nextCaretOffset, nextCaretOffset)
  }, [code])

  const acceptSuggestion = (variable: NotebookNamespaceVariable): void => {
    if (!prefix) return
    const nextCaretOffset = prefix.start + variable.name.length
    pendingCaretOffset.current = nextCaretOffset
    setCaretOffset(nextCaretOffset)
    setActiveSuggestionIndex(0)
    onChange(`${code.slice(0, prefix.start)}${variable.name}${code.slice(caretOffset)}`)
  }

  // Match Python REPL ergonomics while avoiding submit during IME composition.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return

    if (suggestionsOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setActiveSuggestionIndex(
          (current) => (current + direction + suggestions.length) % suggestions.length
        )
        return
      }
      if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && !event.shiftKey)) {
        event.preventDefault()
        if (activeSuggestion) acceptSuggestion(activeSuggestion)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissedSuggestionKey(suggestionKey)
        return
      }
    }

    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return

    event.preventDefault()
    onSubmit()
  }

  return (
    <div className="flex items-start gap-2 border-t border-border-100/60 px-3 py-2">
      <span className="pt-0.5 font-mono text-xs text-primary">
        {language === 'r' ? '>' : '>>>'}
      </span>
      <div className="relative min-w-0 flex-1">
        {suggestionsOpen ? (
          <div
            id={listboxId}
            role="listbox"
            aria-label={t('Variables')}
            className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-48 overflow-y-auto rounded-md border border-border-100 bg-bg-000 py-1 shadow-card-opaque"
          >
            {suggestions.map((variable, index) => {
              const active = variable === activeSuggestion
              return (
                <div
                  key={variable.name}
                  id={`${listboxId}-option-${index}`}
                  role="option"
                  aria-selected={active}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 px-2 py-1 text-left font-mono text-xs',
                    active ? 'bg-bg-300 text-text-000' : 'text-text-100 hover:bg-bg-200'
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveSuggestionIndex(index)}
                  onClick={() => acceptSuggestion(variable)}
                >
                  <span className="min-w-0 truncate">{variable.name}</span>
                  <span className="min-w-0 truncate text-[11px] text-text-300">
                    {variable.type}
                  </span>
                </div>
              )
            })}
          </div>
        ) : null}
        <textarea
          ref={inputRef}
          rows={1}
          value={code}
          disabled={disabled}
          placeholder={t('run code in this kernel...')}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-autocomplete={suggestionsOpen ? 'list' : undefined}
          aria-haspopup="listbox"
          aria-controls={suggestionsOpen ? listboxId : undefined}
          aria-activedescendant={suggestionsOpen ? activeOptionId : undefined}
          className="min-h-0 w-full resize-none bg-transparent font-mono text-xs text-text-000 outline-none placeholder:text-text-300 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="kernel-terminal-input"
          onBlur={() => {
            setFocused(false)
            onFocusChange(false)
          }}
          onChange={(event) => {
            onChange(event.target.value)
            setCaretOffset(event.target.selectionStart)
            setActiveSuggestionIndex(0)
          }}
          onFocus={() => {
            setFocused(true)
            setCaretOffset(inputRef.current?.selectionStart ?? code.length)
            setActiveSuggestionIndex(0)
            onFocusChange(true)
          }}
          onKeyDown={handleKeyDown}
          onSelect={(event) => {
            setCaretOffset(event.currentTarget.selectionStart)
            setActiveSuggestionIndex(0)
          }}
        />
      </div>
    </div>
  )
}

// Renders the notebook preview and keeps it synchronized with main-process runtime events.
const NotebookPreview = ({ item }: NotebookPreviewProps): React.JSX.Element => {
  const { t } = useTranslation()
  const kernelScrollFadeRef = useHorizontalScrollFade<HTMLDivElement>()
  const environmentScrollFadeRef = useHorizontalScrollFade<HTMLDivElement>()
  const [notebookState, setNotebookState] = useState<NotebookSessionState | undefined>()
  const [terminalCode, setTerminalCode] = useState('')
  const [terminalInputFocused, setTerminalInputFocused] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [submittingTarget, setSubmittingTarget] = useState<string | undefined>()
  const [actionError, setActionError] = useState<string | null>(null)
  const [isAbortingWrite, setIsAbortingWrite] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)
  const [activeKind, setActiveKind] = useState<NotebookKernelKind>('python')
  const [frameFilter, setFrameFilter] = useState<NotebookFrameFilterValue>()
  const [showVariables, setShowVariables] = useState(false)
  const [showPrivateVariables, setShowPrivateVariables] = useState(false)
  const [namespaceFilter, setNamespaceFilter] = useState('')
  const [namespaceSnapshot, setNamespaceSnapshot] = useState<AvailableNotebookNamespace>()
  const [namespaceStatus, setNamespaceStatus] = useState<NotebookNamespaceViewStatus>('empty')
  const [namespaceError, setNamespaceError] = useState<string>()
  const namespaceRequestId = useRef(0)
  const namespaceRefreshQueued = useRef(false)
  const namespaceLoadKey = useRef<string | undefined>(undefined)
  const session = useSessionStore((state) =>
    state.sessions.find((candidate) => candidate.id === item.notebook.sessionId)
  )
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId)
  const previewPanelState = usePreviewWorkbenchStore((state) => state.panelState)
  const previewActiveItemId = usePreviewWorkbenchStore((state) => state.activeItemId)
  const notebookItemInWorkbench = usePreviewWorkbenchStore((state) =>
    state.items.some((entry) => entry.id === item.id)
  )
  const followEnabled = isCurrentSessionNotebookView({
    notebookSessionId: item.notebook.sessionId,
    selectedSessionId,
    notebookItemId: item.id,
    previewPanelState,
    previewActiveItemId,
    notebookItemInWorkbench
  })
  const cellsViewportRef = useFollowScrollBottom(followEnabled)
  const terminalViewportRef = useFollowScrollBottom(followEnabled)
  // Selected environment within the active python/r pane; undefined lets the effective-env
  // computation below default to the first (canonical-default-first) environment.
  const [activeEnv, setActiveEnv] = useState<string | undefined>(undefined)
  const latestNotebookState = useRef<NotebookSessionState | undefined>(undefined)
  const stateLoadInFlight = useRef<Promise<boolean> | undefined>(undefined)
  const stateReloadQueued = useRef(false)
  const notebookRequest = createNotebookRequest(item.notebook)
  const notebookRequestKey = JSON.stringify(notebookRequest)
  const latestNotebookRequest = useRef({ request: notebookRequest, key: notebookRequestKey })

  useEffect(() => {
    latestNotebookRequest.current = { request: notebookRequest, key: notebookRequestKey }
  }, [notebookRequest, notebookRequestKey])

  // Greys the pane while python is unavailable or an upgrade is running (spec §6.5).
  const envStatus = useNotebookEnvStore((s) => s.status)
  const provisionUi = useNotebookEnvStore((s) => s.ui)
  const retryProvision = useNotebookEnvStore((s) => s.retry)
  const provision = useNotebookEnvStore((s) => s.provision)
  const openSettingsToPanel = useSettingsStore((s) => s.openSettingsToPanel)
  const isPreparingR =
    provisionUi.kind === 'preparing' &&
    provisionUi.scope === 'r' &&
    (!provisionUi.sessionId || provisionUi.sessionId === item.notebook.sessionId)

  // First-time R selection kicks off the lazy ~1GB R download in the background; Python stays
  // usable throughout (D6 — see lazy-r.ts). R-kernel execution routing is wired later in E5.
  const onSelectLanguage = (lang: NotebookLanguage): void => {
    setShowVariables(false)
    const binding = notebookState?.runtimeBindings?.[lang]
    if (binding === undefined && shouldProvisionR(envStatus, lang)) void provision('r')
  }

  // Keeps state assignment isolated so load paths and event paths share the same update hook.
  const applyNotebookState = useCallback((nextState: NotebookSessionState): void => {
    latestNotebookState.current = nextState
    setNotebookState(nextState)
  }, [])

  // Reads the latest notebook state from main, including its bounded recent run window.
  const loadNotebookState = useCallback(async (): Promise<boolean> => {
    if (stateLoadInFlight.current) {
      stateReloadQueued.current = true
      return stateLoadInFlight.current
    }
    const load = (async (): Promise<boolean> => {
      let succeeded = false
      setIsLoading(true)
      try {
        do {
          stateReloadQueued.current = false
          const requested = latestNotebookRequest.current
          try {
            const nextState = await window.api.notebook.state(requested.request)

            if (latestNotebookRequest.current.key === requested.key) {
              applyNotebookState(nextState)
              setActionError(null)
              succeeded = true
            } else {
              stateReloadQueued.current = true
            }
          } catch (error) {
            if (latestNotebookRequest.current.key === requested.key) {
              setActionError(getErrorMessage(error))
              succeeded = false
            } else {
              stateReloadQueued.current = true
            }
          }
        } while (stateReloadQueued.current)
        return succeeded
      } finally {
        setIsLoading(false)
      }
    })()
    stateLoadInFlight.current = load
    try {
      return await load
    } finally {
      if (isCurrentInFlight(stateLoadInFlight.current, load)) {
        stateLoadInFlight.current = undefined
      }
    }
  }, [applyNotebookState])

  // Defer the initial state load until after the component has mounted.
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadNotebookState()
    }, 0)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [loadNotebookState, notebookRequestKey])

  // Reload whenever the shared runtime publishes a change for this notebook session.
  useEffect(() => {
    return window.api.notebook.onChanged((event) => {
      if (event.sessionId === item.notebook.sessionId) {
        void loadNotebookState()
      }
    })
  }, [item.notebook.sessionId, loadNotebookState])

  const runs = notebookState?.runs ?? notebookState?.recentRuns ?? []
  const frameRuns = session ? normalizeNotebookRootFrameRuns(runs, session) : runs
  const frameOptions = createNotebookFrameFilterOptions(
    frameRuns,
    session ? notebookFrameLabels(session, t) : {}
  )
  const effectiveFrameFilter = frameOptions.some((option) => option.value === frameFilter)
    ? frameFilter
    : frameOptions[0]?.value
  const projectedRuns = effectiveFrameFilter
    ? projectNotebookRunsForFrame(frameRuns, effectiveFrameFilter)
    : []

  // Kernels appear only after producing a run in the current projected history.
  const kindsWithRuns = new Set(projectedRuns.map(resolveRunKernelKind))
  const visibleKinds = KERNEL_KIND_ORDER.filter((kind) => kindsWithRuns.has(kind))
  const effectiveActiveKind = visibleKinds.includes(activeKind)
    ? activeKind
    : (visibleKinds[0] ?? 'python')
  const kindRuns = projectedRuns.filter((run) => resolveRunKernelKind(run) === effectiveActiveKind)
  const activeRuntimeBinding =
    effectiveActiveKind === 'python' || effectiveActiveKind === 'r'
      ? notebookState?.runtimeBindings?.[effectiveActiveKind]
      : undefined
  const activeRuntimeTargetReady = hasActiveRuntimeTarget(activeRuntimeBinding)
  const gated = notebookGated(envStatus, provisionUi, item.notebook.sessionId, activeRuntimeBinding)
  const activeRuntimeUnavailable = activeRuntimeBinding?.status === 'unavailable'
  const activeRuntimeUnavailableReason =
    activeRuntimeBinding?.reason === 'disabled'
      ? t('Disabled')
      : activeRuntimeBinding?.reason === 'missing'
        ? t('Missing')
        : activeRuntimeBinding?.reason === 'repair-required'
          ? t('Needs repair')
          : undefined
  const activeRuntimeSettingsLabel =
    activeRuntimeUnavailable && activeRuntimeBinding
      ? t('Open settings for {{name}}', { name: activeRuntimeBinding.label })
      : undefined
  const activeRuntimeDetails = activeRuntimeBinding
    ? [
        activeRuntimeBinding.label,
        activeRuntimeBinding.version,
        activeRuntimeUnavailable ? t('Unavailable') : undefined,
        activeRuntimeUnavailableReason
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined

  // Per-environment selector (design D6): only python/r are env-scoped. Distinct env names among
  // this kind's runs, canonical default first, so the selector (when shown) reads default-first.
  const activeDataLanguage: NotebookLanguage | undefined =
    effectiveActiveKind === 'python' || effectiveActiveKind === 'r'
      ? effectiveActiveKind
      : undefined
  const executionEnvironment = activeDataLanguage
    ? (notebookState?.executionEnvironments?.[activeDataLanguage] ??
      (activeDataLanguage === 'r' ? 'default-r' : 'default-python'))
    : undefined
  const envNames = activeDataLanguage
    ? Array.from(
        new Set(
          [
            ...kindRuns.map(resolveRunEnvironment),
            ...(notebookState?.environments.flatMap((entry) =>
              entry.kind === activeDataLanguage && entry.environment ? [entry.environment] : []
            ) ?? []),
            notebookState?.latestRunEnvironments?.[activeDataLanguage],
            executionEnvironment
          ].filter((env): env is string => env !== undefined)
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
  const effectiveActiveEnv = activeDataLanguage
    ? envNames.includes(activeEnv ?? '')
      ? (activeEnv as string)
      : (executionEnvironment ?? envNames[0])
    : undefined
  const visibleRuns = activeDataLanguage
    ? kindRuns.filter((run) => resolveRunEnvironment(run) === effectiveActiveEnv)
    : kindRuns
  const visibleRunIndexById = new Map(visibleRuns.map((run, index) => [run.runId, index]))
  const visibleStalenessForRun = (run: NotebookRunRecord): NotebookRunStaleness | undefined => {
    const staleness = notebookState?.runStaleness?.[run.runId]
    if (staleness?.state !== 'stale') return staleness
    const runIndex = visibleRunIndexById.get(run.runId)
    const causeIndex = visibleRunIndexById.get(staleness.causedByRunId)
    return runIndex !== undefined && causeIndex !== undefined && causeIndex > runIndex
      ? staleness
      : undefined
  }

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
  const activeEnvName = effectiveActiveEnv
  const restartRecommended =
    activeDataLanguage === 'r' &&
    (notebookState?.environments.find((entry) => {
      if (entry.kind !== 'r') return false
      return (entry.environment ?? 'default-r') === (activeEnvName ?? 'default-r')
    })?.restartRecommended ??
      false)
  const selectedTarget =
    activeDataLanguage && activeEnvName ? `${activeDataLanguage}:${activeEnvName}` : undefined
  const activeRun = runs.find((run) => run.runId === notebookState?.activeRunId)
  const activeRunTarget =
    activeRun?.kernelKind === 'python' || activeRun?.kernelKind === 'r'
      ? `${activeRun.kernelKind}:${resolveRunEnvironment(activeRun)}`
      : undefined
  const activeKernelStatus = activeEnvName ? envOptionStatus(activeEnvName) : undefined
  const hasActiveKernelHistory =
    activeDataLanguage !== undefined &&
    activeEnvName !== undefined &&
    kindRuns.some((run) => resolveRunEnvironment(run) === activeEnvName)
  // A persisted `idle` status only describes the last app process. The per-environment status list is
  // populated from kernels known to this process. Without an entry the kernel is inactive, even when
  // this language has no history yet; only an Agent execution may activate user input.
  const isKernelInactive =
    activeDataLanguage !== undefined &&
    activeEnvName !== undefined &&
    activeKernelStatus === undefined &&
    activeRunTarget !== selectedTarget &&
    submittingTarget !== selectedTarget
  const isNamespaceLost =
    activeDataLanguage !== undefined &&
    (isKernelInactive ||
      activeKernelStatus === 'terminated' ||
      (activeDataLanguage === 'python' &&
        activeEnvName === 'default-python' &&
        notebookState?.kernelStatus === 'terminated'))
  const isHistoricalEnvironmentView =
    activeDataLanguage !== undefined &&
    activeEnvName !== undefined &&
    executionEnvironment !== undefined &&
    activeEnvName !== executionEnvironment
  const isSubmitting = submittingTarget !== undefined
  const isSelectedKernelRunning =
    (submittingTarget !== undefined && submittingTarget === selectedTarget) ||
    (activeRunTarget !== undefined && activeRunTarget === selectedTarget) ||
    activeKernelStatus === 'starting' ||
    activeKernelStatus === 'running' ||
    activeKernelStatus === 'restarting'
  const explicitRuntimeTargetUnavailable =
    activeDataLanguage !== undefined &&
    activeRuntimeBinding !== undefined &&
    !activeRuntimeTargetReady
  // The Session Aggregate owns one active write and run, so input stays globally locked even when a
  // different persistent data kernel is selected.
  const isTerminalLocked =
    (isLoading && !notebookState) ||
    isSubmitting ||
    Boolean(notebookState?.activeWrite) ||
    Boolean(notebookState?.activeRunId) ||
    gated ||
    explicitRuntimeTargetUnavailable ||
    isSelectedKernelRunning ||
    (activeDataLanguage === 'r' &&
      activeRuntimeBinding === undefined &&
      (!envStatus.rReady || isPreparingR))
  const cellCount = notebookState?.runCount ?? runs.length

  const loadNamespace = async (): Promise<void> => {
    if (
      !activeDataLanguage ||
      !activeEnvName ||
      !selectedTarget ||
      isNamespaceLost ||
      isHistoricalEnvironmentView ||
      isSelectedKernelRunning
    ) {
      if (isNamespaceLost || isHistoricalEnvironmentView) {
        namespaceRequestId.current += 1
        setNamespaceSnapshot(undefined)
        setNamespaceStatus('unavailable')
      }
      return
    }

    const requestId = ++namespaceRequestId.current
    const hasCurrentSnapshot =
      namespaceSnapshot !== undefined &&
      `${namespaceSnapshot.language}:${namespaceSnapshot.environment}` === selectedTarget
    setNamespaceStatus((status) => {
      if (!hasCurrentSnapshot) return 'loading'
      return status === 'ready' || status === 'stale' || status === 'error'
        ? 'refreshing'
        : 'loading'
    })
    setNamespaceError(undefined)
    try {
      const result = await window.api.notebook.inspectNamespace({
        ...latestNotebookRequest.current.request,
        language: activeDataLanguage,
        environment: activeEnvName,
        includePrivate: showPrivateVariables
      })
      if (namespaceRequestId.current !== requestId) return
      if (result.status === 'unavailable') {
        setNamespaceSnapshot(undefined)
        setNamespaceStatus('unavailable')
        return
      }
      if (`${result.language}:${result.environment}` !== selectedTarget) return
      setNamespaceSnapshot(result)
      setNamespaceStatus('ready')
    } catch (error) {
      if (namespaceRequestId.current !== requestId) return
      setNamespaceError(getErrorMessage(error))
      setNamespaceStatus('error')
    }
  }
  const loadLatestNamespace = useEffectEvent(loadNamespace)

  // A namespace snapshot is only valid for the lifetime of its kernel. Clear it immediately when
  // the selected kernel is lost, and invalidate any inspection response already in flight.
  useEffect(() => {
    if (!isNamespaceLost && !isHistoricalEnvironmentView) return
    namespaceRequestId.current += 1
    namespaceRefreshQueued.current = false
    namespaceLoadKey.current = undefined
    const timeoutId = window.setTimeout(() => {
      setNamespaceSnapshot(undefined)
      setNamespaceError(undefined)
      setNamespaceStatus('unavailable')
    }, 0)
    return () => window.clearTimeout(timeoutId)
  }, [isHistoricalEnvironmentView, isNamespaceLost])

  // Opening the view, switching target, or changing the private-name filter starts a fresh read.
  // Reopening never treats an old snapshot as current, and target checks drop late responses.
  useEffect(() => {
    if (
      (!showVariables && !terminalInputFocused) ||
      !activeDataLanguage ||
      isNamespaceLost ||
      isHistoricalEnvironmentView
    ) {
      namespaceLoadKey.current = undefined
      return
    }
    const loadKey = `${selectedTarget ?? ''}:${showPrivateVariables}`
    if (namespaceLoadKey.current === loadKey) return
    namespaceLoadKey.current = loadKey
    namespaceRefreshQueued.current = false
    void loadLatestNamespace()
  }, [
    activeDataLanguage,
    isHistoricalEnvironmentView,
    isNamespaceLost,
    selectedTarget,
    showPrivateVariables,
    showVariables,
    terminalInputFocused
  ])

  // Runtime events have no process key, so mark the open snapshot stale and wait for the refreshed
  // notebook state. Once the selected kernel is idle, coalesce all queued events into one read.
  useEffect(() => {
    if (!showVariables && !terminalInputFocused) return
    return window.api.notebook.onChanged((event) => {
      if (event.sessionId !== item.notebook.sessionId) return
      namespaceRefreshQueued.current = true
      setNamespaceStatus((status) => (status === 'ready' ? 'stale' : status))
    })
  }, [item.notebook.sessionId, showVariables, terminalInputFocused])

  useEffect(() => {
    if (
      (!showVariables && !terminalInputFocused) ||
      !namespaceRefreshQueued.current ||
      isSelectedKernelRunning ||
      isNamespaceLost ||
      isHistoricalEnvironmentView
    ) {
      return
    }
    namespaceRefreshQueued.current = false
    void loadLatestNamespace()
  }, [
    isHistoricalEnvironmentView,
    isNamespaceLost,
    isSelectedKernelRunning,
    notebookState,
    showVariables,
    terminalInputFocused
  ])

  const activeNamespaceSnapshot =
    !isNamespaceLost &&
    !isHistoricalEnvironmentView &&
    namespaceSnapshot &&
    `${namespaceSnapshot.language}:${namespaceSnapshot.environment}` === selectedTarget
      ? namespaceSnapshot
      : undefined
  const activeNamespaceStatus =
    isNamespaceLost || isHistoricalEnvironmentView ? 'unavailable' : namespaceStatus
  const suggestionVariables =
    activeNamespaceStatus === 'ready' ? (activeNamespaceSnapshot?.variables ?? []) : []
  const normalizedNamespaceFilter = namespaceFilter.trim().toLocaleLowerCase()
  const visibleNamespaceVariables = (activeNamespaceSnapshot?.variables ?? []).filter(
    (variable) =>
      !normalizedNamespaceFilter ||
      variable.name.toLocaleLowerCase().includes(normalizedNamespaceFilter) ||
      variable.type.toLocaleLowerCase().includes(normalizedNamespaceFilter)
  )
  const namespaceButtonDisabled =
    !activeDataLanguage ||
    !activeEnvName ||
    isNamespaceLost ||
    isHistoricalEnvironmentView ||
    isSelectedKernelRunning ||
    gated

  // Sends terminal code through the same notebook interpreter and history path as agent code.
  const submitTerminalCode = async (): Promise<void> => {
    const code = terminalCode.trim()

    if (!code || !activeDataLanguage || !activeEnvName || isHistoricalEnvironmentView) {
      return
    }

    const target = `${activeDataLanguage}:${activeEnvName}`
    setSubmittingTarget(target)
    setActionError(null)

    try {
      if (stateLoadInFlight.current && !(await stateLoadInFlight.current)) return
      const executionState = latestNotebookState.current
      if (executionState?.activeWrite || executionState?.activeRunId) return

      setTerminalCode('')
      await window.api.notebook.execute({
        ...createNotebookRequest(item.notebook),
        code,
        source: 'user',
        inputKind: 'terminal',
        language: activeDataLanguage
      })

      await loadNotebookState()
    } catch (error) {
      setTerminalCode(code)
      setActionError(getErrorMessage(error))
    } finally {
      setSubmittingTarget(undefined)
    }
  }

  const handleAbortWrite = async (): Promise<void> => {
    const write = notebookState?.activeWrite
    if (!write || isAbortingWrite) return
    setIsAbortingWrite(true)
    setActionError(null)
    try {
      await window.api.notebook.abortCodeCell({
        ...createNotebookRequest(item.notebook),
        cellId: write.cellId,
        writeId: write.writeId
      })
      await loadNotebookState()
    } catch (error) {
      await loadNotebookState()
      setActionError(getErrorMessage(error))
    } finally {
      setIsAbortingWrite(false)
    }
  }

  // Restarts only the selected R environment, then replaces state so its banner clears.
  const handleRestart = async (): Promise<void> => {
    if (!activeEnvName) return
    setIsRestarting(true)
    setActionError(null)
    namespaceRequestId.current += 1
    namespaceRefreshQueued.current = false
    namespaceLoadKey.current = undefined
    setNamespaceSnapshot(undefined)
    setNamespaceStatus('unavailable')
    try {
      const next = await window.api.notebook.restart({
        ...createNotebookRequest(item.notebook),
        language: 'r',
        environment: activeEnvName
      })
      namespaceRefreshQueued.current = showVariables
      applyNotebookState(next)
    } catch (error) {
      setActionError(getErrorMessage(error))
    } finally {
      setIsRestarting(false)
    }
  }
  const notebookCells = (
    <div
      ref={cellsViewportRef}
      className="h-full min-h-0 overflow-y-auto overscroll-contain"
      data-testid="notebook-cells"
    >
      <div className="divide-y divide-border-100">
        {visibleRuns.map((run, index) => {
          const staleness = visibleStalenessForRun(run)
          return (
            <NotebookRunCell
              key={run.runId}
              run={run}
              index={index}
              staleness={staleness}
              causedByRunIndex={
                staleness?.state === 'stale'
                  ? visibleRunIndexById.get(staleness.causedByRunId)
                  : undefined
              }
            />
          )
        })}
      </div>
    </div>
  )
  const namespaceView = (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col @min-[55rem]/notebook:basis-[40%] @min-[55rem]/notebook:grow-0 @min-[55rem]/notebook:border-l @min-[55rem]/notebook:border-border-200"
      data-testid="notebook-variables-view"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-100 px-3 py-2">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('Close')}
                onClick={() => setShowVariables(false)}
                className="inline-flex size-7 items-center justify-center rounded-md text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100"
                data-testid="notebook-variables-close"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="z-[70]">
              {t('Close')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div className="mr-auto min-w-0">
          <div className="text-xs font-medium text-text-100">{t('Variables')}</div>
          <div className="text-[11px] text-text-300">
            {activeNamespaceSnapshot
              ? t('Variables: {{count}}', {
                  count: activeNamespaceSnapshot.variableCount,
                  defaultValue_one: 'Variable: {{count}}'
                })
              : environmentLabel(activeEnvName ?? '')}
          </div>
        </div>
        <input
          type="search"
          value={namespaceFilter}
          onChange={(event) => setNamespaceFilter(event.target.value)}
          placeholder={t('Filter variables...')}
          aria-label={t('Filter variables')}
          className="h-7 min-w-32 flex-1 rounded-md border border-input bg-bg-000 px-2 text-xs text-text-100 outline-none placeholder:text-muted-foreground focus-visible:border-primary"
        />
        <label className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] text-text-200 hover:bg-bg-200">
          <input
            type="checkbox"
            checked={showPrivateVariables}
            onChange={(event) => setShowPrivateVariables(event.target.checked)}
            className="accent-primary"
          />
          {t('Show private variables')}
        </label>
        <button
          type="button"
          aria-label={t('Refresh variables')}
          disabled={namespaceButtonDisabled || activeNamespaceStatus === 'loading'}
          onClick={() => void loadNamespace()}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border-100 px-2 text-[11px] text-text-200 transition-colors hover:bg-bg-200 disabled:cursor-not-allowed disabled:opacity-45"
          data-testid="notebook-variables-refresh"
        >
          <RefreshCw
            className={cn(
              'size-3.5',
              (activeNamespaceStatus === 'loading' || activeNamespaceStatus === 'refreshing') &&
                'animate-spin'
            )}
            aria-hidden="true"
          />
          {t('Refresh')}
        </button>
      </div>

      {activeNamespaceStatus === 'stale' || activeNamespaceStatus === 'refreshing' ? (
        <div className="shrink-0 border-b border-border-100 bg-bg-200 px-3 py-1.5 text-[11px] text-text-200">
          {activeNamespaceStatus === 'refreshing'
            ? t('Variables changed. Refreshing...')
            : t('Variables may have changed.')}
        </div>
      ) : null}
      {activeNamespaceStatus === 'error' ? (
        <div className="shrink-0 border-b border-border-100 bg-danger-900 px-3 py-1.5 text-[11px] text-danger-000">
          {namespaceError ?? t('Could not inspect variables.')}
        </div>
      ) : null}
      {activeNamespaceSnapshot?.variablesTruncated ? (
        <div className="shrink-0 border-b border-border-100 bg-bg-200 px-3 py-1.5 text-[11px] text-text-200">
          {t('Only the first bounded set of variables is shown.')}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {!activeNamespaceSnapshot &&
        (activeNamespaceStatus === 'loading' || activeNamespaceStatus === 'empty') ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-text-300">
            {t('Reading live variables...')}
          </div>
        ) : activeNamespaceStatus === 'unavailable' ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
            <div className="text-xs font-medium text-text-100">{t('No live namespace')}</div>
            <div className="max-w-sm text-[11px] leading-5 text-text-300">
              {t('Run code with the agent to activate this kernel and create live variables.')}
            </div>
          </div>
        ) : activeNamespaceSnapshot && visibleNamespaceVariables.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-text-300">
            {normalizedNamespaceFilter
              ? t('No variables match this filter.')
              : t('This namespace has no variables.')}
          </div>
        ) : activeNamespaceSnapshot ? (
          <table className="w-full table-fixed border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-bg-000 text-[11px] text-text-300">
              <tr className="border-b border-border-100">
                <th className="w-[24%] px-3 py-2 font-medium">{t('Name')}</th>
                <th className="w-[24%] px-3 py-2 font-medium">{t('Type')}</th>
                <th className="w-[18%] px-3 py-2 font-medium">{t('Size / Shape')}</th>
                <th className="px-3 py-2 font-medium">{t('Preview')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleNamespaceVariables.map((variable, index) => (
                <tr
                  key={`${index}:${variable.name}`}
                  className="border-b border-border-100/70 align-top"
                >
                  <td className="break-all px-3 py-2 font-mono text-text-100">{variable.name}</td>
                  <td className="break-all px-3 py-2 font-mono text-text-200">{variable.type}</td>
                  <td className="break-words px-3 py-2 text-text-300">
                    {[variable.shape, formatNamespaceSize(variable.sizeBytes)]
                      .filter((value) => value && value !== '—')
                      .join(' · ') || '—'}
                  </td>
                  <td className="break-all px-3 py-2 font-mono text-text-200">
                    {variable.preview}
                    {variable.previewTruncated ? '…' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  )
  const notebookView =
    !activeDataLanguage || isNamespaceLost || isHistoricalEnvironmentView ? (
      <div className="min-h-0 flex-1 overflow-hidden">{notebookCells}</div>
    ) : (
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1 flex-col">
        <ResizablePanel
          id="notebook-cells-panel"
          defaultSize="80%"
          minSize="35%"
          className="min-h-0 overflow-hidden"
        >
          {notebookCells}
        </ResizablePanel>

        <ResizableHandle
          aria-label={t('Resize notebook and terminal')}
          className="z-10 shrink-0 border-y border-border-200 bg-bg-200/70 aria-[orientation=horizontal]:h-7 aria-[orientation=horizontal]:before:h-1 aria-[orientation=horizontal]:before:w-10 before:opacity-60 hover:before:opacity-100 focus-visible:before:opacity-100 data-[separator=active]:before:opacity-100"
        >
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-between gap-2 px-3 text-[11px] text-text-300"
            data-testid="notebook-terminal-header"
          >
            <span>
              {activeDataLanguage === 'r'
                ? t('R kernel · shared with the agent')
                : t('Python kernel · shared with the agent')}
            </span>
            <span>{isSelectedKernelRunning ? t('running') : t('idle')}</span>
          </div>
        </ResizableHandle>

        <ResizablePanel
          id="notebook-terminal-panel"
          defaultSize="20%"
          minSize="15%"
          className="min-h-0 overflow-hidden"
        >
          <div className="flex h-full min-h-0 flex-col bg-bg-000" data-testid="kernel-terminal">
            {actionError ? (
              <div className="border-b border-border-100/60 px-3 py-2 font-mono text-xs text-danger-000">
                {actionError}
              </div>
            ) : null}
            <TerminalScrollback
              runs={visibleRuns}
              language={activeDataLanguage}
              viewportRef={terminalViewportRef}
            />
            <TerminalInput
              code={terminalCode}
              disabled={isTerminalLocked}
              language={activeDataLanguage}
              variables={suggestionVariables}
              onChange={setTerminalCode}
              onFocusChange={setTerminalInputFocused}
              onSubmit={() => {
                void submitTerminalCode()
              }}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    )
  const initialStateError = !notebookState && actionError

  return (
    <section
      className="@container/notebook relative flex h-full min-w-0 flex-col overflow-hidden bg-bg-000"
      data-testid="kernel-notebook-pane"
    >
      {gated ? (
        <EnvProvisionOverlay ui={provisionUi} onRetry={() => void retryProvision()} />
      ) : null}
      {frameOptions.length > 0 ? (
        <div className="flex max-w-full shrink-0 items-center gap-2 overflow-hidden border-b border-border-100 px-2 py-1.5">
          <label
            htmlFor={`notebook-preview-frame-filter-${item.notebook.sessionId}`}
            className="shrink-0 text-xs text-text-300"
          >
            {t('Agent')}
          </label>
          <Select
            value={effectiveFrameFilter ?? ''}
            onValueChange={(value) => setFrameFilter(value as NotebookFrameFilterValue)}
          >
            <SelectTrigger
              id={`notebook-preview-frame-filter-${item.notebook.sessionId}`}
              aria-label={t('Filter notebook runs by Agent')}
              title={frameOptions.find(({ value }) => value === effectiveFrameFilter)?.label}
              className="min-w-0 max-w-full flex-1 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {frameOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label} ·{' '}
                  {t('{{count}} runs', {
                    defaultValue_one: '{{count}} run',
                    count: option.count
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <header
        className="flex shrink-0 items-center border-b border-border-100 px-2 py-1.5"
        data-testid="kernel-switcher"
      >
        <div
          ref={kernelScrollFadeRef}
          className="scroll-fade-x flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
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
                {isPreparingR ? t('R (preparing…)') : 'R'}
              </button>
            ) : (
              <button
                key={kind}
                type="button"
                data-testid={`kernel-switcher-${kind}`}
                onClick={() => {
                  setShowVariables(false)
                  setActiveKind(kind)
                }}
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
        {activeDataLanguage ? (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t('Inspect variables')}
                  aria-pressed={showVariables}
                  aria-disabled={namespaceButtonDisabled}
                  onClick={() => {
                    if (!namespaceButtonDisabled) setShowVariables((current) => !current)
                  }}
                  className={cn(
                    'ml-2 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-300 transition-colors',
                    showVariables && !namespaceButtonDisabled
                      ? 'bg-bg-300 text-text-000'
                      : 'hover:bg-bg-200 hover:text-text-100',
                    namespaceButtonDisabled && 'cursor-not-allowed opacity-45'
                  )}
                  data-testid="notebook-variables-button"
                >
                  <Variable className="size-3.5" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {isSelectedKernelRunning
                  ? t('Variables are available when this kernel is idle')
                  : isNamespaceLost || isHistoricalEnvironmentView
                    ? t('Variables are available only while this kernel is live')
                    : t('Inspect variables')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        {activeRuntimeBinding && activeRuntimeDetails ? (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={
                    activeRuntimeSettingsLabel
                      ? `${activeRuntimeDetails}. ${activeRuntimeSettingsLabel}`
                      : activeRuntimeDetails
                  }
                  onClick={() => {
                    if (activeRuntimeUnavailable) openSettingsToPanel('runtimes')
                  }}
                  className={cn(
                    'ml-2 flex min-w-0 max-w-56 shrink-0 items-center gap-1.5 rounded-md bg-bg-300 px-2 py-1 text-[11px] text-text-200',
                    activeRuntimeUnavailable &&
                      'bg-status-failure-surface text-status-failure-foreground dark:bg-status-failure-dark-surface dark:text-status-failure-dark-foreground'
                  )}
                  data-testid="notebook-runtime-binding"
                >
                  <span className="min-w-0 truncate">{activeRuntimeBinding.label}</span>
                  {activeRuntimeUnavailable ? (
                    <span
                      className="shrink-0 font-medium"
                      data-testid="notebook-runtime-binding-status"
                    >
                      {t('Unavailable')}
                    </span>
                  ) : null}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[320px] break-words">
                <div>{activeRuntimeDetails}</div>
                {activeRuntimeSettingsLabel ? <div>{activeRuntimeSettingsLabel}</div> : null}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </header>

      {showEnvSelector ? (
        <div
          ref={environmentScrollFadeRef}
          className="scroll-fade-x flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto border-b border-border-100 px-2 py-1"
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

      {notebookState?.activeWrite ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-100 bg-bg-300 px-3 py-1.5 text-[11px] text-text-100">
          <span>{t('Receiving code. Cancelling discards the unfinished code.')}</span>
          <button
            type="button"
            disabled={isAbortingWrite}
            onClick={() => void handleAbortWrite()}
            className="shrink-0 rounded-md border border-border-200 px-2 py-0.5 font-medium text-text-100 transition-colors hover:bg-bg-200 disabled:opacity-50"
          >
            {t('Cancel code reception')}
          </button>
        </div>
      ) : null}

      {restartRecommended ? (
        <div
          className="flex shrink-0 items-center justify-between gap-2 border-b border-border-100 bg-bg-300 px-3 py-1.5 text-[11px] text-text-100"
          data-testid="r-restart-banner"
        >
          <span>{t('Installed R packages need a kernel restart to load.')}</span>
          <button
            type="button"
            disabled={isRestarting}
            onClick={() => void handleRestart()}
            className="shrink-0 rounded-md border border-border-200 px-2 py-0.5 font-medium text-text-100 transition-colors hover:bg-bg-200 disabled:opacity-50"
            data-testid="r-restart-button"
          >
            {isRestarting ? t('Restarting…') : t('Restart R kernel')}
          </button>
        </div>
      ) : null}

      {initialStateError ? (
        <div
          role="alert"
          className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6"
          data-testid="notebook-state-load-error"
        >
          <ErrorNotice
            icon={TriangleAlert}
            tone="amber"
            description={initialStateError}
            primaryButton={{
              label: t('Retry'),
              onClick: () => void loadNotebookState(),
              loading: isLoading
            }}
          />
        </div>
      ) : (
        <div
          className="flex min-h-0 flex-1"
          data-testid={
            showVariables && activeDataLanguage ? 'notebook-responsive-variables-layout' : undefined
          }
        >
          <div
            className={cn(
              'min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
              showVariables && activeDataLanguage ? 'hidden @min-[55rem]/notebook:flex' : 'flex'
            )}
            data-testid="notebook-primary-view"
          >
            {notebookView}
          </div>
          {showVariables && activeDataLanguage ? namespaceView : null}
        </div>
      )}

      {!initialStateError && !showVariables && (isNamespaceLost || isHistoricalEnvironmentView) ? (
        <footer
          className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-border-200 bg-bg-000 px-2 text-[11px] text-text-300"
          data-testid="notebook-read-only-status"
        >
          <span className="min-w-0 truncate">
            {isHistoricalEnvironmentView
              ? t('{{environment}} · history only; new code runs in {{activeEnvironment}}', {
                  environment: activeEnvName,
                  activeEnvironment: executionEnvironment
                })
              : isKernelInactive && !hasActiveKernelHistory
                ? t('{{kernel}} · view only; the agent must activate this kernel first', {
                    kernel: activeDataLanguage === 'r' ? 'R' : 'Python'
                  })
                : activeDataLanguage === 'r'
                  ? t("R · view only; this kernel's namespace no longer exists")
                  : t("Python · view only; this kernel's namespace no longer exists")}
          </span>
          <span className="shrink-0 tabular-nums">
            {t('{{count}} cells', {
              defaultValue_one: '{{count}} cell',
              count: cellCount
            })}
          </span>
        </footer>
      ) : null}
    </section>
  )
}

export { NotebookPreview }
