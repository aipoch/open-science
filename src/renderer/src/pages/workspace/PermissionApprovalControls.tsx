import { Check, ChevronDown, ChevronRight, Info } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { AcpPermissionRequest } from '../../../../shared/acp'
import type { NotebookSessionRequest } from '../../../../shared/notebook'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { dialogTitleClassName } from '@/components/ui/dialog-chrome'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { resolveNotebookLanguage, resolveNotebookRunToolName } from './notebook-tool-names'
import { WorkspaceToolCodeBlock } from './WorkspaceToolCodeBlock'

type PermissionApprovalControlsProps = {
  requests: AcpPermissionRequest[]
  onRespond: (requestId: string, optionId?: string) => void
  // Session locator for the notebook env badge; optional so the controls render standalone
  // (isolation tests, sessions without notebook context).
  notebookLookup?: NotebookSessionRequest
}

type PermissionOption = AcpPermissionRequest['options'][number]
type PermissionScope = 'once' | 'conversation'

type ScopeOption = { scope: PermissionScope; label: string; subtitle: string }

const SCOPE_OPTIONS: ScopeOption[] = [
  { scope: 'once', label: 'Once', subtitle: 'This call only' },
  { scope: 'conversation', label: 'This conversation', subtitle: 'Until this chat ends' }
]

// The ACP option kind that backs each scope. A scope is only offered when the request
// actually carries that exact kind — we never substitute one for the other, since that
// would grant a wider (or narrower) permission than the label promises.
const SCOPE_KIND: Record<PermissionScope, string> = {
  once: 'allow_once',
  conversation: 'allow_always'
}

// The subset of scopes the request can actually satisfy, derived from its exact option kinds.
const getAvailableScopes = (options: PermissionOption[]): Set<PermissionScope> => {
  const kinds = new Set(options.map((o) => o.kind.toLowerCase()))
  const scopes = new Set<PermissionScope>()
  if (kinds.has(SCOPE_KIND.once)) scopes.add('once')
  if (kinds.has(SCOPE_KIND.conversation)) scopes.add('conversation')
  return scopes
}

// Returns the optionId for Allow at the chosen scope — matched by exact kind only, no fallback.
const getAllowOptionId = (
  options: PermissionOption[],
  scope: PermissionScope
): string | undefined => options.find((o) => o.kind.toLowerCase() === SCOPE_KIND[scope])?.optionId

// Returns the optionId to use for Deny, or undefined to cancel. Prefer the one-time reject so a
// single Deny never silently applies a permanent `reject_always` just because the provider listed
// it first; fall back to any reject kind only when reject_once is absent.
const getDenyOptionId = (options: PermissionOption[]): string | undefined =>
  options.find((o) => o.kind.toLowerCase() === 'reject_once')?.optionId ??
  options.find((o) => o.kind.toLowerCase().startsWith('reject_'))?.optionId

// The optionIds the Allow split-button can reach across both scopes (allow_once + allow_always).
// The scope toggle chooses between them, so both count as reachable for the extra-options diff.
const allowOptionIds = (options: PermissionOption[]): string[] =>
  (['once', 'conversation'] as const)
    .map((scope) => getAllowOptionId(options, scope))
    .filter((id): id is string => id !== undefined)

// Options the primary Allow/Deny controls can't reach, rendered as their own labeled buttons so a
// protocol-offered choice is never silently dropped (which would leave Allow disabled and Deny
// sending cancel). Reachable = both Allow scopes + the single reject the Deny control sends. So an
// extra is a non-canonical kind, a SECOND same-scope allow option (e.g. two allow_always with
// different provider scopes), or an unrepresented reject option (e.g. reject_always when Deny sent
// reject_once) — all kept selectable.
const getExtraOptions = (
  options: PermissionOption[],
  reachableAllowIds: string[],
  denyOptionId: string | undefined
): PermissionOption[] => {
  const reachable = new Set<string>(reachableAllowIds)
  if (denyOptionId) reachable.add(denyOptionId)
  return options.filter((o) => !reachable.has(o.optionId))
}

