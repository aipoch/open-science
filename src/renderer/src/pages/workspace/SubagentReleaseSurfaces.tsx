import { AlertCircle, Bot, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AcpPermissionRequest } from '../../../../shared/acp'
import type { AgentFrameworkId, AgentFrameworkView } from '../../../../shared/settings'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { ChatSession } from '@/stores/session-store'
import {
  createSessionSubagentsPreviewItem,
  type PreviewToolItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { useSessionStore } from '@/stores/session-store'
import { cn } from '@/lib/utils'
import { useWorkspaceSubagentRuntimeSession } from '@/lib/acp/useWorkspaceAgentRuntime'

import { WorkspaceMessageEditStateProvider } from './workspace-message-edit-state'
import { WorkspaceMessageScroller } from './WorkspaceMessageScroller'
import {
  projectSessionSubagents,
  resolveDelegatedWorkAvailability,
  selectSubagentFrame,
  type SessionSubagentChild,
  type SubagentRawStatus
} from './subagent-release-projection'

const returnFocusBySession = new Map<string, HTMLElement>()

// The raw status is rendered with CSS `capitalize`, which is a no-op outside Latin scripts, so each
// value maps to its own catalog key. `satisfies` keeps the map exhaustive: a new SubagentRawStatus
// added upstream fails to compile here instead of rendering a raw enum value.
const SUBAGENT_STATUS_LABELS = {
  running: 'running',
  awaiting_user: 'awaiting user',
  completed: 'completed',
  cancelled: 'cancelled',
  error: 'error'
} as const satisfies Record<SubagentRawStatus, string>

const statusDotClassName: Record<SubagentRawStatus, string> = {
  running: 'bg-primary',
  awaiting_user: 'bg-warning-100',
  completed: 'bg-success-000',
  cancelled: 'bg-warning-100',
  error: 'bg-danger-000'
}

const SubagentStatus = ({
  status,
  awaitingPermission = false
}: {
  status: SubagentRawStatus
  awaitingPermission?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-semibold text-text-300">
      <span
        className={cn('size-1.5 rounded-full', statusDotClassName[status])}
        aria-hidden="true"
      />
      <span className="capitalize" data-subagent-status={status}>
        {t(SUBAGENT_STATUS_LABELS[status])}
      </span>
      {awaitingPermission ? (
        <span className="text-[9px] font-normal text-primary">{t('Waiting for permission')}</span>
      ) : null}
    </span>
  )
}

const openSubagentPreview = (
  session: ChatSession,
  child: SessionSubagentChild,
  trigger?: HTMLElement
): void => {
  if (trigger) returnFocusBySession.set(session.id, trigger)
  usePreviewWorkbenchStore
    .getState()
    .upsertAndActivateItem(
      createSessionSubagentsPreviewItem(session.id, session.projectId, child.frameId)
    )
}

type SubagentSurfaceProps = {
  session: ChatSession | undefined
  permissions: readonly AcpPermissionRequest[]
}

const SubagentsBar = ({ session, permissions }: SubagentSurfaceProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const summaryTriggerRef = useRef<HTMLButtonElement>(null)
  const summary = useMemo(
    () => projectSessionSubagents(session, permissions),
    [permissions, session]
  )
  useEffect(() => {
    if (!expanded) return
    // Listen on `click` (not `mousedown`) so the trigger button's own onClick toggle still pairs:
    // the button lives inside `containerRef`, so its click never reaches this outside handler and
    // re-toggles the list. Escape closes the list to match the keyboard affordance of aria-haspopup.
    const onOutsideClick = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setExpanded(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpanded(false)
    }
    document.addEventListener('click', onOutsideClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('click', onOutsideClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [expanded])

  if (!session || summary.children.length === 0) return null

  const single = summary.children.length === 1 ? summary.children[0] : undefined
  const label =
    single?.title ??
    t('{{count}} subagents', {
      defaultValue_one: '{{count}} subagent',
      count: summary.children.length
    })
  // Built by composing whole clauses rather than concatenating fragments: a locale that puts the
  // count first or drops the comma can express that inside its own catalog entry.
  const accessibleLabel = single
    ? single.status === 'running'
      ? t('{{name}}, running', { name: single.title })
      : single.title
    : summary.runningCount
      ? t('{{count}} subagents, {{running}} running', {
          defaultValue_one: '{{count}} subagent, {{running}} running',
          count: summary.children.length,
          running: summary.runningCount
        })
      : t('{{count}} subagents', {
          defaultValue_one: '{{count}} subagent',
          count: summary.children.length
        })

  const selectChild = (child: SessionSubagentChild): void => {
    setExpanded(false)
    openSubagentPreview(session, child, summaryTriggerRef.current ?? undefined)
  }

  return (
    <div ref={containerRef} className="relative min-w-0" data-testid="subagents-bar">
      <button
        ref={summaryTriggerRef}
        type="button"
        aria-label={accessibleLabel}
        aria-expanded={single ? undefined : expanded}
        aria-controls={single ? undefined : `subagents-bar-list-${session.id}`}
        aria-live="polite"
        title={single?.title}
        className="flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 text-[11px] text-text-300 hover:bg-bg-300 hover:text-text-100 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={(event) => {
          if (single) {
            openSubagentPreview(session, single, event.currentTarget)
            return
          }
          setExpanded((value) => !value)
        }}
      >
        <Bot className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate font-medium text-text-100">{label}</span>
        {single?.status === 'running' ? (
          <Loader2
            className="size-3 shrink-0 animate-spin text-primary motion-reduce:animate-none"
            aria-label={t('Running')}
          />
        ) : !single && summary.runningCount > 0 ? (
          <span className="shrink-0">
            ·{' '}
            {t('{{count}} running', {
              defaultValue_one: '{{count}} running',
              count: summary.runningCount
            })}
          </span>
        ) : null}
        {single ? null : (
          <ChevronDown
            className={cn('size-3 shrink-0 transition-transform', expanded && 'rotate-180')}
            aria-hidden="true"
          />
        )}
      </button>

      {expanded ? (
        <div
          id={`subagents-bar-list-${session.id}`}
          aria-label={t('Subagents')}
          className="absolute bottom-full left-0 z-40 mb-1 max-h-72 w-[min(32rem,calc(100vw-4rem))] overflow-y-auto rounded-xl border border-border-300/20 bg-bg-000 shadow-card"
        >
          {summary.children.map((child) => (
            <button
              key={child.frameId}
              type="button"
              aria-describedby={
                child.originUnavailable
                  ? `subagent-origin-warning-${session.id}-${child.frameId}`
                  : undefined
              }
              aria-label={
                child.awaitingPermission
                  ? t('{{name}}, {{status}}, waiting for permission', {
                      name: child.title,
                      status: t(SUBAGENT_STATUS_LABELS[child.status])
                    })
                  : t('{{name}}, {{status}}', {
                      name: child.title,
                      status: t(SUBAGENT_STATUS_LABELS[child.status])
                    })
              }
              className="grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border-300/15 px-3.5 py-2.5 text-left last:border-b-0 hover:bg-bg-100/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
              onClick={() => selectChild(child)}
            >
              <span className="min-w-0">
                <span
                  className="block truncate text-[12px] font-semibold leading-4 text-text-000"
                  title={child.title}
                >
                  {child.title}
                </span>
                <span className="mt-0.5 block truncate text-[10px] leading-4 text-text-300">
                  {child.agentLabel}
                  {child.originUnavailable ? (
                    <>
                      {' · '}
                      <span
                        id={`subagent-origin-warning-${session.id}-${child.frameId}`}
                        className="text-warning-100"
                      >
                        {t('Imported history may be incomplete')}
                      </span>
                    </>
                  ) : null}
                </span>
              </span>
              <SubagentStatus status={child.status} awaitingPermission={child.awaitingPermission} />
              <ChevronRight className="size-3.5 text-text-300" aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

const SubagentAvailabilityNotice = ({
  frameworkId,
  frameworks,
  unavailableReason,
  onOpenSettings
}: {
  frameworkId: AgentFrameworkId
  frameworks: readonly AgentFrameworkView[]
  unavailableReason?: string
  onOpenSettings: () => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const availability = resolveDelegatedWorkAvailability(frameworkId, frameworks, t)
  if (availability.available && !unavailableReason) return null
  const framework = frameworks.find(({ id }) => id === frameworkId)
  const title = unavailableReason
    ? t('Subagents unavailable for this configuration')
    : availability.available
      ? t('Subagents unavailable for {{name}}', { name: framework?.displayName ?? frameworkId })
      : availability.title
  const description = unavailableReason ?? (availability.available ? '' : availability.description)

  return (
    <div
      role="status"
      className="mb-2 flex items-start gap-2 rounded-lg border border-border-200 bg-bg-200 px-3 py-2 text-[11px] leading-4 text-text-300"
    >
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <strong className="block text-text-100">{title}</strong>
        {description}
      </span>
      <button
        type="button"
        className="shrink-0 rounded-md border border-border-200 bg-bg-000 px-2 py-1 text-text-100 hover:bg-bg-300 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={onOpenSettings}
      >
        {t('Open Settings')}
      </button>
    </div>
  )
}

type SubagentFrameDetail = NonNullable<ReturnType<typeof selectSubagentFrame>>

const SubagentTranscript = ({
  session,
  detail
}: {
  session: ChatSession
  detail: SubagentFrameDetail
}): React.JSX.Element => {
  const projectedSession = useWorkspaceSubagentRuntimeSession(session, detail)
  return (
    <WorkspaceMessageScroller
      activeSession={projectedSession}
      onSendEditedMessage={() => undefined}
    />
  )
}

const SubagentPreview = ({
  item,
  returnFocus
}: {
  item: PreviewToolItem
  returnFocus?: HTMLElement
}): React.JSX.Element => {
  const { t } = useTranslation()
  const session = useSessionStore((state) =>
    state.sessions.find((candidate) => candidate.id === item.sessionId)
  )
  const summary = useMemo(() => projectSessionSubagents(session, []), [session])
  const effectiveFrameId = item.selectedAgentFrameId ?? summary.children[0]?.frameId ?? ''
  const [isRetrying, setIsRetrying] = useState(false)
  const detail = useMemo(
    () => selectSubagentFrame(session, effectiveFrameId),
    [effectiveFrameId, session]
  )

  const selectFrame = (frameId: string): void => {
    usePreviewWorkbenchStore
      .getState()
      .upsertItem(createSessionSubagentsPreviewItem(item.sessionId, item.projectId, frameId))
  }

  const close = (): void => {
    usePreviewWorkbenchStore.getState().collapsePanel()
    const target = returnFocus ?? returnFocusBySession.get(item.sessionId)
    returnFocusBySession.delete(item.sessionId)
    target?.focus()
  }

  const retryRead = async (): Promise<void> => {
    if (isRetrying) return
    setIsRetrying(true)
    try {
      const result = await window.api.sessions.loadAll()
      const durable = result.sessions.find((candidate) => candidate.id === item.sessionId)
      if (durable) useSessionStore.getState().upsertPersistedSession(durable)
    } catch {
      // The alert remains visible and the action remains retryable.
    } finally {
      setIsRetrying(false)
    }
  }

  return (
    <section className="flex size-full min-h-0 flex-col bg-bg-000" aria-label={t('Subagents')}>
      <header className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border-200 bg-bg-10 px-3 py-2">
        <label htmlFor={`subagent-frame-${item.sessionId}`} className="sr-only">
          {t('Subagent Frame')}
        </label>
        <Select value={effectiveFrameId} onValueChange={selectFrame}>
          <SelectTrigger
            id={`subagent-frame-${item.sessionId}`}
            aria-label={t('Subagent Frame')}
            className="min-w-0 flex-1 text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {summary.children.map((child) => (
              <SelectItem key={child.frameId} value={child.frameId}>
                {child.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {detail ? <SubagentStatus status={detail.status} /> : null}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('Close Subagents preview')}
                className="grid size-8 shrink-0 place-items-center rounded-md text-text-300 hover:bg-bg-200 hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                onClick={close}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('Close Subagents preview')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </header>

      {!detail || !session ? (
        <div role="alert" className="m-auto max-w-sm p-6 text-center text-[12px] text-text-300">
          <AlertCircle className="mx-auto mb-2 size-5" aria-hidden="true" />
          <p>{t('This Subagent conversation could not be read.')}</p>
          <button
            type="button"
            aria-label={t('Retry Subagent preview')}
            disabled={isRetrying}
            className="mt-3 rounded-md border border-border-200 px-3 py-1.5 text-text-100 hover:bg-bg-200 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={() => void retryRead()}
          >
            {isRetrying ? t('Retrying…') : t('Retry')}
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col" aria-live="off">
          <div className="shrink-0 border-b border-border-100 px-4 py-2 text-[11px] text-text-300">
            <span className="font-medium text-text-100">{detail.agentLabel}</span>
            {detail.originUnavailable ? (
              <span className="text-warning-100">
                {' · '}
                {t('Imported history may be incomplete')}
              </span>
            ) : null}
            {detail.attempt?.cancellationReason ? (
              <span> · {detail.attempt.cancellationReason}</span>
            ) : null}
            {detail.attempt?.error?.message ? (
              <span className="block pt-1 text-danger-000">{detail.attempt.error.message}</span>
            ) : null}
          </div>
          <WorkspaceMessageEditStateProvider canEditMessage={false}>
            <SubagentTranscript
              key={`${session.id}:${detail.frameId}:${detail.attempt?.id ?? 'no-attempt'}:${detail.attempt?.runtimeSegmentIds.at(-1) ?? 'no-runtime'}`}
              session={session}
              detail={detail}
            />
          </WorkspaceMessageEditStateProvider>
        </div>
      )}
    </section>
  )
}

export { SubagentAvailabilityNotice, SubagentPreview, SubagentsBar }
