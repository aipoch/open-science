/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */

import type { TFunction } from 'i18next'
import { Check, ChevronDown, ChevronRight, Info } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AcpPermissionRequest } from '../../../../shared/acp'
import type { NotebookSessionRequest } from '../../../../shared/notebook'
import { resolveProjectId } from '../../../../shared/project-scope'
import { isEnvEnabled } from '../../../../shared/notebook-runtime'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { dialogTitleClassName } from '@/components/ui/dialog-chrome'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { resolveNotebookLanguage, resolveNotebookRunToolName } from './notebook-tool-names'
import {
  describePermissionRequest,
  getNotebookNetworkApproval,
  isArtifactWriteRequest,
  isLiteratureReadRequest,
  isMcpPermissionRequest,
  isNotebookNetworkApprovalRequest,
  isSpecialistDeleteRequest,
  isSpecialistSwitchRequest,
  type PermissionPresentation,
  type NotebookRuntime
} from './permission-request-presentation'
import {
  PermissionScopeConfirmationDialog,
  type BroadPermissionScope,
  type PermissionScopeConfirmation
} from './PermissionScopeConfirmationDialog'
import { SpecialistDeleteDetail } from './SpecialistDeleteDetail'
import { SpecialistSwitchDetail } from './SpecialistSwitchDetail'
import { WorkspaceToolCodeBlock } from './WorkspaceToolCodeBlock'
import { WorkspaceLiteratureToolCard } from './WorkspaceLiteratureToolCard'
import { SkillDocumentSheet } from './WorkspaceSkillLoadRow'
import { buildLiteratureToolSummary } from './literature-tool-presentation'
import { getSkillLoadPermissionSkillName } from './workspace-skill-load'
import { useSkillDocument } from './use-skill-document'

type PermissionApprovalControlsProps = {
  requests: AcpPermissionRequest[]
  onRespond: (requestId: string, optionId?: string) => void | Promise<void>
  disabled?: boolean
  embedded?: boolean
  // Session locator for the notebook env badge; optional so the controls render standalone
  // (isolation tests, sessions without notebook context).
  notebookLookup?: NotebookSessionRequest
}

type PermissionApprovalCardProps = Omit<PermissionApprovalControlsProps, 'requests'> & {
  request: AcpPermissionRequest
  onSubmitted(requestId: string): void
}

type PermissionOption = AcpPermissionRequest['options'][number]
type PermissionScope = 'once' | 'session' | 'project' | 'global'
type PendingScopeConfirmation = PermissionScopeConfirmation & {
  requestId: string
  optionId: string
}

type ScopeOption = { scope: PermissionScope; label: string; subtitle: string }

// English source text for the scope menu. It stays here as literals so it reads in the diff, but it
// travels to the menu as *data* rather than as JSX, so the read sites below call t() on it.
const SCOPE_OPTIONS: ScopeOption[] = [
  { scope: 'once', label: 'Once', subtitle: 'This call only' },
  { scope: 'session', label: 'This conversation', subtitle: 'Remembered for this conversation' },
  { scope: 'project', label: 'This project', subtitle: 'Remembered for this project' },
  { scope: 'global', label: 'Global', subtitle: 'Remembered across all projects' }
]
const PERMISSION_SCOPES = SCOPE_OPTIONS.map(({ scope }) => scope)

// The ACP option kind that backs each scope. A scope is only offered when the request
// actually carries that exact kind — we never substitute one for the other, since that
// would grant a wider (or narrower) permission than the label promises.
const SCOPE_KIND: Partial<Record<PermissionScope, string>> = {
  once: 'allow_once',
  session: 'allow_always'
}

const getOptionScope = (option: PermissionOption): PermissionScope | undefined => {
  if (option.scope && PERMISSION_SCOPES.includes(option.scope)) return option.scope
  if (option.scope !== undefined) return undefined

  const kind = option.kind.toLowerCase()
  if (kind === SCOPE_KIND.once) return 'once'
  if (kind === SCOPE_KIND.session) return 'session'
  return undefined
}

// The subset of scopes the request can actually satisfy, derived from its exact option kinds.
const getAvailableScopes = (options: PermissionOption[]): Set<PermissionScope> => {
  const scopes = new Set<PermissionScope>()
  for (const option of options) {
    const scope = getOptionScope(option)
    if (scope) scopes.add(scope)
  }
  return scopes
}