// Canonical, protocol-derived action word for a known option kind; undefined for unknown kinds.
// The kind is trusted protocol semantics; the provider-supplied name is NOT, so an untrusted
// allow_always named "Reject" must still read as an Allow action.
const CANONICAL_ACTION_LABEL: Record<string, string> = {
  allow_once: 'Allow once',
  allow_always: 'Allow always',
  reject_once: 'Reject once',
  reject_always: 'Reject always'
}

// Label for an extra-option button. For a known kind, use the canonical action word and append the
// provider name only to disambiguate (never as the action itself). For an unknown kind, the
// provider name is all we have, so show it verbatim.
const getExtraOptionLabel = (option: PermissionOption): string => {
  const canonical = CANONICAL_ACTION_LABEL[option.kind.toLowerCase()]
  if (!canonical) return option.name
  const provider = option.name.trim()
  return provider && provider.toLowerCase() !== canonical.toLowerCase()
    ? `${canonical} · ${provider}`
    : canonical
}

type PermissionCode = { code: string; language?: string }

// Whether a tool is one of the notebook server's kernel-run tools whose input we can preview as
// code. Requiring the notebook server segment (not just the suffix) keeps a lookalike tool from
// another MCP server — e.g. a `notebook_execute` that takes a production target — on the generic
// JSON path so all its arguments stay reviewable. Shared with the transcript renderer.
// Resolves a request's notebook tool name from EITHER identity field. The broker can send a
// namespaced title (mcp.open-science-notebook.notebook_execute) alongside a bare leaf
// providerToolName (notebook_execute); only the namespaced field carries the server segment the
// identity check needs, so we return whichever field matches (or undefined for non-notebook tools).
const resolveNotebookToolName = (request: AcpPermissionRequest): string | undefined =>
  resolveNotebookRunToolName(request.providerToolName, request.title)

// Derives displayable code and language from the tool's raw input.
const extractPermissionCode = (request: AcpPermissionRequest): PermissionCode | undefined => {
  const raw = request.rawInput
  const rawInput =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}

  const isExecute = request.toolKind === 'execute' || request.providerToolName === 'Bash'

  // Notebook / kernel execute: check code > command > script. Preserve the value verbatim —
  // this is the exact code about to run, so leading indentation / trailing newlines must not
  // be stripped from what the user reviews. Checked before the execute branch because notebook
  // runs also report kind:execute, and their namespaced identity may live only in `title`.
  const notebookToolName = resolveNotebookToolName(request)
  if (notebookToolName) {
    const input =
      rawInput.arguments &&
      typeof rawInput.arguments === 'object' &&
      !Array.isArray(rawInput.arguments)
        ? (rawInput.arguments as Record<string, unknown>)
        : rawInput
    for (const key of ['code', 'command', 'script'] as const) {
      const v = input[key]
      if (typeof v === 'string' && v.trim()) {
        return { code: v, language: resolveNotebookLanguage(notebookToolName, input, v) }
      }
    }
    // No code field present; return nothing rather than showing raw kernel metadata as JSON.
    return undefined
  }

  // Shell execute (Bash tool): prefer the structured command field (verbatim), but fall back to
  // the request title so the full command stays inspectable even when rawInput is absent (the
  // command may live only in title). Only trust title-as-bash for providerToolName === 'Bash';
  // other MCP execute tools (arbitrary servers, diverse semantics) must not assume shell syntax.
  if (isExecute) {
    const cmd = rawInput.command
    if (typeof cmd === 'string' && cmd.trim()) return { code: cmd, language: 'bash' }
    if (request.providerToolName === 'Bash' && request.title?.trim()) {
      return { code: request.title, language: 'bash' }
    }
  }

  // All other tools: pretty-print input as JSON.
  try {
    const serialized = JSON.stringify(rawInput, null, 2)
    if (serialized && serialized !== '{}') return { code: serialized, language: 'json' }
  } catch {
    /* non-serializable */
  }

  return undefined
}

// A friendly action title for the code card header, matching the transcript's activity phrasing.
const getPermissionActionTitle = (request: AcpPermissionRequest): string => {
  if (resolveNotebookToolName(request)) return 'Run notebook cell'
  if (request.toolKind === 'execute' || request.providerToolName === 'Bash') return 'Run command'
  return request.providerToolName ?? request.title
}

