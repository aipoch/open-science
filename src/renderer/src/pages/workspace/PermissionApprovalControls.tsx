import { Check, ChevronDown, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { AcpPermissionRequest } from '../../../../shared/acp'
import { cn } from '@/lib/utils'
import { resolveNotebookLanguage, resolveNotebookRunToolName } from './notebook-tool-names'
import { WorkspaceToolCodeBlock } from './WorkspaceToolCodeBlock'

type PermissionApprovalControlsProps = {
  requests: AcpPermissionRequest[]
  onRespond: (requestId: string, optionId?: string) => void
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
    <div className="w-full overflow-hidden rounded-[14px] bg-bg-200/70 px-1.5 py-1">
      <button
        type="button"
        data-testid="permission-code-toggle"
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded-lg py-[5px] pl-1.5 pr-2.5 text-[13px] transition-colors hover:bg-bg-300"
        onClick={() => setExpanded((e) => !e)}
      >
        <span
          className={cn(
            'inline-flex w-4 shrink-0 items-center justify-center text-text-100 transition-transform duration-200',
            expanded && 'rotate-90'
          )}
        >
          <ChevronRight className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
        </span>
        <span className="min-w-0 truncate text-left font-medium text-text-000">{title}</span>
        {language ? (
          <span className="ml-auto shrink-0 whitespace-nowrap text-[12px] text-text-100">
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
      className="absolute bottom-full right-0 z-10 mb-1 min-w-[216px] rounded-lg border border-border-200 bg-bg-000 p-1 shadow-md"
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
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-bg-200',
            selected === scope && 'bg-bg-100'
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
            <span className="text-[12px] font-medium text-text-000">{label}</span>
            <span className="text-[11px] leading-tight text-text-300">{subtitle}</span>
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
  onRespond
}: PermissionApprovalControlsProps): React.JSX.Element | null => {
  const [scope, setScope] = useState<PermissionScope>('once')
  const [scopeOpen, setScopeOpen] = useState(false)
  const scopeTriggerRef = useRef<HTMLButtonElement>(null)
  const closeScopeMenu = useCallback((restoreTriggerFocus = false) => {
    setScopeOpen(false)
    if (restoreTriggerFocus) queueMicrotask(() => scopeTriggerRef.current?.focus())
  }, [])

  // Show only the oldest pending request; the rest stay queued.
  const request = requests[0]

  // Default the primary Allow action to the NARROWEST scope the request offers, so the single
  // easiest click grants the least standing access (a one-time approval). Widening to
  // 'conversation' (allow_always) requires an explicit choice via the scope menu.
  const availableScopes = request ? getAvailableScopes(request.options) : new Set<PermissionScope>()
  const defaultScope: PermissionScope = availableScopes.has('once') ? 'once' : 'conversation'

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

  // The header shows the provider name; the title often carries the actual target (e.g. provider
  // "Write" with title "Write report.md"). Surface the title as a detail line when it adds
  // information the header doesn't, and isn't already shown verbatim by the code card.
  const headerName = request.providerToolName ?? request.title
  const titleDetail =
    request.title && request.title !== headerName && request.title !== permCode?.code
      ? request.title
      : undefined

  return (
    <div className="mb-2 w-full max-w-full rounded-lg border border-border-200 bg-bg-000 px-3 py-2 text-[12px] leading-5 text-text-000 shadow-sm">
      {/* Header: tool name + risk label */}
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <span className="font-semibold truncate">
          Run {request.providerToolName ?? request.title}?
        </span>
        <span className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] bg-bg-100 text-text-300">
          {getPermissionRiskLabel(request)}
        </span>
      </div>

      {/* Full request title (the target being authorized) when the header alone doesn't show it. */}
      {titleDetail ? (
        <div className="mb-2 break-all text-[11px] text-text-300">{titleDetail}</div>
      ) : null}

      {/* Affected file targets — the canonical location field, shown so read/edit/delete
          prompts always reveal the path being authorized. Wraps to keep full values readable. */}
      {request.toolLocations?.length ? (
        <div className="mb-2 flex flex-wrap gap-x-2 gap-y-0.5 break-all text-[11px] text-text-300">
          {request.toolLocations.map((location) => (
            <span key={location.path}>{location.path}</span>
          ))}
        </div>
      ) : null}

      {/* Activity-style card showing the code that will run */}
      {permCode && (
        <div className="mb-2">
          {/* Keyed by requestId so the collapsed/expanded state never carries over between prompts. */}
          <PermissionCodeSection
            key={requestId}
            title={getPermissionActionTitle(request)}
            code={permCode.code}
            language={permCode.language}
          />
        </div>
      )}

      {/* Allow / Deny button row */}
      <div className="flex items-center justify-end gap-2">
        {/* Split Allow button: main action + scope chevron; the menu anchors to this group's right edge */}
        <div className="relative flex items-stretch overflow-visible rounded-md">
          {scopeOpen && (
            <ScopeDropdown
              selected={effectiveScope}
              available={availableScopes}
              onSelect={setScope}
              onClose={closeScopeMenu}
            />
          )}
          <div className="flex items-stretch overflow-hidden rounded-md">
            <button
              type="button"
              data-testid="allow-primary"
              className="bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/80 disabled:opacity-40"
              disabled={!allowOptionId}
              onClick={() => {
                if (allowOptionId) onRespond(request.requestId, allowOptionId)
              }}
            >
              Allow {scopeLabel}
            </button>
            <div className="w-px bg-primary/30" />
            <button
              ref={scopeTriggerRef}
              type="button"
              data-testid="scope-chevron"
              aria-label="Choose authorization scope"
              aria-expanded={scopeOpen}
              aria-haspopup="menu"
              className="bg-primary px-2 py-1.5 text-primary-foreground hover:bg-primary/80"
              onClick={(e) => {
                // Stop propagation so this click doesn't reach the dropdown's document
                // click-listener and immediately re-close the menu it just opened.
                e.stopPropagation()
                setScopeOpen((o) => !o)
              }}
            >
              <ChevronDown className="size-3.5" />
            </button>
          </div>
        </div>
        {/* Fallback buttons for any protocol option the Allow/Deny controls can't reach, so an
            unrecognized or ambiguous same-kind option stays selectable rather than disappearing. */}
        {extraOptions.map((option) => (
          <button
            key={option.optionId}
            type="button"
            data-testid="extra-option"
            className="rounded-md border border-border-200 bg-bg-000 px-3 py-1.5 text-[12px] text-text-100 hover:bg-bg-100"
            onClick={() => onRespond(request.requestId, option.optionId)}
          >
            {getExtraOptionLabel(option)}
          </button>
        ))}
        <button
          type="button"
          data-testid="deny-button"
          className="rounded-md border border-border-200 bg-bg-000 px-3 py-1.5 text-[12px] text-text-100 hover:bg-bg-100"
          onClick={() => onRespond(request.requestId, denyOptionId)}
        >
          Deny
        </button>
      </div>
    </div>
  )
}

export { PermissionApprovalControls }