// Returns the optionId for Allow at the chosen scope — matched by exact kind only, no fallback.
const getAllowOptionId = (
  options: PermissionOption[],
  scope: PermissionScope
): string | undefined => options.find((option) => getOptionScope(option) === scope)?.optionId

// Returns the optionId to use for Deny, or undefined to cancel. Prefer the one-time reject so a
// single Deny never silently applies a permanent `reject_always` just because the provider listed
// it first; fall back to any reject kind only when reject_once is absent.
const getDenyOptionId = (options: PermissionOption[]): string | undefined =>
  options.find((o) => o.kind.toLowerCase() === 'reject_once')?.optionId ??
  options.find((o) => o.kind.toLowerCase().startsWith('reject_'))?.optionId

// The optionIds the Allow split-button can reach across both scopes (allow_once + allow_always).
// The scope toggle chooses between them, so both count as reachable for the extra-options diff.
const allowOptionIds = (options: PermissionOption[]): string[] =>
  PERMISSION_SCOPES.map((scope) => getAllowOptionId(options, scope)).filter(
    (id): id is string => id !== undefined
  )

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
  return options.filter((option) => !reachable.has(option.optionId))
}

// Canonical, protocol-derived action word for a known option kind; undefined for unknown kinds.
// The kind is trusted protocol semantics; the provider-supplied name is NOT, so an untrusted
// allow_always named "Reject" must still read as an Allow action.
// `as const` keeps the values as literal catalog keys so the t() lookup below stays type-checked.
const CANONICAL_ACTION_LABEL_KEY = {
  allow_once: 'Allow once',
  allow_always: 'Allow always',
  reject_once: 'Reject once',
  reject_always: 'Reject always'
} as const

// Label for an extra-option button. For a known kind, use the canonical action word and append the
// provider name only to disambiguate (never as the action itself). For an unknown kind, the
// provider name is all we have, so show it verbatim.
const getExtraOptionLabel = (option: PermissionOption, t: TFunction): string => {
  const kind = option.kind.toLowerCase()
  if (!(kind in CANONICAL_ACTION_LABEL_KEY)) return option.name
  const canonicalKey = CANONICAL_ACTION_LABEL_KEY[kind as keyof typeof CANONICAL_ACTION_LABEL_KEY]
  const canonical = t(canonicalKey)
  const provider = option.name.trim()
  return provider && provider.toLowerCase() !== canonicalKey.toLowerCase()
    ? `${canonical} · ${provider}`
    : canonical
}