// Activity-style collapsible card that shows the code about to run, defaulting to expanded.
const PermissionCodeSection = ({
  title,
  code,
  language
}: PermissionCode & { title: string }): React.JSX.Element => {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className="w-full overflow-hidden rounded-lg bg-muted/60 px-2 py-1.5">
      <button
        type="button"
        data-testid="permission-code-toggle"
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-[13px] transition-colors hover:bg-muted"
        onClick={() => setExpanded((e) => !e)}
      >
        <span
          className={cn(
            'inline-flex w-4 shrink-0 items-center justify-center text-muted-foreground transition-transform duration-200',
            expanded && 'rotate-90'
          )}
        >
          <ChevronRight className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
        </span>
        <span className="min-w-0 truncate text-left font-medium text-foreground">{title}</span>
        {language ? (
          <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground">
            {language}
          </span>
        ) : null}
      </button>
      {expanded && (
        <div className="mx-1 mb-1.5 md:ml-[30px]">
          <WorkspaceToolCodeBlock code={code} language={language} copyable />
        </div>
      )}
    </div>
  )
}

const getPermissionRiskLabel = (request: AcpPermissionRequest): string => {
  // Route via the shared identity check (both fields) so the badge agrees with the code-card
  // header for real requests — the server segment may live only in the namespaced title while
  // providerToolName carries the bare leaf name.
  if (resolveNotebookToolName(request)) return 'Notebook execution'
  if (request.isMcp) return 'MCP tool access'

  switch (request.toolKind) {
    case 'execute':
      return 'Command execution'
    case 'edit':
    case 'delete':
    case 'move':
      return 'File change'
    case 'fetch':
      return 'Network access'
    case 'read':
    case 'search':
      return 'File access'
    default:
      return 'Tool access'
  }
}

// Per-session env-name lookups, cached so every prompt in the same chat reuses a single read.
// Keyed by sessionId + kernel kind so a python badge and an R badge never share a stale answer.
const notebookEnvCache = new Map<string, Promise<string | undefined>>()

// Resolves the environment a session's notebook kernels run in: prefer the live kernel matching
// the requested kind, then any live env, then the most recent run's recorded env. Sessions that
// never touched the notebook (or have no bridge in tests) resolve to undefined — no badge.
const lookupNotebookEnvironment = async (
  request: NotebookSessionRequest,
  kernelKind: 'python' | 'r'
): Promise<string | undefined> => {
  const api = window.api?.notebook
  if (!api) return undefined
  try {
    const state = await api.state(request)
    const live =
      state.environments.find((e) => e.kind === kernelKind && e.environment)?.environment ??
      state.environments.find((e) => e.environment)?.environment
    if (live) return live
    for (let i = state.runs.length - 1; i >= 0; i -= 1) {
      const env = state.runs[i].environment
      if (env) return env
    }
  } catch {
    /* no notebook for this session yet */
  }
  return undefined
}

const useNotebookEnvironment = (
  lookup: NotebookSessionRequest | undefined,
  kernelKind: 'python' | 'r' | undefined
): string | undefined => {
  const [envName, setEnvName] = useState<string | undefined>()
  const lookupKey = lookup ? `${lookup.projectName ?? ''}:${lookup.sessionId}` : undefined
  useEffect(() => {
    if (!lookup || !lookupKey || !kernelKind) return
    let cancelled = false
    const key = `${lookupKey}:${kernelKind}`
    let cached = notebookEnvCache.get(key)
    if (!cached) {
      cached = lookupNotebookEnvironment(lookup, kernelKind)
      notebookEnvCache.set(key, cached)
    }
    void cached.then((name) => {
      if (!cancelled) setEnvName(name)
    })
    return () => {
      cancelled = true
    }
    // lookup is a fresh object per render; the primitive key is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupKey, kernelKind])
  return kernelKind ? envName : undefined
}

// Header cluster for notebook prompts: kernel-language badge, the session's bound environment
// (once the runtime has spawned or recorded one), and an info tooltip explaining where the code
// runs and what an approval covers, with the raw tool identity kept reachable now that the header
// shows a friendly question instead of the tool name.
const NotebookHeaderBadges = ({
  lookup,
  language,
  riskLabel,
  rawIdentity
}: {
  lookup: NotebookSessionRequest | undefined
  language: string
  riskLabel: string
  rawIdentity: string | undefined
}): React.JSX.Element => {
  const kernelKind = language === 'python' ? 'python' : language === 'r' ? 'r' : undefined
  const envName = useNotebookEnvironment(lookup, kernelKind)

  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5">
      <Badge variant="secondary" data-testid="permission-language-badge">
        {language}
      </Badge>
      {envName ? (
        <Badge variant="secondary" data-testid="permission-env-badge">
          {envName}
        </Badge>
      ) : null}
      {rawIdentity ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Tool details"
                data-testid="permission-tool-info"
                className="flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Info className="size-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-72 whitespace-normal">
              <span className="block">
                {riskLabel}. Runs in this session&apos;s notebook runtime
                {envName ? ` (${envName})` : ''}; allowing for this conversation auto-approves later
                calls to this tool without asking again.
              </span>
              <span className="mt-0.5 block break-all opacity-70">{rawIdentity}</span>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
    </span>
  )
}

// Popover listing the two available scope choices.
const ScopeDropdown = ({
  selected,
  available,
  onSelect,
  onClose
}: {
  selected: PermissionScope
  available: Set<PermissionScope>
  onSelect: (scope: PermissionScope) => void
  onClose: (restoreTriggerFocus?: boolean) => void
}): React.JSX.Element => {
  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const options = SCOPE_OPTIONS.filter(({ scope }) => available.has(scope))

  useEffect(() => {
    itemRefs.current[options.findIndex(({ scope }) => scope === selected)]?.focus()
  }, [options, selected])

  useEffect(() => {
    // Listen on `click` (not `mousedown`) so it pairs with the chevron's onClick toggle: the
    // chevron stops propagation, so its own click never reaches here and re-opens the menu.
    const onDocClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    // Escape dismisses the menu, matching the keyboard affordance implied by aria-haspopup.
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose(true)
      }
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Authorization scope"
      className="absolute bottom-full right-0 z-10 mb-1.5 min-w-44 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-menu outline-none"
    >
      {options.map(({ scope, label, subtitle }, index) => (
        <button
          key={scope}
          ref={(item) => {
            itemRefs.current[index] = item
          }}
          type="button"
          role="menuitemradio"
          aria-checked={selected === scope}
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted',
            selected === scope && 'bg-muted'
          )}
          onClick={() => {
            onSelect(scope)
            onClose()
          }}
          onKeyDown={(event) => {
            const lastIndex = options.length - 1
            let nextIndex: number | undefined

            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onSelect(scope)
              onClose()
              return
            }
            if (event.key === 'ArrowDown') nextIndex = index === lastIndex ? 0 : index + 1
            if (event.key === 'ArrowUp') nextIndex = index === 0 ? lastIndex : index - 1
            if (event.key === 'Home') nextIndex = 0
            if (event.key === 'End') nextIndex = lastIndex

            if (nextIndex !== undefined) {
              event.preventDefault()
              itemRefs.current[nextIndex]?.focus()
            }
          }}
        >
          {/* Label column: left-aligned flush to padding so both rows line up */}
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-xs font-medium text-foreground">{label}</span>
            <span className="text-[11px] leading-tight text-muted-foreground">{subtitle}</span>
          </div>
          {/* Check column: right side, fixed slot so selection never shifts the label */}
          <span className="flex w-3.5 shrink-0 justify-center text-primary">
            {selected === scope ? <Check className="size-3.5" strokeWidth={2.5} /> : null}
          </span>
        </button>
      ))}
    </div>
  )
}