const getScopeConfirmationSubject = (
  presentation: PermissionPresentation,
  request: AcpPermissionRequest
): Omit<PermissionScopeConfirmation, 'scope'> => {
  const networkApproval = getNotebookNetworkApproval(request)
  if (networkApproval) {
    return {
      subject: networkApproval.hostname,
      codeExecution: false,
      settingsTarget: 'network'
    }
  }
  if (presentation.notebookRuntime) {
    return { subject: presentation.notebookRuntime, codeExecution: true }
  }

  switch (presentation.categoryLabel) {
    case 'Command execution':
      return {
        subject: request.commandPrefix?.length ? 'this command group' : 'this command',
        codeExecution: true
      }
    case 'File access':
      return { subject: 'this file read', codeExecution: false }
    case 'File change':
      return { subject: 'this file change', codeExecution: false }
    case 'Network access':
      return { subject: 'this network request', codeExecution: false }
    case 'Artifact save':
      return { subject: 'this artifact save', codeExecution: false }
    case 'External service':
      return {
        subject: request.mcpIdentity
          ? (presentation.actionDetail ?? 'this external service')
          : 'this external service',
        codeExecution: false
      }
    case 'Notebook control':
      return { subject: 'this notebook action', codeExecution: false }
    default:
      return { subject: 'this tool', codeExecution: false }
  }
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
  isMcpPermissionRequest(request) ? resolveNotebookRunToolName(request.mcpIdentity) : undefined

// Derives displayable code and language from the tool's raw input.
const extractPermissionCode = (request: AcpPermissionRequest): PermissionCode | undefined => {
  if (isNotebookNetworkApprovalRequest(request)) return undefined
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

  // Shell execute: prefer the structured command field (verbatim), then use the title only for
  // the known Bash provider. Other execute titles can be generic labels, not concrete commands.
  // MCP execute inputs are arbitrary tool arguments and must not be reinterpreted as local shell.
  if (isExecute && !isMcpPermissionRequest(request)) {
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
const getPermissionActionTitle = (
  request: AcpPermissionRequest,
  fallback: string,
  t: TFunction
): string => {
  if (resolveNotebookToolName(request)) return t('Start Notebook run')
  if (isArtifactWriteRequest(request)) return t('Artifact file input')
  if (isMcpPermissionRequest(request)) return t('External service input')
  if (request.toolKind === 'execute' || request.providerToolName === 'Bash') return t('Run command')
  return fallback
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

// Activity-style collapsible card for a skills/load_skill approval. The request carries only the
// skill's invocation name, so — like the transcript's load_skill rows — the SKILL.md body is
// resolved through useSkillDocument: the managed catalog when listed, the main-process
// connector-aware resolver otherwise. It defaults to expanded and fetches on mount (rather than on
// first expand) because the document IS the payload under review. When no source provides the
// name, the raw JSON input stays reviewable as the fallback block.
const PermissionSkillSection = ({
  skillName,
  fallback
}: {
  skillName: string
  fallback?: PermissionCode
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(true)
  const document = useSkillDocument(skillName)

  if (document.status === 'unavailable' && !fallback) return null

  return (
    <div className="w-full overflow-hidden rounded-lg bg-muted/60 px-2 py-1.5">
      <button
        type="button"
        data-testid="permission-skill-toggle"
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
        <span className="min-w-0 truncate text-left font-medium text-foreground">
          {document.status === 'ready' ? document.title : skillName}
        </span>
        <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground">
          {t('Skill')}
        </span>
      </button>
      {expanded && (
        // The sheet caps at a quarter of its own width (25cqw against this container),
        // so the preview scales with the card instead of a fixed pixel ceiling.
        <div className="@container mx-1 mb-1.5 md:ml-[30px]">
          {document.status === 'ready' ? (
            <SkillDocumentSheet markdown={document.markdown} maxHeightClassName="max-h-[25cqw]" />
          ) : document.status === 'failed' ? (
            <button
              type="button"
              className="rounded-md px-1 py-1 text-[12px] text-text-300 transition-colors hover:text-text-100"
              onClick={document.retry}
            >
              {t('Retry')}
            </button>
          ) : document.status === 'unavailable' && fallback ? (
            <WorkspaceToolCodeBlock code={fallback.code} language={fallback.language} copyable />
          ) : (
            <div className="px-1 py-1 text-[12px] text-text-300">{t('Loading preview…')}</div>
          )}
        </div>
      )}
    </div>
  )
}

const NotebookNetworkApprovalDetail = ({
  request
}: {
  request: AcpPermissionRequest
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const approval = getNotebookNetworkApproval(request)
  if (!approval) return null
  const destination = approval.port ? `${approval.hostname}:${approval.port}` : approval.hostname

  return (
    <div className="space-y-2 text-xs leading-5 text-muted-foreground">
      <p>{t('Notebook code requested access to {{destination}}.', { destination })}</p>
      {approval.reason ? <p>{t('Reason: {{reason}}', { reason: approval.reason })}</p> : null}
      <button
        type="button"
        aria-expanded={expanded}
        className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary"
        onClick={() => setExpanded((current) => !current)}
      >
        <ChevronRight
          className={cn('size-3.5 transition-transform', expanded && 'rotate-90')}
          aria-hidden="true"
        />
        {t('Details')}
      </button>
      {expanded ? (
        <p>
          {t(
            'This lets Notebook code read from and send data to {{domain}}. Only allow domains you trust. You can revoke saved access anytime in Settings > Network > Allowed domains.',
            { domain: approval.hostname }
          )}
        </p>
      ) : null}
    </div>
  )
}

// Resolves the environment a session's notebook kernel of the requested kind runs in, best-known
// first: the matching live kernel, then the latest matching run, and finally the enabled runtime
// from Settings → Runtimes (what a kernel of that kind started now would bind).
// Sessions with no notebook history and no bridge (tests) resolve to undefined — no badge.
const lookupNotebookEnvironment = async (
  request: NotebookSessionRequest,
  kernelKind: 'python' | 'r'
): Promise<string | undefined> => {
  const notebookApi = window.api?.notebook
  if (notebookApi) {
    try {
      const state = await notebookApi.state(request)
      const live = state.environments.find(
        (environment) => environment.kind === kernelKind && environment.environment
      )?.environment
      if (live) return live
      const latestDurable = state.latestRunEnvironments?.[kernelKind]
      if (latestDurable) return latestDurable
      for (let i = state.runs.length - 1; i >= 0; i -= 1) {
        const run = state.runs[i]
        const env = run.kernelKind === kernelKind ? run.environment : undefined
        if (env) return env
      }
    } catch {
      /* no notebook for this session yet — fall through to the Settings default */
    }
  }

  const runtimeApi = window.api?.runtime
  if (!runtimeApi) return undefined
  try {
    const [lists, enablement] = await Promise.all([
      runtimeApi.listEnvironments(),
      runtimeApi.getEnablement(kernelKind)
    ])
    const enabled = lists[kernelKind].filter((env) => isEnvEnabled(env, enablement))
    // Mirror the session's default binding: the app-managed env wins over user-registered ones.
    const fallback = enabled.find((env) => env.provenance === 'app-managed') ?? enabled[0]
    return fallback?.label
  } catch {
    return undefined
  }
}

const useNotebookEnvironment = (
  lookup: NotebookSessionRequest | undefined,
  kernelKind: 'python' | 'r' | undefined
): string | undefined => {
  const [environment, setEnvironment] = useState<{ key: string; name: string | undefined }>()
  const lookupKey = lookup
    ? `${resolveProjectId(lookup, 'default-project')}:${lookup.sessionId}`
    : undefined
  const key = lookupKey && kernelKind ? `${lookupKey}:${kernelKind}` : undefined
  useEffect(() => {
    if (!lookup || !key || !kernelKind) return
    let cancelled = false
    void lookupNotebookEnvironment(lookup, kernelKind).then((name) => {
      if (!cancelled) setEnvironment({ key, name })
    })
    return () => {
      cancelled = true
    }
    // lookup is a fresh object per render; the primitive key is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, kernelKind])
  if (!environment || environment.key !== key) return undefined
  return environment.name
}

const PermissionImpactTip = ({
  description,
  detail
}: {
  description: string
  detail?: string
}): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('Permission impact information')}
            data-testid="permission-impact-info"
            className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Info className="size-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <div className="space-y-1">
            {detail ? <p>{detail}</p> : null}
            <p className={detail ? 'text-muted-foreground' : undefined}>{description}</p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// Header cluster for permission prompts: a user-facing category, an available notebook environment,
// and the authorization-scope information affordance.
const PermissionHeaderBadges = ({
  lookup,
  runtime,
  categoryLabel,
  scopeDescription
}: {
  lookup: NotebookSessionRequest | undefined
  runtime?: NotebookRuntime
  categoryLabel: string
  scopeDescription: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const kernelKind = runtime === 'python' ? 'python' : runtime === 'r' ? 'r' : undefined
  const envName = useNotebookEnvironment(lookup, kernelKind)

  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5">
      <Badge variant="secondary" data-testid="permission-category-badge">
        {categoryLabel}
      </Badge>
      {envName ? (
        <Badge variant="secondary" data-testid="permission-env-badge">
          {envName}
        </Badge>
      ) : null}
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('Permission information')}
              data-testid="permission-tool-info"
              className="flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Info className="size-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{scopeDescription}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  )
}

// Popover listing the two available scope choices.
const ScopeDropdown = ({
  selected,
  available,
  onSelect,
  onClose,
  portaled
}: {
  selected: PermissionScope
  available: Set<PermissionScope>
  onSelect: (scope: PermissionScope) => void
  onClose: (restoreTriggerFocus?: boolean) => void
  portaled: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const options = SCOPE_OPTIONS.filter(({ scope }) => available.has(scope))
  const selectedIndex = options.findIndex(({ scope }) => scope === selected)

  useEffect(() => {
    itemRefs.current[selectedIndex]?.focus()
  }, [selectedIndex])

  useEffect(() => {
    if (portaled) return

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
  }, [onClose, portaled])

  const items = (
    <>
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
            onClose(true)
          }}
          onKeyDown={(event) => {
            const lastIndex = options.length - 1
            let nextIndex: number | undefined

            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onSelect(scope)
              onClose(true)
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
            <span className="text-xs font-medium text-foreground">{t(label)}</span>
            <span className="text-[11px] leading-tight text-muted-foreground">{t(subtitle)}</span>
          </div>
          {/* Check column: right side, fixed slot so selection never shifts the label */}
          <span className="flex w-3.5 shrink-0 justify-center text-primary">
            {selected === scope ? <Check className="size-3.5" strokeWidth={2.5} /> : null}
          </span>
        </button>
      ))}
    </>
  )

  return portaled ? (
    <PopoverContent
      ref={ref}
      role="menu"
      aria-label={t('Authorization scope')}
      side="top"
      align="end"
      sideOffset={6}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      onEscapeKeyDown={() => onClose(true)}
      className="min-w-44 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-menu"
    >
      {items}
    </PopoverContent>
  ) : (
    <div
      ref={ref}
      role="menu"
      aria-label={t('Authorization scope')}
      className="absolute bottom-full right-0 z-10 mb-1.5 min-w-44 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-menu outline-none"
    >
      {items}
    </div>
  )
}

const PermissionApprovalCard = ({
  request,
  onRespond,
  embedded = false,
  notebookLookup,
  disabled = false,
  onSubmitted
}: PermissionApprovalCardProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [scope, setScope] = useState<PermissionScope>('session')
  const [scopeOpen, setScopeOpen] = useState(false)
  const [scopeConfirmation, setScopeConfirmation] = useState<PendingScopeConfirmation | undefined>(
    undefined
  )
  const [submittingRequestId, setSubmittingRequestId] = useState<string | undefined>(undefined)
  const submittingRequestIdRef = useRef<string | undefined>(undefined)
  const scopeTriggerRef = useRef<HTMLButtonElement>(null)
  const allowPrimaryRef = useRef<HTMLButtonElement>(null)
  const closeScopeMenu = useCallback((restoreTriggerFocus = false) => {
    setScopeOpen(false)
    if (restoreTriggerFocus) queueMicrotask(() => scopeTriggerRef.current?.focus())
  }, [])

  // Default to Session when available: it avoids repeated prompts without silently widening to a
  // whole Project or Global grant. Once remains the fallback for requests without Session scope.
  const availableScopes = request ? getAvailableScopes(request.options) : new Set<PermissionScope>()
  const defaultScope: PermissionScope = availableScopes.has('session')
    ? 'session'
    : availableScopes.has('once')
      ? 'once'
      : availableScopes.has('project')
        ? 'project'
        : 'global'

  // Reset per-request UI state (scope + open menu) whenever the displayed request changes,
  // so nothing leaks from the previously answered prompt.
  const requestId = request.requestId

  // Guard against a stale scope no longer offered by the current request.
  const effectiveScope = availableScopes.has(scope) ? scope : defaultScope
  const permCode = extractPermissionCode(request)
  // A skills/load_skill approval names the skill being loaded; the section resolves the SKILL.md
  // document (managed catalog first, then the connector-aware main resolver) and falls back to the
  // raw JSON input when no source provides the name.
  const skillLoadName = getSkillLoadPermissionSkillName(request)
  const literatureSummary = isLiteratureReadRequest(request)
    ? buildLiteratureToolSummary(request.rawInput)
    : undefined
  const sourcePresentation = describePermissionRequest(request)
  const presentation: PermissionPresentation = {
    ...sourcePresentation,
    actionTitle: t(sourcePresentation.actionTitleKey ?? sourcePresentation.actionTitle, {
      ...sourcePresentation.actionTitleValues
    }),
    categoryLabel: t(sourcePresentation.categoryLabel),
    description: t(sourcePresentation.description)
  }
  const allowOptionId = getAllowOptionId(request.options, effectiveScope)
  const denyOptionId = getDenyOptionId(request.options)
  // Translate the complete action so languages can choose their own verb and scope order.
  const allowLabel: Record<PermissionScope, string> = {
    once: t('Allow once'),
    session: t('Allow for this conversation'),
    project: t('Allow for this project'),
    global: t('Allow globally')
  }
  const notebookRuntimeLabel: Partial<Record<NotebookRuntime, string>> = {
    python: t('Python'),
    r: t('R'),
    js: t('JavaScript REPL'),
    bash: t('notebook shell')
  }
  const scopeDescription = !allowOptionId
    ? t('No approval scope is available for this request.')
    : effectiveScope === 'once'
      ? t('Approval applies to this call only.')
      : effectiveScope === 'project'
        ? t('Approval applies to matching calls in this project.')
        : effectiveScope === 'global'
          ? t('Approval applies to matching calls in every project.')
          : presentation.notebookRuntime
            ? t(
                'Approval covers later {{runtime}} calls in this conversation, including across restarts.',
                { runtime: notebookRuntimeLabel[presentation.notebookRuntime] }
              )
            : t('Approval remains attached to this conversation across restarts.')
  const hasScopePicker = availableScopes.size > 1
  const isSubmitting = submittingRequestId === request.requestId
  const respondOnce = (optionId?: string, broadScopeConfirmed = false): void => {
    if (submittingRequestIdRef.current === request.requestId) return

    const selectedScope = request.options.find((option) => option.optionId === optionId)?.scope
    if (
      !broadScopeConfirmed &&
      optionId &&
      (selectedScope === 'project' || selectedScope === 'global')
    ) {
      requestBroadScopeConfirmation(selectedScope, optionId)
      return
    }

    const submittedRequestId = request.requestId
    submittingRequestIdRef.current = submittedRequestId
    setSubmittingRequestId(submittedRequestId)
    setScopeOpen(false)
    onSubmitted(submittedRequestId)

    const releaseSubmission = (): void => {
      if (submittingRequestIdRef.current !== submittedRequestId) return

      submittingRequestIdRef.current = undefined
      setSubmittingRequestId((current) => (current === submittedRequestId ? undefined : current))
    }

    Promise.resolve(onRespond(submittedRequestId, optionId)).then(
      releaseSubmission,
      releaseSubmission
    )
  }

  // Any option the Allow (either scope) / Deny controls can't reach — a non-canonical protocol
  // kind, or a second same-kind option — is surfaced as its own labeled button so a
  // protocol-offered choice is never silently discarded. See getExtraOptions.
  const extraOptions = getExtraOptions(
    request.options,
    allowOptionIds(request.options),
    denyOptionId
  )

  const isMcp = isMcpPermissionRequest(request)
  const isShell = !isMcp && (request.toolKind === 'execute' || request.providerToolName === 'Bash')
  // Specialist deletes render the primary action as a destructive Delete (prototype scene 8) — the
  // only request kind that re-words and recolors the Allow control.
  const isDeleteRequest = isSpecialistDeleteRequest(request)

  // Most identity details stay in the impact tip. When no path or preview exists, retain the only
  // actionable target inline so the approval is reviewable without relying on hover.
  const headerName = request.providerToolName ?? request.title
  const titleDetail = ((): string | undefined => {
    if (presentation.hideToolIdentity) return undefined
    if (isMcp) {
      return presentation.actionDetail
    }
    if (!request.title || request.title === permCode?.code) return undefined
    if (!request.providerToolName) return request.title
    if (isShell) {
      return !permCode && request.title !== request.providerToolName ? request.title : undefined
    }
    return request.title !== headerName ? request.title : request.providerToolName
  })()
  const showInlineDetail =
    !isMcp && Boolean(titleDetail) && !permCode && !request.toolLocations?.length
  const closeScopeConfirmation = (): void => {
    setScopeConfirmation(undefined)
    queueMicrotask(() => allowPrimaryRef.current?.focus())
  }

  const requestBroadScopeConfirmation = (
    broadScope: BroadPermissionScope,
    optionId: string
  ): void => {
    const confirmationCopy = getScopeConfirmationSubject(presentation, request)
    setScopeOpen(false)
    setScopeConfirmation({
      ...confirmationCopy,
      scope: broadScope,
      requestId: request.requestId,
      optionId
    })
  }

  const confirmBroadScope = (): void => {
    const pending = scopeConfirmation
    setScopeConfirmation(undefined)
    if (!pending || pending.requestId !== request.requestId) return
    respondOnce(pending.optionId, true)
  }

  return (
    <div
      data-testid="permission-card"
      role="group"
      aria-label={
        request.delegated
          ? t('{{child}} permission request: {{action}}', {
              child: request.delegated.childTitle,
              action: presentation.actionTitle
            })
          : t('Permission request: {{action}}', { action: presentation.actionTitle })
      }
      className={cn(
        'flex w-full max-w-full flex-col gap-3 bg-card p-4 text-xs leading-5 text-card-foreground outline-none sm:p-5',
        !embedded &&
          'mb-2 rounded-xl border border-border shadow-dialog motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200'
      )}
    >
      {request.delegated ? (
        <div className="flex flex-col gap-1 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-foreground">{request.delegated.childTitle}</span>
            <span className="text-muted-foreground">{request.delegated.riskScope}</span>
          </div>
          <span className="break-words text-muted-foreground">
            {literatureSummary ? presentation.description : request.title}
          </span>
        </div>
      ) : null}
      {/* Header: plain-language action plus its classification and notebook context. */}
      <div
        data-testid="permission-header"
        className={cn(
          'flex min-w-0 items-center gap-2',
          embedded &&
            'sticky top-0 z-10 -mx-4 -mt-4 -mb-3 bg-card px-4 pb-3 pt-4 sm:-mx-5 sm:-mt-5 sm:px-5 sm:pt-5'
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn(dialogTitleClassName, 'min-w-0 truncate')}>
            {presentation.actionTitle}
          </span>
          <PermissionImpactTip description={presentation.description} detail={titleDetail} />
        </div>
        <PermissionHeaderBadges
          lookup={notebookLookup}
          runtime={presentation.notebookRuntime}
          categoryLabel={presentation.categoryLabel}
          scopeDescription={scopeDescription}
        />
      </div>

      {/* Affected file targets — the canonical location field, shown so read/edit/delete
          prompts always reveal the path being authorized. Wraps to keep full values readable. */}
      {request.toolLocations?.length ? (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 break-all text-xs text-muted-foreground">
          {request.toolLocations.map((location) => (
            <span key={location.path}>{location.path}</span>
          ))}
        </div>
      ) : null}

      {showInlineDetail ? (
        <p className="break-all text-xs text-muted-foreground">{titleDetail}</p>
      ) : null}

      {request.commandPrefix?.length ? (
        <p className="break-all text-xs text-muted-foreground">
          {t('Remembered scopes apply to commands starting with:')}{' '}
          <code className="rounded-md bg-accent/50 px-1.5 py-0.5 font-mono text-sm text-primary">
            {JSON.stringify(request.commandPrefix)}
          </code>
        </p>
      ) : null}

      {/* Specialist switch/delete requests show a friendly detail block instead of the raw
          redacted payload; all other requests keep the activity-style code preview. Skill loads
          show the SKILL.md document itself — it is the payload being approved. */}
      {literatureSummary ? (
        <WorkspaceLiteratureToolCard summary={literatureSummary} />
      ) : isNotebookNetworkApprovalRequest(request) ? (
        <NotebookNetworkApprovalDetail request={request} />
      ) : isSpecialistSwitchRequest(request) ? (
        <SpecialistSwitchDetail request={request} />
      ) : isSpecialistDeleteRequest(request) ? (
        <SpecialistDeleteDetail request={request} />
      ) : skillLoadName ? (
        <PermissionSkillSection key={requestId} skillName={skillLoadName} fallback={permCode} />
      ) : permCode ? (
        <PermissionCodeSection
          key={requestId}
          title={getPermissionActionTitle(
            request,
            presentation.actionDetail ?? presentation.actionTitle,
            t
          )}
          code={permCode.code}
          language={permCode.language}
        />
      ) : null}

      {/* Allow / Deny button row; wraps so long provider-supplied option labels can never
          push the primary Allow/Deny controls out of view. */}
      <div
        data-testid="permission-actions"
        className={cn(
          'flex flex-wrap items-center justify-end gap-2',
          embedded &&
            'sticky bottom-0 z-10 -mx-4 -mb-4 bg-card px-4 pb-4 pt-3 sm:-mx-5 sm:-mb-5 sm:px-5 sm:pb-5'
        )}
      >
        {/* Split Allow button: main action + scope chevron; the menu anchors to this group's right edge.
            Styled like the shared Button (default size, including flex centering so the label baseline
            matches the neighboring Button primitives) but kept as two segments so the chevron
            stays a separate tab stop with its own aria-haspopup semantics. */}
        <Popover
          open={embedded && scopeOpen}
          onOpenChange={(open) => {
            if (!open) closeScopeMenu()
          }}
        >
          <div className="relative flex items-stretch overflow-visible rounded-lg">
            {hasScopePicker && scopeOpen && (
              <ScopeDropdown
                selected={effectiveScope}
                available={availableScopes}
                onSelect={setScope}
                onClose={closeScopeMenu}
                portaled={embedded}
              />
            )}
            <PopoverAnchor asChild>
              <div className="flex items-stretch overflow-hidden rounded-lg">
                <button
                  ref={allowPrimaryRef}
                  type="button"
                  data-testid="allow-primary"
                  className={cn(
                    'inline-flex h-8 select-none items-center justify-center gap-1 whitespace-nowrap px-3 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50',
                    isDeleteRequest
                      ? 'bg-destructive text-destructive-foreground hover:bg-destructive/80'
                      : 'bg-primary text-primary-foreground hover:bg-primary/80'
                  )}
                  disabled={disabled || !allowOptionId || isSubmitting}
                  onClick={() => {
                    if (!allowOptionId) return
                    respondOnce(allowOptionId)
                  }}
                >
                  {isDeleteRequest ? (
                    <span className="font-semibold">{t('Delete')}</span>
                  ) : (
                    <span className="font-semibold">{allowLabel[effectiveScope]}</span>
                  )}
                </button>
                {hasScopePicker ? (
                  <>
                    <div
                      className={cn(
                        'w-px',
                        isDeleteRequest
                          ? 'bg-destructive-foreground/25'
                          : 'bg-primary-foreground/25'
                      )}
                    />
                    <button
                      ref={scopeTriggerRef}
                      type="button"
                      data-testid="scope-chevron"
                      aria-label={t('Choose authorization scope')}
                      aria-expanded={scopeOpen}
                      aria-haspopup="menu"
                      className={cn(
                        'inline-flex h-8 select-none items-center justify-center px-2 outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50',
                        isDeleteRequest
                          ? 'bg-destructive text-destructive-foreground hover:bg-destructive/80'
                          : 'bg-primary text-primary-foreground hover:bg-primary/80'
                      )}
                      disabled={isSubmitting}
                      onClick={(e) => {
                        // Stop propagation so this click doesn't reach the dropdown's document
                        // click-listener and immediately re-close the menu it just opened.
                        e.stopPropagation()
                        setScopeOpen((o) => !o)
                      }}
                    >
                      <ChevronDown className="size-4" />
                    </button>
                  </>
                ) : null}
              </div>
            </PopoverAnchor>
          </div>
        </Popover>
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
            disabled={disabled || isSubmitting}
            onClick={() => respondOnce(option.optionId)}
          >
            {getExtraOptionLabel(option, t)}
          </Button>
        ))}
        <Button
          type="button"
          variant="outline"
          data-testid="deny-button"
          className="px-4"
          disabled={disabled || isSubmitting}
          onClick={() => respondOnce(denyOptionId)}
        >
          {t('Deny')}
        </Button>
      </div>
      <PermissionScopeConfirmationDialog
        confirmation={scopeConfirmation}
        onCancel={closeScopeConfirmation}
        onConfirm={confirmBroadScope}
      />
    </div>
  )
}

const PermissionApprovalControls = ({
  requests,
  onRespond,
  embedded = false,
  notebookLookup,
  disabled = false
}: PermissionApprovalControlsProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const surfaceRef = useRef<HTMLDivElement>(null)
  const focusReturnFromRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const focusReturnFrom = focusReturnFromRef.current
    if (!focusReturnFrom || requests.some(({ requestId }) => requestId === focusReturnFrom)) return
    focusReturnFromRef.current = undefined
    queueMicrotask(() => {
      surfaceRef.current
        ?.querySelector<HTMLButtonElement>('[data-testid="allow-primary"]:not(:disabled)')
        ?.focus()
    })
  }, [requests])
  if (requests.length === 0) return null
  const firstRootRequest = requests.find((request) => !request.delegated)
  const visibleRequests = requests.filter(
    (request) => request.delegated || request === firstRootRequest
  )
  return (
    <div ref={surfaceRef} data-testid="permission-approval-controls">
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {t('{{count}} subagent permission requests pending', {
          count: visibleRequests.filter((request) => request.delegated).length,
          defaultValue_one: '{{count}} subagent permission request pending'
        })}
      </span>
      {visibleRequests.map((request) => (
        <PermissionApprovalCard
          key={request.requestId}
          request={request}
          onRespond={onRespond}
          embedded={embedded}
          notebookLookup={notebookLookup}
          disabled={disabled}
          onSubmitted={(requestId) => {
            focusReturnFromRef.current = requestId
          }}
        />
      ))}
    </div>
  )
}

export { PermissionApprovalControls }