const PermissionApprovalControls = ({
  requests,
  onRespond,
  notebookLookup
}: PermissionApprovalControlsProps): React.JSX.Element | null => {
  const [scope, setScope] = useState<PermissionScope>('conversation')
  const [scopeOpen, setScopeOpen] = useState(false)
  const scopeTriggerRef = useRef<HTMLButtonElement>(null)
  const closeScopeMenu = useCallback((restoreTriggerFocus = false) => {
    setScopeOpen(false)
    if (restoreTriggerFocus) queueMicrotask(() => scopeTriggerRef.current?.focus())
  }, [])

  // Show only the oldest pending request; the rest stay queued.
  const request = requests[0]

  // Default the primary Allow action to the WIDEST in-session scope the request offers
  // ('conversation', backed by allow_always), so a repeated tool doesn't re-prompt on every
  // call. Narrowing to a one-time approval ('once') is an explicit choice via the scope menu.
  const availableScopes = request ? getAvailableScopes(request.options) : new Set<PermissionScope>()
  const defaultScope: PermissionScope = availableScopes.has('conversation')
    ? 'conversation'
    : 'once'

  // Reset per-request UI state (scope + open menu) whenever the displayed request changes,
  // so nothing leaks from the previously answered prompt.
  const requestId = request?.requestId
  const [lastRequestId, setLastRequestId] = useState(requestId)
  if (lastRequestId !== requestId) {
    setLastRequestId(requestId)
    setScope(defaultScope)
    setScopeOpen(false)
  }

  if (!request) return null

  // Guard against a stale scope no longer offered by the current request.
  const effectiveScope = availableScopes.has(scope) ? scope : defaultScope
  const permCode = extractPermissionCode(request)
  const allowOptionId = getAllowOptionId(request.options, effectiveScope)
  const denyOptionId = getDenyOptionId(request.options)
  const scopeLabel = effectiveScope === 'once' ? 'for this call only' : 'for this conversation'

  // Any option the Allow (either scope) / Deny controls can't reach — a non-canonical protocol
  // kind, or a second same-kind option — is surfaced as its own labeled button so a
  // protocol-offered choice is never silently discarded. See getExtraOptions.
  const extraOptions = getExtraOptions(
    request.options,
    allowOptionIds(request.options),
    denyOptionId
  )

  // Header asks a friendly action question; raw tool identifiers (namespaced MCP names like
  // mcp__open-science-notebook__notebook_execute) are illegible in a sentence, so notebook and
  // shell runs get plain-language phrasing. The provider name only heads the prompt for other
  // tools, where it is typically a short readable name (Write, Edit). MCP requests are never
  // collapsed into the shell wording: the broker preserves MCP identity even for kind:'execute'
  // tools (e.g. open-science-artifacts_write_artifact_file), and the provider/title is the only
  // place that identity stays visible when there is no code preview.
  const notebookToolName = resolveNotebookToolName(request)
  const isNotebook = notebookToolName !== undefined
  const isShell =
    request.isMcp !== true &&
    (request.toolKind === 'execute' || request.providerToolName === 'Bash')
  const headerTitle = isNotebook
    ? 'Run notebook code?'
    : isShell
      ? 'Run command?'
      : `Run ${request.providerToolName ?? request.title}?`

  // The title often carries the actual target (e.g. provider "Write" with title
  // "Write report.md"). Surface it as a detail line when it adds information the header
  // doesn't, and isn't already shown verbatim by the code card. Skipped for notebook
  // prompts: there the title is just the tool identifier. For shell prompts the header is
  // generic ("Run command?"), so when no code preview renders the command — e.g. a non-Bash
  // execute request whose command lives only in the title — the title must stay visible,
  // otherwise the user approves an opaque execution request.
  const headerName = request.providerToolName ?? request.title
  const titleDetail = ((): string | undefined => {
    if (isNotebook || !request.title || request.title === permCode?.code) return undefined
    if (isShell) {
      return !permCode && request.title !== request.providerToolName ? request.title : undefined
    }
    return request.title !== headerName ? request.title : undefined
  })()

  // Kernel language for the notebook header badge: the code preview's language when there is one,
  // otherwise resolved from the tool identity alone (repl/bash suffixes, python default), so the
  // badge always agrees with what the code block would highlight.
  const permLanguage = notebookToolName
    ? (permCode?.language ?? resolveNotebookLanguage(notebookToolName, undefined, undefined))
    : undefined

  return (
    <div className="mb-2 flex w-full max-w-full flex-col gap-4 rounded-xl border border-border bg-card p-5 text-xs leading-5 text-card-foreground shadow-dialog outline-none motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200">
      {/* Header: action question + risk label (notebook prompts get language/env badges + tooltip) */}
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn(dialogTitleClassName, 'min-w-0 truncate')}>{headerTitle}</span>
        {notebookToolName && permLanguage ? (
          <NotebookHeaderBadges
            lookup={notebookLookup}
            language={permLanguage}
            riskLabel={getPermissionRiskLabel(request)}
            rawIdentity={request.providerToolName ?? request.title}
          />
        ) : (
          <Badge variant="secondary" className="ml-auto">
            {getPermissionRiskLabel(request)}
          </Badge>
        )}
      </div>

      {/* Full request title (the target being authorized) when the header alone doesn't show it. */}
      {titleDetail ? (
        <div className="break-all text-xs text-muted-foreground">{titleDetail}</div>
      ) : null}

      {/* Affected file targets — the canonical location field, shown so read/edit/delete
          prompts always reveal the path being authorized. Wraps to keep full values readable. */}
      {request.toolLocations?.length ? (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 break-all text-xs text-muted-foreground">
          {request.toolLocations.map((location) => (
            <span key={location.path}>{location.path}</span>
          ))}
        </div>
      ) : null}

      {/* Activity-style card showing the code that will run.
          Keyed by requestId so the collapsed/expanded state never carries over between prompts. */}
      {permCode && (
        <PermissionCodeSection
          key={requestId}
          title={getPermissionActionTitle(request)}
          code={permCode.code}
          language={permCode.language}
        />
      )}

      {/* Allow / Deny button row; wraps so long provider-supplied option labels can never
          push the primary Allow/Deny controls out of view. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* Split Allow button: main action + scope chevron; the menu anchors to this group's right edge.
            Styled like the shared Button (default size, including flex centering so the label baseline
            matches the neighboring Button primitives) but kept as two segments so the chevron
            stays a separate tab stop with its own aria-haspopup semantics. */}
        <div className="relative flex items-stretch overflow-visible rounded-lg">
          {scopeOpen && (
            <ScopeDropdown
              selected={effectiveScope}
              available={availableScopes}
              onSelect={setScope}
              onClose={closeScopeMenu}
            />
          )}
          <div className="flex items-stretch overflow-hidden rounded-lg">
            <button
              type="button"
              data-testid="allow-primary"
              className="inline-flex h-8 select-none items-center justify-center whitespace-nowrap bg-primary px-3 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
              disabled={!allowOptionId}
              onClick={() => {
                if (allowOptionId) onRespond(request.requestId, allowOptionId)
              }}
            >
              Allow {scopeLabel}
            </button>
            <div className="w-px bg-primary-foreground/25" />
            <button
              ref={scopeTriggerRef}
              type="button"
              data-testid="scope-chevron"
              aria-label="Choose authorization scope"
              aria-expanded={scopeOpen}
              aria-haspopup="menu"
              className="inline-flex h-8 select-none items-center justify-center bg-primary px-2 text-primary-foreground outline-none transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={(e) => {
                // Stop propagation so this click doesn't reach the dropdown's document
                // click-listener and immediately re-close the menu it just opened.
                e.stopPropagation()
                setScopeOpen((o) => !o)
              }}
            >
              <ChevronDown className="size-4" />
            </button>
          </div>
        </div>
        {/* Fallback buttons for any protocol option the Allow/Deny controls can't reach, so an
            unrecognized or ambiguous same-kind option stays selectable rather than disappearing.
            Provider-controlled labels can be long: override the Button's shrink-0/whitespace-nowrap
            so the label wraps inside the card instead of overflowing it. */}
        {extraOptions.map((option) => (
          <Button
            key={option.optionId}
            type="button"
            variant="outline"
            data-testid="extra-option"
            className="h-auto min-h-8 min-w-0 max-w-full shrink whitespace-normal break-words py-1"
            onClick={() => onRespond(request.requestId, option.optionId)}
          >
            {getExtraOptionLabel(option)}
          </Button>
        ))}
        <Button
          type="button"
          variant="outline"
          data-testid="deny-button"
          className="px-4"
          onClick={() => onRespond(request.requestId, denyOptionId)}
        >
          Deny
        </Button>
      </div>
    </div>
  )
}

export { PermissionApprovalControls }
