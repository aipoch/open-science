import { useSmoothStreamingContent } from '@/components/streamdown/use-smooth-streaming-content'
import { ErrorNotice } from '@/components/error-notice'
import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import { cn, formatByteSize } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { ChatMessage, ChatSession } from '@/stores/session-store'
import { Collapsible } from 'radix-ui'
import {
  ArrowUpRight,
  Bot,
  Brain,
  BookOpenText,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleGauge,
  Copy,
  FileText,
  GitBranch,
  Image as ImageIcon,
  MessageCircleMore,
  Loader2,
  Pencil
} from 'lucide-react'
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode
} from 'react'
import { useTranslation } from 'react-i18next'
import { formatDisplayNumber } from '@/lib/locale-format'
import type { ArtifactPreviewResult } from '../../../../shared/artifacts'
import type { ProvenanceMessagePart } from '../../../../shared/artifact-provenance'
import type { AcpTurnTokenUsage } from '../../../../shared/acp'
import type { PersistedRuntimeSegment } from '../../../../shared/conversation-graph'
import type { MessagePart } from '../../../../shared/session-persistence'
import {
  isComputeJobCompletionAttribution,
  isComputeJobCompletionPresentation,
  isHumanUserMessage,
  isReviewerCorrectionAttribution
} from '../../../../shared/session-persistence'
import { resolvePdfPreparationScope } from '../../../../shared/pdf-preparation-scope'
import { getUploadedAttachmentName } from '../../../../shared/uploads'

import { ArtifactPreview } from './artifact-preview'
import { ComposerEditor } from './composer/ComposerEditor'
import { EditMessageConfirmDialog } from './EditMessageConfirmDialog'
import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'
import { providerKindKey } from '../settings/provider-form-value'
import { AgentFrameworkIcon, ProviderKindIcon } from '../settings/provider-icons'
import {
  docFromMessageParts,
  docFromText,
  docIsEmpty,
  docToText,
  emptyDoc,
  type ComposerDoc
} from './composer/composer-doc'
import {
  ARTIFACT_PREVIEW_BYTES,
  getArtifactName,
  isPendingArtifactPublication,
  shouldReadArtifactPreview
} from './artifact-preview-utils'
import {
  FILE_MISSING_TAG_KEY,
  isManagedFilePublicationPendingError,
  isUnavailableFileError
} from './previews/preview-errors'
import { useNearViewport } from './previews/useNearViewport'
import { useUnavailablePreviewProbe } from './previews/useUnavailablePreviewProbe'
import { resolveSessionProviderId } from './error-report'
import { SessionMessageMarkdown } from './SessionMessageMarkdown'
import { AnnotationDraftCards, AnnotationMessageCards } from './annotations/AnnotationCards'
import type { AnnotationPort } from './annotations/annotation-port'
import { requestAnnotationReveal } from './annotations/annotation-reveal'
import { requestPdfReadingReveal } from './pdf-reading-reveal'
import { TextAnnotationSurface } from './annotations/TextAnnotationSurface'
import {
  validateAnnotations,
  type Annotation,
  type AnnotationValidationError,
  type TextAnnotation
} from '../../../../shared/annotations'
import { annotationValidationMessage } from './annotations/annotation-validation-message'
import type { SendEditedMessage } from './workspace-edited-message'

type EditAnnotationTarget = {
  messageId: string
  add: (annotation: TextAnnotation) => AnnotationValidationError | undefined
}

type MessageArtifact = NonNullable<ChatSession['artifacts']>[number] & {
  resolvedProjectId?: string
  resolvedSessionId?: string
}
type MessageUploadAttachment = NonNullable<ChatMessage['uploads']>[number]
type MessageImage = NonNullable<ChatMessage['images']>[number]
type ArtifactMentionPart = Extract<MessagePart, { type: 'artifact' }>
type MessageRuntimeIdentity = Partial<
  Pick<PersistedRuntimeSegment, 'frameworkId' | 'backendId' | 'model'>
>
type WorkspaceAssistantTurnCompletionProps = {
  message: ChatMessage
  turnStartedAt?: number
  runtimeIdentity?: MessageRuntimeIdentity
  canBranchInNewSession?: boolean
  onBranchInNewSession?: (messageId: string) => void
}
type ReviewerCorrectionState = 'waiting' | 'responding' | 'completed' | 'failed'
type WorkspaceMessageItemProps = {
  message: ChatMessage
  projectId?: string
  onPreviewArtifact: (artifact: MessageArtifact) => void
  onPreviewArtifactModal?: (artifact: MessageArtifact) => void
  onPreviewUploadAttachment: (attachment: MessageUploadAttachment) => void
  onOpenSkillMention: (skillId: string, name: string) => void
  onPreviewMentionArtifact: (part: ArtifactMentionPart) => void
  artifacts?: MessageArtifact[]
  // Inline editing is only enabled once the session's run settles; confirming forks the
  // conversation at this message and resends the adjusted doc as a fresh turn.
  canEditMessage?: boolean
  // Immutable transcript surfaces can reuse the normal message renderer without live actions.
  showUserActions?: boolean
  // Renderer-only optimistic Composer submission; never persisted in the Session graph.
  sending?: boolean
  // Embedded transcript surfaces can supply their own horizontal gutter without changing live chat.
  contentPaddingClassName?: string
  onSendEditedMessage?: SendEditedMessage
  onEditAnnotationTargetChange?: (
    messageId: string,
    target: EditAnnotationTarget | undefined
  ) => void
  annotationPort?: AnnotationPort
  canBranchInNewSession?: boolean
  onBranchInNewSession?: (messageId: string) => void
  // Prompt send time for an Agent response; paired with its completion time for elapsed duration.
  turnStartedAt?: number
  // Per-turn runtime codes come from the Conversation Graph; names and icons resolve from Settings.
  runtimeIdentity?: MessageRuntimeIdentity
  // A tool-calling turn can contain several assistant fragments; only its final fragment owns the
  // whole-turn completion/elapsed/usage footer. Other transcript surfaces default to showing it.
  showAssistantFooter?: boolean
  // Number of user turns after this message; drives the destructive-resend warning threshold.
  subsequentTurns?: number
  revisionNavigation?: {
    index: number
    total: number
    onPrevious?: () => void
    onNext?: () => void
  }
  // Immutable Provenance uses the normal message surface but keeps mention pills non-interactive.
  // These path-free parts override message.parts only for display; editing still uses live parts.
  staticParts?: ProvenanceMessagePart[]
  onPresentationChange?: (messageId: string, presenting: boolean) => void
  presentationSourceOpen?: boolean
  presentationAnimateOnMount?: boolean
  // A trailing buffered reply can reserve the loading-row geometry it replaces. When another
  // live row remains below it, the message keeps only its natural text-line height.
  reserveLoadingRowHeight?: boolean
  // Durable lifecycle of an application-authored correction request. Keeping the response state
  // explicit prevents a missing historical response from looking like a successfully started one.
  reviewerCorrectionState?: ReviewerCorrectionState
}

const ARTIFACT_GALLERY_VISIBLE_COUNT = 5
const toMessageDate = (timestamp: number | undefined): Date | undefined => {
  if (timestamp === undefined) return undefined
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? undefined : date
}

const MessageTimestamp = ({
  label,
  date
}: {
  // Already-resolved copy: the caller owns which of sent/completed/failed applies.
  label: string
  date: Date
}): React.JSX.Element => {
  const formatDate = useDateTimeFormat()

  return (
    <time dateTime={date.toISOString()} title={formatDate(date, 'full')}>
      {label} {formatDate(date)}
    </time>
  )
}

const formatElapsedDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

type TurnTokenUsageEntry = readonly [
  label: string,
  value: number | undefined,
  markerClassName: string
]

const TurnTokenUsage = ({
  usage,
  runtimeIdentity
}: {
  usage?: AcpTurnTokenUsage
  runtimeIdentity?: MessageRuntimeIdentity
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const frameworks = useSettingsStore((state) =>
    open && runtimeIdentity ? state.agentFrameworks : undefined
  )
  const providers = useSettingsStore((state) =>
    open && runtimeIdentity ? state.providers : undefined
  )
  const framework = frameworks?.find((framework) => framework.id === runtimeIdentity?.frameworkId)
  const frameworkName = framework?.displayName
  const providerId = resolveSessionProviderId(runtimeIdentity?.backendId)
  const provider = providers?.find((candidate) => candidate.id === providerId)
  const kindKey = provider ? providerKindKey(provider.type, provider.vendorId) : undefined
  const model = runtimeIdentity?.model?.trim()
  const contentId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const openedFromPointerRef = useRef(false)
  const accessibleLabel = usage
    ? t('Token usage for this response')
    : t('Token usage unavailable for this response')
  const hasCacheBreakdown =
    usage?.cachedReadTokens !== undefined && usage.cachedWriteTokens !== undefined
  const entries: readonly TurnTokenUsageEntry[] = hasCacheBreakdown
    ? [
        [t('Input'), usage.inputTokens, 'bg-chart-1'],
        [t('Cache read'), usage.cachedReadTokens, 'bg-chart-1/40'],
        [t('Cache write'), usage.cachedWriteTokens, 'bg-chart-3'],
        [t('Output'), usage.outputTokens, 'bg-chart-2']
      ]
    : [
        [t('Input'), usage?.inputTokens, 'bg-chart-1'],
        [t('Cache'), usage?.cacheTokens, 'bg-chart-1/40'],
        [t('Output'), usage?.outputTokens, 'bg-chart-2']
      ]
  const totalTokens = usage ? usage.inputTokens + usage.cacheTokens + usage.outputTokens : undefined
  const safeTotalTokens = Number.isSafeInteger(totalTokens) ? totalTokens : undefined
  const breakdownLabel =
    usage && safeTotalTokens !== undefined
      ? t('{{entries}}; Total {{total}} tokens', {
          entries: entries
            .map(([label, value]) => `${label} ${formatDisplayNumber(value ?? 0)}`)
            .join(', '),
          total: formatDisplayNumber(safeTotalTokens)
        })
      : t('Token usage breakdown unavailable')

  const keepOpen = (): void => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = undefined
  }

  const scheduleClose = (): void => {
    keepOpen()
    closeTimerRef.current = setTimeout(() => {
      const focused = document.activeElement
      if (triggerRef.current?.contains(focused) || contentRef.current?.contains(focused)) return
      setOpen(false)
    }, 100)
  }

  const handleBlur = (event: FocusEvent<HTMLElement>): void => {
    const next = event.relatedTarget
    if (triggerRef.current?.contains(next) || contentRef.current?.contains(next)) return
    scheduleClose()
  }

  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    },
    []
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span data-slot="turn-token-usage" className="inline-flex whitespace-nowrap">
          <button
            ref={triggerRef}
            type="button"
            aria-label={accessibleLabel}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? contentId : undefined}
            className="inline-flex touch-manipulation items-center gap-1 border-b border-dashed border-current pb-px leading-none transition-colors duration-150 motion-reduce:transition-none hover:text-text-100 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onPointerEnter={() => {
              openedFromPointerRef.current = true
              keepOpen()
              setOpen(true)
            }}
            onPointerLeave={scheduleClose}
            onFocus={() => {
              openedFromPointerRef.current = false
              keepOpen()
              setOpen(true)
            }}
            onBlur={handleBlur}
            onClick={() => {
              openedFromPointerRef.current = false
              keepOpen()
              setOpen(true)
            }}
          >
            <CircleGauge
              data-slot="turn-token-usage-icon"
              className="size-3 shrink-0"
              strokeWidth={2}
              aria-hidden="true"
            />
            {t('Calls')}
          </button>
        </span>
      </PopoverAnchor>
      <PopoverContent
        ref={contentRef}
        id={contentId}
        data-slot="turn-token-usage-popover"
        aria-label={accessibleLabel}
        side="top"
        align="center"
        sideOffset={8}
        className="w-48 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-2.5 text-[12px] text-popover-foreground shadow-menu"
        onPointerEnter={keepOpen}
        onPointerLeave={scheduleClose}
        onFocusCapture={keepOpen}
        onBlurCapture={handleBlur}
        onOpenAutoFocus={(event) => {
          if (openedFromPointerRef.current) event.preventDefault()
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <div className="text-[13px] font-medium">{t('Calls')}</div>
            {frameworkName || provider ? (
              <div data-slot="turn-runtime-icons" className="flex items-center gap-1">
                {framework ? (
                  <span
                    data-slot="turn-runtime-framework"
                    role="img"
                    aria-label={t('Agent framework: {{name}}', { name: frameworkName })}
                    title={t('Agent framework: {{name}}', { name: frameworkName })}
                    className="inline-flex size-5 items-center justify-center rounded-full border border-border bg-background"
                  >
                    <AgentFrameworkIcon frameworkId={framework.id} size={12} />
                  </span>
                ) : null}
                {provider && kindKey ? (
                  <span
                    data-slot="turn-runtime-model"
                    role="img"
                    aria-label={
                      model
                        ? t('Model provider: {{name}}; model: {{model}}', {
                            name: provider.name,
                            model
                          })
                        : t('Model provider: {{name}}', { name: provider.name })
                    }
                    title={
                      model
                        ? t('Model provider: {{name}}; model: {{model}}', {
                            name: provider.name,
                            model
                          })
                        : t('Model provider: {{name}}', { name: provider.name })
                    }
                    className="inline-flex size-5 items-center justify-center rounded-full border border-border bg-background"
                  >
                    <ProviderKindIcon kindKey={kindKey} className="size-3" />
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          {usage?.turnCount ? (
            <div
              data-slot="turn-token-usage-turn-count"
              className="text-[10px] font-normal text-muted-foreground tabular-nums"
            >
              {t('{{count}} calls', { defaultValue_one: '{{count}} call', count: usage.turnCount })}
            </div>
          ) : null}
        </div>
        <div
          data-slot="turn-token-usage-breakdown"
          role="img"
          aria-label={breakdownLabel}
          className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted"
        >
          {safeTotalTokens && safeTotalTokens > 0
            ? entries.map(([label, value, markerClassName]) =>
                typeof value === 'number' && value > 0 ? (
                  <span
                    key={label}
                    data-slot="turn-token-usage-segment"
                    className={`${markerClassName} h-full min-w-0`}
                    style={{ flexBasis: 0, flexGrow: value }}
                    aria-hidden="true"
                  />
                ) : null
              )
            : null}
        </div>
        <dl className="mt-2 space-y-1.5">
          {entries.map(([label, value, markerClassName]) => (
            <div key={label} className="flex items-center justify-between gap-4 whitespace-nowrap">
              <dt className="flex items-center gap-2">
                <span
                  data-slot="turn-token-usage-marker"
                  className={`${markerClassName} size-2 shrink-0 rounded-full`}
                  aria-hidden="true"
                />
                {label}
              </dt>
              <dd className="tabular-nums text-muted-foreground">
                {typeof value === 'number' ? formatDisplayNumber(value) : '—'}
              </dd>
            </div>
          ))}
        </dl>
        <div
          data-slot="turn-token-usage-total"
          className="mt-2 flex items-center justify-between gap-4 border-t border-border pt-2 font-medium whitespace-nowrap"
        >
          <span>{t('Total')}</span>
          <span className="tabular-nums">
            {safeTotalTokens !== undefined ? formatDisplayNumber(safeTotalTokens) : '—'}
          </span>
        </div>
        {frameworkName || model ? (
          <div
            data-slot="turn-runtime-details"
            className="mt-2 space-y-0.5 border-t border-border pt-2 text-[11px] leading-4 text-muted-foreground"
          >
            {frameworkName ? (
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  data-slot="turn-runtime-agent-detail-icon"
                  aria-hidden="true"
                  className="flex size-3 shrink-0 items-center justify-center"
                >
                  <Bot className="size-2.5" strokeWidth={2} />
                </span>
                <span className="truncate">{t('Agent: {{name}}', { name: frameworkName })}</span>
              </div>
            ) : null}
            {model ? (
              <div className="flex min-w-0 items-center gap-1.5" title={model}>
                <span
                  data-slot="turn-runtime-model-detail-icon"
                  aria-hidden="true"
                  className="flex size-3 shrink-0 items-center justify-center"
                >
                  <Brain className="size-2.5" strokeWidth={2} />
                </span>
                <span className="truncate">{t('Model: {{model}}', { model })}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

const artifactCardClassName =
  'h-[82px] w-[128px] shrink-0 cursor-pointer overflow-hidden rounded-lg border border-border-200 bg-bg-000 text-left text-text-000 shadow-none transition-colors hover:bg-bg-200 active:bg-bg-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-200/60 disabled:cursor-not-allowed disabled:opacity-50'
const artifactPreviewClassName = 'h-[56px] w-full overflow-hidden bg-bg-200'
const artifactGalleryClassName = 'grid max-w-full grid-cols-[repeat(auto-fill,128px)] gap-2 pb-1'

const userMessageBubbleClassName =
  'max-w-[90%] break-words rounded-2xl bg-bg-300 px-3.5 py-2 text-sm text-message-user-text md:max-w-[min(85%,56rem)] md:px-4 md:py-2.5 md:text-[15px]'
const userMessageCollapseButtonClassName =
  'inline-flex items-center gap-1 whitespace-nowrap rounded-md text-[13px] font-medium text-text-200 transition-colors duration-200 ease-out hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 motion-reduce:active:translate-y-0 motion-reduce:transition-none'
const USER_MESSAGE_PREVIEW_LINE_COUNT = 12.5
// Hover actions sit left of the user bubble, revealed on row hover or keyboard focus.
const userMessageActionsClassName =
  'flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100'
const userMessageActionButtonClassName =
  'flex size-6 touch-manipulation items-center justify-center rounded-md text-text-300 transition-colors duration-200 ease-out hover:bg-bg-200 hover:text-text-100 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50'

const UserMessageActionTooltip = ({
  children,
  label
}: {
  children: React.ReactElement
  label: string
}): React.JSX.Element => (
  <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
)

// The terminal surface belongs to the whole Agent turn, not to the Message fragment that happens
// to carry its usage metadata. Timeline consumers can therefore place it after later owned work.
const WorkspaceAssistantTurnCompletion = ({
  message,
  turnStartedAt,
  runtimeIdentity,
  canBranchInNewSession = false,
  onBranchInNewSession
}: WorkspaceAssistantTurnCompletionProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const hasTurnUsage = Boolean(message.turnUsage || message.turnUsageUnavailable)
  const showTurnUsage = hasTurnUsage || (message.status === 'complete' && Boolean(runtimeIdentity))
  const timestamp =
    message.status === 'complete'
      ? message.completedAt
      : message.status === 'error'
        ? message.failedAt
        : undefined
  const terminalDate = toMessageDate(timestamp)
  const turnStartedDate = toMessageDate(turnStartedAt)
  const terminalLabel = message.status === 'error' ? t('Failed') : t('Completed')
  const [copied, setCopied] = useState(false)
  const copyResetTimeoutRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (copyResetTimeoutRef.current !== null) window.clearTimeout(copyResetTimeoutRef.current)
    },
    []
  )

  const handleCopyMessage = (): void => {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true)
      if (copyResetTimeoutRef.current !== null) window.clearTimeout(copyResetTimeoutRef.current)
      copyResetTimeoutRef.current = window.setTimeout(() => setCopied(false), 2000)
    })
  }

  if (!terminalDate && !(timestamp !== undefined && showTurnUsage)) return null

  return (
    <div
      data-slot="assistant-message-footer"
      className="mt-3 flex items-center gap-x-3 whitespace-nowrap text-[11px] leading-4 text-text-000/70 tabular-nums"
    >
      {message.status === 'complete' && onBranchInNewSession ? (
        <TooltipProvider delayDuration={200}>
          <div data-slot="assistant-message-actions" className="flex items-center gap-0.5">
            <UserMessageActionTooltip label={copied ? t('Copied') : t('Copy message')}>
              <button
                type="button"
                className={userMessageActionButtonClassName}
                aria-label={copied ? t('Copied') : t('Copy message')}
                onClick={handleCopyMessage}
              >
                {copied ? (
                  <Check className="size-3.5" strokeWidth={2} aria-hidden="true" />
                ) : (
                  <Copy className="size-3.5" strokeWidth={2} aria-hidden="true" />
                )}
              </button>
            </UserMessageActionTooltip>
            <UserMessageActionTooltip label={t('Branch in new session')}>
              <button
                type="button"
                className={userMessageActionButtonClassName}
                aria-label={t('Branch in new session')}
                disabled={!canBranchInNewSession}
                onClick={() => onBranchInNewSession(message.id)}
              >
                <GitBranch className="size-3.5" strokeWidth={2} aria-hidden="true" />
              </button>
            </UserMessageActionTooltip>
          </div>
        </TooltipProvider>
      ) : null}
      {terminalDate ? <MessageTimestamp label={terminalLabel} date={terminalDate} /> : null}
      {terminalDate && turnStartedDate ? (
        <span data-slot="assistant-message-elapsed-segment" className="whitespace-nowrap">
          <span aria-label={t('Elapsed run time')}>
            {t('Elapsed {{duration}}', {
              duration: formatElapsedDuration(terminalDate.getTime() - turnStartedDate.getTime())
            })}
          </span>
        </span>
      ) : null}
      {showTurnUsage ? (
        <TurnTokenUsage usage={message.turnUsage} runtimeIdentity={runtimeIdentity} />
      ) : null}
    </div>
  )
}
// Inline editing replaces the bubble with a bordered multi-line editor card aligned to the right.
const editCardClassName =
  'flex w-[85%] max-w-[56rem] flex-col gap-2 rounded-2xl border border-border-200 bg-bg-000 px-3 py-2 shadow-card'
const editCancelButtonClassName =
  'flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium text-text-300 transition-colors duration-200 ease-out hover:bg-bg-200 hover:text-text-100'
const editSendButtonClassName =
  'flex h-7 items-center rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-foreground transition-colors duration-200 ease-out hover:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-primary'
// The inline editor ignores pasted files; plain-text paste is handled by the editor itself.
const ignoreEditPaste = (): void => {}
// A branch-changing resend with several downstream turns asks for confirmation first.
const EDIT_TRUNCATION_WARNING_TURNS = 2
// Staged uploads render as gray file pills inside the sent bubble.
const uploadedAttachmentButtonClassName =
  'inline-flex max-w-full items-center gap-1.5 rounded-md border border-border-200 bg-bg-200 px-2 py-0.5 text-left text-[13px] leading-5 text-text-000 transition-colors hover:bg-bg-000 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-200/60'
// Shared pill shape for inline skill/artifact mentions in the sent bubble. Capped width + truncation
// keeps a long file/skill name from overflowing the bubble.
const mentionPillClassName =
  'inline-block max-w-[220px] truncate align-middle rounded px-1.5 py-0.5 mx-0.5 text-sm font-medium'
const artifactMentionPillClassName =
  'inline-flex max-w-[220px] align-middle rounded px-1.5 py-0.5 mx-0.5 text-sm font-medium'
// Interactive additions layered onto the pill shape when a mention resolves to a clickable target.
const mentionButtonClassName =
  'cursor-pointer hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-200/60'

const assistantMessageSurfaceClassName =
  'relative w-full max-w-[56rem] text-sm leading-relaxed text-text-000 md:text-[15px]'

const measurementContentClassName = 'before:content-[attr(data-content)]'

const MessagePartsMeasurement = ({
  parts,
  isStatic
}: {
  parts: Array<MessagePart | ProvenanceMessagePart>
  isStatic: boolean
}): React.JSX.Element => (
  <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
    {parts.map((part, index) => {
      if (part.type === 'skill') {
        return (
          <span
            key={index}
            data-slot="user-message-measurement-part"
            data-part-type="skill"
            data-content={`/${part.name}`}
            className={cn(mentionPillClassName, measurementContentClassName)}
          />
        )
      }

      if (part.type === 'artifact') {
        const isLinkedFolder = !isStatic && 'source' in part && part.source === 'linked-folder'
        return (
          <span
            key={index}
            data-slot="user-message-measurement-part"
            data-part-type="artifact"
            data-content={`@${isLinkedFolder ? part.relativePath : part.name}`}
            className={cn(
              isStatic ? mentionPillClassName : artifactMentionPillClassName,
              measurementContentClassName
            )}
          />
        )
      }

      if (part.type === 'session') {
        return (
          <span
            key={index}
            data-slot="user-message-measurement-part"
            data-part-type="session"
            data-content={`#${part.title}`}
            className={cn(mentionPillClassName, measurementContentClassName)}
          />
        )
      }

      return (
        <span
          key={index}
          data-slot="user-message-measurement-part"
          data-part-type="text"
          data-content={part.text}
          className={cn('whitespace-pre-wrap', measurementContentClassName)}
        />
      )
    })}
  </p>
)

type CollapsibleUserMessageContentProps = {
  children: ReactNode
  hasInteractiveContent: boolean
  message: ChatMessage
  staticParts?: ProvenanceMessagePart[]
}

/* Hallmark · component: user-message-collapse · genre: modern-minimal · theme: project tokens
 * states: default · hover · focus · active · disabled · expanded · collapsed
 * async states: not applicable (local synchronous disclosure)
 * contrast: project token contract · pre-emit critique: P5 H5 E5 S5 R5 V4
 */
const CollapsibleUserMessageContent = ({
  children,
  hasInteractiveContent,
  message,
  staticParts
}: CollapsibleUserMessageContentProps): React.JSX.Element => {
  const { t } = useTranslation()
  const contentId = useId()
  const measurementRef = useRef<HTMLDivElement>(null)
  const [isExpanded, setIsExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  const isCollapsed = canExpand && !isExpanded
  const measurementParts =
    staticParts && staticParts.length > 0
      ? staticParts
      : message.parts && message.parts.length > 0
        ? message.parts
        : undefined

  useLayoutEffect(() => {
    const measurement = measurementRef.current
    if (!measurement) return

    setIsExpanded(false)
    const measureOverflow = (): void => {
      const style = window.getComputedStyle(measurement)
      const parsedLineHeight = Number.parseFloat(style.lineHeight)
      const parsedFontSize = Number.parseFloat(style.fontSize)
      const lineHeight =
        Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
          ? parsedLineHeight < 4 && Number.isFinite(parsedFontSize)
            ? parsedLineHeight * parsedFontSize
            : parsedLineHeight
          : Number.isFinite(parsedFontSize) && parsedFontSize > 0
            ? parsedFontSize * 1.5
            : undefined
      const previewHeight = lineHeight ? lineHeight * USER_MESSAGE_PREVIEW_LINE_COUNT : undefined
      const overflows = previewHeight !== undefined && measurement.scrollHeight > previewHeight + 1
      setCanExpand(overflows)
      if (!overflows) setIsExpanded(false)
    }

    measureOverflow()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measureOverflow)
    observer.observe(measurement)
    return () => observer.disconnect()
  }, [message.content, message.id, message.parts, staticParts])

  return (
    <div className="relative">
      <div
        ref={measurementRef}
        data-slot="user-message-measurement"
        data-content={measurementParts ? undefined : message.content}
        aria-hidden="true"
        className={cn(
          'pointer-events-none invisible absolute inset-x-0 top-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]',
          !measurementParts && measurementContentClassName
        )}
      >
        {measurementParts ? (
          <MessagePartsMeasurement
            parts={measurementParts}
            isStatic={Boolean(staticParts && staticParts.length > 0)}
          />
        ) : null}
      </div>
      <div
        id={contentId}
        data-slot="user-message-content"
        className={cn(isCollapsed && 'max-h-[12.5lh] overflow-hidden')}
      >
        {isCollapsed && hasInteractiveContent ? (
          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {message.content}
          </p>
        ) : (
          children
        )}
      </div>
      {isCollapsed ? (
        <div
          data-slot="user-message-collapse-ellipsis"
          aria-hidden="true"
          className="mt-1 text-[13px] leading-5 text-text-200"
        >
          …
        </div>
      ) : null}
      {canExpand ? (
        <button
          type="button"
          data-slot="user-message-collapse-toggle"
          className={cn(userMessageCollapseButtonClassName, isCollapsed ? 'mt-1' : 'mt-2')}
          aria-label={isExpanded ? t('Show less') : t('Show more')}
          aria-expanded={isExpanded}
          aria-controls={contentId}
          onClick={() => setIsExpanded((expanded) => !expanded)}
        >
          <span>{isExpanded ? t('Show less') : t('Show more')}</span>
          {isExpanded ? (
            <ChevronUp className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden="true" />
          )}
        </button>
      ) : null}
    </div>
  )
}

// ACP message images are already MIME- and size-checked at runtime and persistence boundaries.
const MessageImageList = ({ images }: { images: MessageImage[] }): React.JSX.Element | null => {
  const { t } = useTranslation()

  if (images.length === 0) return null

  return (
    <div className="mt-3 grid max-w-full grid-cols-1 gap-3 sm:grid-cols-2">
      {images.map((image, index) => (
        <img
          key={image.id}
          src={`data:${image.mimeType};base64,${image.data}`}
          alt={t('Agent-generated image {{number}}', { number: index + 1 })}
          className="max-h-[40rem] w-auto max-w-full rounded-lg border border-border-200 bg-bg-000 object-contain"
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ))}
    </div>
  )
}

// Owns the bounded text data for one message thumbnail only while its card is near the viewport.
const VisibleArtifactPreview = ({
  artifact,
  requestKey
}: {
  artifact: MessageArtifact
  requestKey: string
}): React.JSX.Element => {
  const [previewState, setPreviewState] = useState<{
    requestKey: string
    preview: ArtifactPreviewResult | undefined
  } | null>(null)

  useEffect(() => {
    if (
      !shouldReadArtifactPreview(artifact) ||
      !artifact.resolvedProjectId ||
      !artifact.artifactId
    ) {
      return
    }

    let canceled = false
    void window.api.artifacts
      .readPreview({
        path: artifact.path,
        projectId: artifact.resolvedProjectId,
        ...(artifact.resolvedSessionId ? { sessionId: artifact.resolvedSessionId } : {}),
        fileId: artifact.artifactId,
        ...(artifact.versionId ? { versionId: artifact.versionId } : {}),
        maxBytes: ARTIFACT_PREVIEW_BYTES,
        encoding: 'utf8'
      })
      .then((preview) => {
        if (!canceled) setPreviewState({ requestKey, preview })
      })
      .catch((error: unknown) => {
        // Missing or cross-root files are represented by the card badge, not noisy console errors.
        if (!isUnavailableFileError(error) && !isManagedFilePublicationPendingError(error)) {
          console.error('Failed to read artifact preview', error)
        }
        if (!canceled) setPreviewState({ requestKey, preview: undefined })
      })

    return () => {
      canceled = true
    }
  }, [artifact, requestKey])

  const preview = previewState?.requestKey === requestKey ? previewState.preview : undefined
  return (
    <ArtifactPreview
      artifact={artifact}
      preview={preview}
      projectId={artifact.resolvedProjectId}
      sessionId={artifact.resolvedSessionId}
      managedFileId={artifact.artifactId}
      selectedVersionId={artifact.versionId}
      isVisible
    />
  )
}

// Thumbnail button for one generated file; clicking it previews the file instead of opening it.
const ArtifactCard = ({
  artifact,
  onPreviewArtifact
}: {
  artifact: MessageArtifact
  onPreviewArtifact: (artifact: MessageArtifact) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const artifactName = getArtifactName(artifact)
  const sizeLabel = formatByteSize(artifact.size) ?? ''
  const [setElement, isNearViewport] = useNearViewport<HTMLButtonElement>()
  const publicationPending = isPendingArtifactPublication(artifact)
  const requestKey = JSON.stringify([
    artifact.id,
    artifact.artifactId ?? null,
    artifact.resolvedProjectId ?? null,
    artifact.resolvedSessionId ?? null,
    artifact.path,
    artifact.size ?? null,
    artifact.mtimeMs ?? null
  ])
  const missing = useUnavailablePreviewProbe({
    enabled:
      isNearViewport &&
      !publicationPending &&
      Boolean(artifact.resolvedProjectId && artifact.artifactId),
    projectId: artifact.resolvedProjectId,
    sessionId: artifact.resolvedSessionId,
    managedFileId: artifact.artifactId,
    selectedVersionId: artifact.versionId,
    path: artifact.path,
    source: 'artifact',
    size: artifact.size,
    mtimeMs: artifact.mtimeMs
  })

  return (
    <button
      ref={setElement}
      type="button"
      className={cn('group flex min-w-0 flex-col', artifactCardClassName)}
      disabled={publicationPending}
      onClick={() => {
        onPreviewArtifact(artifact)
      }}
      aria-label={t('Preview generated file {{name}}', { name: artifactName })}
      title={artifact.path}
    >
      <div className={cn('relative', artifactPreviewClassName)}>
        <span className={cn('block size-full', missing && 'opacity-40')}>
          {/* Unmount the reader outside the overscan window so message history stays lightweight. */}
          {publicationPending ? null : isNearViewport ? (
            <VisibleArtifactPreview artifact={artifact} requestKey={requestKey} />
          ) : (
            <ArtifactPreview
              artifact={artifact}
              projectId={artifact.resolvedProjectId}
              sessionId={artifact.resolvedSessionId}
              managedFileId={artifact.artifactId}
              selectedVersionId={artifact.versionId}
              isVisible={false}
            />
          )}
        </span>
        {missing ? (
          <span className="absolute left-1 top-1 rounded bg-text-000/75 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-bg-000 shadow-sm">
            {t(FILE_MISSING_TAG_KEY)}
          </span>
        ) : null}
        <span
          data-slot="generated-artifact-open-icon"
          className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-md bg-bg-000/90 text-text-100 opacity-0 shadow-sm transition-[opacity,background-color,color] duration-150 hover:bg-bg-300 hover:text-text-000 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
          aria-hidden="true"
        >
          <ArrowUpRight className="size-4" strokeWidth={1.75} />
        </span>
      </div>
      <div className="flex min-w-0 flex-1 items-center px-1.5">
        <ExtensionPreservingFileName
          name={artifactName}
          className="flex-1 text-[12px] leading-5"
          compact
        />
        {sizeLabel ? (
          <span className="ml-1 shrink-0 text-[11px] text-text-000">{sizeLabel}</span>
        ) : null}
      </div>
    </button>
  )
}

// Renders the generated files attached to one assistant message.
const MessageArtifactList = ({
  onPreviewArtifact,
  artifacts
}: {
  onPreviewArtifact: (artifact: MessageArtifact) => void
  artifacts: MessageArtifact[]
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const visibleCount = expanded ? artifacts.length : ARTIFACT_GALLERY_VISIBLE_COUNT
  const visibleArtifacts = artifacts.slice(0, visibleCount)
  if (artifacts.length === 0) return null

  const remainingCount = artifacts.length - visibleArtifacts.length

  return (
    <div className="mt-3 border-t border-border-200 pt-3">
      <div className="mb-2 text-[11px] font-medium uppercase text-text-300">
        {t('GENERATED · {{count}}', { count: artifacts.length })}
      </div>
      <Collapsible.Root open={expanded} onOpenChange={setExpanded}>
        <div className={artifactGalleryClassName}>
          {visibleArtifacts.map((artifact) => (
            <ArtifactCard
              key={artifact.id}
              artifact={artifact}
              onPreviewArtifact={onPreviewArtifact}
            />
          ))}
          {remainingCount > 0 ? (
            <Collapsible.Trigger asChild>
              <button
                type="button"
                className={cn(
                  'flex items-center justify-center text-[13px] font-semibold',
                  artifactCardClassName
                )}
                aria-label={t('Expand generated files')}
              >
                {t('+{{count}} more', { context: 'files', count: remainingCount })}
              </button>
            </Collapsible.Trigger>
          ) : null}
          {expanded && artifacts.length > ARTIFACT_GALLERY_VISIBLE_COUNT ? (
            <Collapsible.Trigger asChild>
              <button
                type="button"
                className={cn(
                  'flex items-center justify-center text-[13px]',
                  artifactCardClassName
                )}
                aria-label={t('Collapse generated files')}
              >
                {t('Show less')}
              </button>
            </Collapsible.Trigger>
          ) : null}
        </div>
      </Collapsible.Root>
    </div>
  )
}

// Renders uploaded files inside the sent user bubble as gray file pills that open a preview.
const MessageUploadAttachmentList = ({
  attachments,
  onPreviewUploadAttachment
}: {
  attachments: MessageUploadAttachment[]
  onPreviewUploadAttachment: (attachment: MessageUploadAttachment) => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()

  if (attachments.length === 0) return null

  return (
    <div className="mb-1.5 flex flex-wrap items-start gap-1.5">
      {attachments.map((attachment) => {
        // Use the original display name so pasted/renamed files match the composer chip.
        const attachmentName = getUploadedAttachmentName(attachment)
        const Icon = attachment.mimeType?.startsWith('image/') ? ImageIcon : FileText

        return (
          <button
            key={attachment.id}
            type="button"
            className={uploadedAttachmentButtonClassName}
            onClick={() => {
              onPreviewUploadAttachment(attachment)
            }}
            aria-label={t('Preview uploaded attachment {{name}}', { name: attachmentName })}
            title={attachment.path}
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-text-300" aria-hidden="true" />
            <ExtensionPreservingFileName name={attachmentName} compact />
          </button>
        )
      })}
    </div>
  )
}

const MessagePdfReadingContext = ({
  message,
  projectId
}: {
  message: ChatMessage
  projectId?: string
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const context = message.pdfContext
  const position = context?.readingPosition
  const binding =
    context?.bindings.find((candidate) => candidate.bindingId === context.activeBindingId) ??
    context?.bindings[0]
  if (
    !projectId ||
    !position ||
    !binding ||
    resolvePdfPreparationScope(message.content, position) !== 'current-page'
  ) {
    return null
  }

  const label = `${t('Reading')} · ${t('Page {{page}}', { page: position.pageNumber })}`
  return (
    <div className="mb-1.5 flex">
      <button
        type="button"
        data-slot="message-pdf-reading-context"
        className="inline-flex items-center gap-1.5 rounded-md border border-border-200 bg-bg-200 px-2 py-0.5 text-[13px] leading-5 text-text-200 transition-colors hover:bg-bg-000 hover:text-text-000 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-200/60"
        aria-label={label}
        title={binding.name}
        onClick={() => requestPdfReadingReveal(projectId, binding, position.pageNumber)}
      >
        <BookOpenText className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
        <span>{label}</span>
      </button>
    </div>
  )
}

// Renders a user message's structured mention segments as inline styled pills.
const MessagePartsContent = ({
  parts,
  isStatic = false,
  onOpenSkillMention,
  onPreviewMentionArtifact
}: {
  parts: Array<MessagePart | ProvenanceMessagePart>
  isStatic?: boolean
  onOpenSkillMention: (skillId: string, name: string) => void
  onPreviewMentionArtifact: (part: ArtifactMentionPart) => void
}): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
      {parts.map((part, index) => {
        if (part.type === 'skill') {
          // A static (provenance) part carries no id, so it renders as a plain pill.
          if (isStatic || !('id' in part)) {
            return (
              <span
                key={index}
                className={cn(mentionPillClassName, 'bg-skill-chip text-skill-chip-foreground')}
              >
                /{part.name}
              </span>
            )
          }
          return (
            <button
              key={index}
              type="button"
              className={cn(
                mentionPillClassName,
                mentionButtonClassName,
                'bg-skill-chip text-skill-chip-foreground'
              )}
              onClick={() => onOpenSkillMention(part.id, part.name)}
              aria-label={t('Open skill {{name}}', { name: part.name })}
            >
              /{part.name}
            </button>
          )
        }
        if (part.type === 'artifact') {
          if (isStatic || !('source' in part)) {
            return (
              <span
                key={index}
                className={cn(mentionPillClassName, 'bg-mention-chip text-mention-chip-foreground')}
              >
                @{part.name}
              </span>
            )
          }
          // Linked-folder mentions read as a dark-gray `@` pill over the relative path; other
          // sources keep the green `@<name>` pill.
          if (part.source === 'linked-folder') {
            return (
              <button
                key={index}
                type="button"
                className={cn(
                  artifactMentionPillClassName,
                  mentionButtonClassName,
                  'bg-path-chip text-path-chip-foreground'
                )}
                onClick={() => onPreviewMentionArtifact(part)}
                aria-label={t('Preview {{name}}', { name: part.name })}
                title={`@${part.relativePath}`}
              >
                @{part.relativePath}
              </button>
            )
          }
          return (
            <button
              key={index}
              type="button"
              className={cn(
                artifactMentionPillClassName,
                mentionButtonClassName,
                'bg-mention-chip text-mention-chip-foreground'
              )}
              onClick={() => onPreviewMentionArtifact(part)}
              aria-label={t('Preview {{name}}', { name: part.name })}
            >
              @<ExtensionPreservingFileName name={part.name} />
            </button>
          )
        }

        if (part.type === 'session') {
          return (
            <button
              key={index}
              type="button"
              className={cn(
                mentionPillClassName,
                mentionButtonClassName,
                'bg-accent text-accent-foreground'
              )}
              onClick={() => useNavigationStore.getState().openSessionById(part.sessionId, 'user')}
              aria-label={t('Open session {{title}}', { title: part.title })}
              title={part.title}
            >
              #{part.title}
            </button>
          )
        }

        return (
          <span key={index} className="whitespace-pre-wrap">
            {part.text}
          </span>
        )
      })}
    </p>
  )
}

// Renders one chat message with user bubbles and full-width assistant markdown surfaces.
const WorkspaceMessageItemImpl = ({
  message,
  projectId,
  onPreviewArtifact,
  onPreviewArtifactModal = onPreviewArtifact,
  onPreviewUploadAttachment,
  onOpenSkillMention,
  onPreviewMentionArtifact,
  canEditMessage = false,
  showUserActions = true,
  sending = false,
  contentPaddingClassName,
  onSendEditedMessage,
  onEditAnnotationTargetChange,
  annotationPort,
  canBranchInNewSession = false,
  onBranchInNewSession,
  turnStartedAt,
  runtimeIdentity,
  showAssistantFooter = true,
  subsequentTurns = 0,
  revisionNavigation,
  artifacts = [],
  staticParts,
  onPresentationChange,
  presentationSourceOpen,
  presentationAnimateOnMount = true,
  reserveLoadingRowHeight = true,
  reviewerCorrectionState = 'failed'
}: WorkspaceMessageItemProps): React.JSX.Element => {
  const { t } = useTranslation()
  const isUserMessage = message.role === 'user'
  const isHumanUser = isHumanUserMessage(message)
  const reviewerCorrectionActive =
    reviewerCorrectionState === 'waiting' || reviewerCorrectionState === 'responding'
  const isReviewerCorrection = isReviewerCorrectionAttribution(message.attribution)
  const isComputeJobCompletion =
    isComputeJobCompletionAttribution(message.attribution) ||
    isComputeJobCompletionPresentation(message)
  const isSideChatAdvisory =
    message.relayedFrom?.kind === 'side-chat' && message.relayedFrom.direction === 'to-main'
  const presentsAssistantMessage = !isUserMessage && !isSideChatAdvisory
  const shouldAnimateAssistant = presentsAssistantMessage && message.status === 'streaming'
  // In-flight text lives outside the Message object during streaming so sibling transcript rows
  // keep stable props; only this row subscribes to its own per-tick content.
  const streamingContent = useSessionStore((state) =>
    shouldAnimateAssistant ? state.streamingMessages[message.id]?.content : undefined
  )
  const liveMessageContent = streamingContent ?? message.content
  const assistantSourceOpen = shouldAnimateAssistant && (presentationSourceOpen ?? true)
  const assistantPresentation = useSmoothStreamingContent(
    presentsAssistantMessage ? liveMessageContent : '',
    assistantSourceOpen,
    shouldAnimateAssistant && assistantSourceOpen && presentationAnimateOnMount
  )
  const isAssistantPresenting = presentsAssistantMessage && assistantPresentation.isPresenting

  // Keep later transcript items behind this message's visual buffer. Layout timing prevents a tool
  // boundary from painting once before the parent learns that this row is still presenting.
  useLayoutEffect(() => {
    if (!presentsAssistantMessage || !onPresentationChange) return
    onPresentationChange(message.id, isAssistantPresenting)
    return () => onPresentationChange(message.id, false)
  }, [isAssistantPresenting, message.id, onPresentationChange, presentsAssistantMessage])

  const uploads = message.uploads ?? []
  const sentDate = sending ? undefined : toMessageDate(message.createdAt)
  const showRevisionNavigation =
    showUserActions && isHumanUser && revisionNavigation && revisionNavigation.total > 1
  const [copied, setCopied] = useState(false)
  // Inline editing swaps the bubble for a multi-line editor; the doc starts from the message's
  // structured parts so mention chips survive the round-trip.
  const [isEditing, setIsEditing] = useState(false)
  const [editDoc, setEditDoc] = useState<ComposerDoc>(emptyDoc)
  const [editAnnotations, setEditAnnotations] = useState<Annotation[]>([])
  const [editError, setEditError] = useState<string>()
  const [isResendingEdit, setIsResendingEdit] = useState(false)
  // True while the destructive-resend confirmation dialog is open.
  const [isConfirmingEdit, setIsConfirmingEdit] = useState(false)
  // content-visibility:auto uses contain-intrinsic-size 10rem until a size is remembered. A
  // one-line streamed reply is ~44px; turning containment on at completion inflates it to 160px
  // and pushes a live tool below it. Keep this row out of that path for the rest of the mount.
  const skipContentVisibilityNow =
    message.status === 'streaming' || isAssistantPresenting || isEditing
  const [skipContentVisibility, setSkipContentVisibility] = useState(skipContentVisibilityNow)
  if (skipContentVisibilityNow && !skipContentVisibility) setSkipContentVisibility(true)
  const copyResetTimeoutRef = useRef<number | null>(null)
  const editButtonRef = useRef<HTMLButtonElement | null>(null)
  const editDocRef = useRef(editDoc)
  const editAnnotationsRef = useRef(editAnnotations)
  const restoreEditButtonFocusRef = useRef(false)
  const [editFocusRequest, setEditFocusRequest] = useState(0)

  const updateEditAnnotations = (next: Annotation[]): AnnotationValidationError | undefined => {
    const validation = validateAnnotations(next, docToText(editDocRef.current))
    if (validation) {
      setEditError(annotationValidationMessage(validation, t))
      return validation
    }
    editAnnotationsRef.current = next
    setEditAnnotations(next)
    setEditError(undefined)
    return undefined
  }

  const addEditAnnotation = (annotation: TextAnnotation): AnnotationValidationError | undefined =>
    updateEditAnnotations([...editAnnotationsRef.current, annotation])

  // Clear a pending copied-state reset so it never fires setState after unmount.
  useEffect(
    () => () => {
      if (copyResetTimeoutRef.current !== null) window.clearTimeout(copyResetTimeoutRef.current)
    },
    []
  )

  useLayoutEffect(() => {
    if (!isEditing && restoreEditButtonFocusRef.current) {
      restoreEditButtonFocusRef.current = false
      editButtonRef.current?.focus()
    }
  }, [isEditing])

  useEffect(
    () => () => {
      onEditAnnotationTargetChange?.(message.id, undefined)
    },
    [message.id, onEditAnnotationTargetChange]
  )

  // Copies the message text and briefly swaps the icon to confirm the clipboard write succeeded.
  const handleCopyMessage = (): void => {
    void navigator.clipboard.writeText(liveMessageContent).then(() => {
      setCopied(true)
      if (copyResetTimeoutRef.current !== null) window.clearTimeout(copyResetTimeoutRef.current)
      copyResetTimeoutRef.current = window.setTimeout(() => setCopied(false), 2000)
    })
  }

  // Opens the inline editor with the prompt rebuilt as a composer doc (mention chips restored when
  // the message carries structured parts, plain text otherwise).
  const handleStartEdit = (): void => {
    const nextDoc =
      message.parts && message.parts.length > 0
        ? docFromMessageParts(message.parts)
        : docFromText(message.content)
    editDocRef.current = nextDoc
    setEditDoc(nextDoc)
    const annotations = [...(message.annotations ?? [])]
    editAnnotationsRef.current = annotations
    setEditAnnotations(annotations)
    setEditError(undefined)
    setIsEditing(true)
    setEditFocusRequest((request) => request + 1)
    onEditAnnotationTargetChange?.(message.id, {
      messageId: message.id,
      add: addEditAnnotation
    })
  }

  const handleCancelEdit = (): void => {
    setEditError(undefined)
    restoreEditButtonFocusRef.current = true
    onEditAnnotationTargetChange?.(message.id, undefined)
    setIsEditing(false)
  }

  // The destructive resend itself: the conversation is truncated at this message and the adjusted
  // prompt is resent as a fresh turn, then the editor closes.
  const confirmEditedResend = async (): Promise<void> => {
    if (!onSendEditedMessage || isResendingEdit) return
    setIsResendingEdit(true)
    setEditError(undefined)
    try {
      const result = await onSendEditedMessage(message.id, editDoc, [...editAnnotations])
      if (!result.ok) {
        setEditError(t(result.displayMessage ?? 'Something went wrong. Try again.'))
        return
      }
      setIsConfirmingEdit(false)
      onEditAnnotationTargetChange?.(message.id, undefined)
      setIsEditing(false)
    } catch {
      setEditError(t('Something went wrong. Try again.'))
    } finally {
      setIsResendingEdit(false)
    }
  }

  // Confirms the inline edit; with several later turns changing visibility, ask before branching.
  const handleConfirmEdit = (): void => {
    if (!canEditMessage || (docIsEmpty(editDoc) && editAnnotations.length === 0)) return
    const validation = validateAnnotations(editAnnotations, docToText(editDoc))
    if (validation) {
      setEditError(annotationValidationMessage(validation, t))
      return
    }

    if (subsequentTurns >= EDIT_TRUNCATION_WARNING_TURNS) {
      setIsConfirmingEdit(true)
      return
    }

    confirmEditedResend()
  }

  const userMessageContent =
    staticParts && staticParts.length > 0 ? (
      <MessagePartsContent
        parts={staticParts}
        isStatic
        onOpenSkillMention={onOpenSkillMention}
        onPreviewMentionArtifact={onPreviewMentionArtifact}
      />
    ) : message.parts && message.parts.length > 0 ? (
      <MessagePartsContent
        parts={message.parts}
        onOpenSkillMention={onOpenSkillMention}
        onPreviewMentionArtifact={onPreviewMentionArtifact}
      />
    ) : message.content ? (
      <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.content}</p>
    ) : null
  const hasInteractiveUserMessageContent = Boolean(
    !staticParts &&
    message.parts?.some(
      (part) => part.type === 'skill' || part.type === 'artifact' || part.type === 'session'
    )
  )

  return (
    <MessageScrollerItem
      key={message.id}
      messageId={message.id}
      disableContainment={skipContentVisibilityNow || skipContentVisibility}
      scrollAnchor={message.role === 'user'}
      className="min-w-0"
    >
      <div className={cn('px-4 pb-1 pt-5 md:px-6', contentPaddingClassName)}>
        {/* User prompts stay compact; assistant responses remain a readable transcript surface. */}
        {isComputeJobCompletion ? (
          <div
            data-testid="compute-job-completion-event"
            className="flex max-w-[56rem] items-start gap-2 rounded-lg bg-bg-200 px-3 py-2 text-xs text-text-300"
            role="status"
          >
            <Bot className="mt-0.5 size-3.5 shrink-0 text-text-300" aria-hidden="true" />
            <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
              <span className="font-medium text-text-200">{t('Remote job completed')}</span>
              <span className="text-text-300">{t('Analysis started automatically')}</span>
            </div>
          </div>
        ) : isReviewerCorrection ? (
          <div
            data-testid="reviewer-correction-message"
            data-active={reviewerCorrectionActive || undefined}
            className="flex max-w-[56rem] items-start gap-2 rounded-lg bg-bg-200 px-3 py-2 text-xs text-text-300"
            role="status"
            aria-live={reviewerCorrectionActive ? 'polite' : undefined}
          >
            {reviewerCorrectionActive ? (
              <CircleGauge
                data-testid="reviewer-correction-active-icon"
                className="mt-0.5 size-3.5 shrink-0 animate-spin text-text-300 motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : reviewerCorrectionState === 'completed' ? (
              <Check
                data-testid="reviewer-correction-settled-icon"
                className="mt-0.5 size-3.5 shrink-0 text-text-300"
                aria-hidden="true"
              />
            ) : (
              <CircleAlert
                data-testid="reviewer-correction-failed-icon"
                className="mt-0.5 size-3.5 shrink-0 text-status-warning-foreground dark:text-status-warning-dark-foreground"
                aria-hidden="true"
              />
            )}
            <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
              <span className="font-medium text-text-200">
                {reviewerCorrectionState === 'waiting'
                  ? t('Reviewer requested corrections')
                  : t('Corrections requested')}
              </span>
              {reviewerCorrectionState === 'waiting' && (
                <span className="text-text-300">{t('Agent is addressing the feedback')}</span>
              )}
              {reviewerCorrectionState === 'responding' && (
                <span className="text-text-300">
                  {t('Handed off to the Agent · response started')}
                </span>
              )}
              {reviewerCorrectionState === 'completed' && (
                <span className="text-text-300">{t('Response completed.')}</span>
              )}
              {reviewerCorrectionState === 'failed' && (
                <span className="text-text-300">{t('Response failed.')}</span>
              )}
            </div>
          </div>
        ) : isSideChatAdvisory ? (
          <div
            data-testid="side-chat-advisory"
            className="flex min-w-0 items-center gap-2 rounded-xl bg-bg-200 px-3 py-2 text-[13px] text-text-100"
          >
            <MessageCircleMore className="size-4 shrink-0 text-text-300" aria-hidden="true" />
            <span className="shrink-0 font-medium">{t('Side chat')}</span>
            <span className="min-w-0 truncate">{message.content}</span>
          </div>
        ) : isUserMessage ? (
          isEditing ? (
            <div className="flex justify-end">
              {/* Inline editing swaps the bubble for a multi-line editor; confirm resends the prompt. */}
              <div className={editCardClassName} aria-busy={isResendingEdit}>
                <MessageUploadAttachmentList
                  attachments={uploads}
                  onPreviewUploadAttachment={onPreviewUploadAttachment}
                />
                {uploads.length > 0 ? (
                  <hr
                    role="separator"
                    className="-mt-1.5 w-full border-0 border-t border-border-200"
                  />
                ) : null}
                <AnnotationDraftCards
                  annotations={editAnnotations}
                  disabled={!canEditMessage || isResendingEdit}
                  onReveal={requestAnnotationReveal}
                  onUpdateNote={(id, note) => {
                    const next = editAnnotations.map((annotation) =>
                      annotation.id === id
                        ? annotation.kind === 'text'
                          ? { ...annotation, note: note.trim() || undefined }
                          : { ...annotation, note: note.trim() }
                        : annotation
                    )
                    return updateEditAnnotations(next)
                  }}
                  onRemove={(id) => {
                    updateEditAnnotations(
                      editAnnotationsRef.current.filter((annotation) => annotation.id !== id)
                    )
                  }}
                />
                <ComposerEditor
                  doc={editDoc}
                  onDocChange={(next) => {
                    editDocRef.current = next
                    setEditDoc(next)
                    const validation = validateAnnotations(editAnnotations, docToText(next))
                    setEditError(
                      validation ? annotationValidationMessage(validation, t) : undefined
                    )
                  }}
                  onSubmit={handleConfirmEdit}
                  onPaste={ignoreEditPaste}
                  placeholder={t('Edit your message')}
                  ariaLabel={t('Edit message')}
                  focusRequest={editFocusRequest}
                />
                {editError ? (
                  <div
                    role="alert"
                    className="[&>section]:max-w-none [&>section]:gap-2 [&_h1]:text-xs"
                  >
                    <ErrorNotice tone="red" title={editError} />
                  </div>
                ) : null}
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    className={editCancelButtonClassName}
                    disabled={isResendingEdit}
                    onClick={handleCancelEdit}
                  >
                    {t('Cancel')}
                  </button>
                  <button
                    type="button"
                    className={editSendButtonClassName}
                    disabled={
                      !canEditMessage ||
                      isResendingEdit ||
                      (docIsEmpty(editDoc) && editAnnotations.length === 0)
                    }
                    onClick={handleConfirmEdit}
                  >
                    {isResendingEdit ? (
                      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                    ) : null}
                    {t('Send')}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="group flex flex-col items-end">
              <div
                data-slot="user-bubble-row"
                className="flex w-full max-w-full items-center justify-end gap-1"
              >
                {/* Copy/edit controls stay left of the bubble; Branch navigation lives below it. */}
                {showUserActions && isHumanUser ? (
                  <TooltipProvider delayDuration={200}>
                    <div data-slot="user-message-actions" className={userMessageActionsClassName}>
                      <UserMessageActionTooltip label={copied ? t('Copied') : t('Copy message')}>
                        <button
                          type="button"
                          className={userMessageActionButtonClassName}
                          aria-label={copied ? t('Copied') : t('Copy message')}
                          onClick={handleCopyMessage}
                        >
                          {copied ? (
                            <Check className="size-3.5" strokeWidth={2} aria-hidden="true" />
                          ) : (
                            <Copy className="size-3.5" strokeWidth={2} aria-hidden="true" />
                          )}
                        </button>
                      </UserMessageActionTooltip>
                      <UserMessageActionTooltip label={t('Edit message')}>
                        <button
                          ref={editButtonRef}
                          type="button"
                          className={userMessageActionButtonClassName}
                          aria-label={t('Edit message')}
                          disabled={!canEditMessage}
                          onClick={handleStartEdit}
                        >
                          <Pencil className="size-3.5" strokeWidth={2} aria-hidden="true" />
                        </button>
                      </UserMessageActionTooltip>
                    </div>
                  </TooltipProvider>
                ) : null}
                <div data-slot="user-message-bubble" className={userMessageBubbleClassName}>
                  <MessagePdfReadingContext message={message} projectId={projectId} />
                  <AnnotationMessageCards
                    annotations={message.annotations ?? []}
                    onReveal={requestAnnotationReveal}
                  />
                  <MessageUploadAttachmentList
                    attachments={uploads}
                    onPreviewUploadAttachment={onPreviewUploadAttachment}
                  />
                  {/* Structured parts drive styled pills; plain content is the backward-compatible fallback. */}
                  {isHumanUser && userMessageContent ? (
                    <CollapsibleUserMessageContent
                      hasInteractiveContent={hasInteractiveUserMessageContent}
                      message={message}
                      staticParts={staticParts}
                    >
                      {userMessageContent}
                    </CollapsibleUserMessageContent>
                  ) : (
                    userMessageContent
                  )}
                </div>
              </div>
              {sending || sentDate || message.interrupted || showRevisionNavigation ? (
                <div
                  data-slot="user-message-footer"
                  className="mt-1 flex min-h-6 w-full flex-wrap items-center justify-end gap-x-2 text-[11px] leading-4 text-text-000/70 tabular-nums"
                >
                  {sending ? (
                    <span className="flex items-center gap-1" role="status" aria-live="polite">
                      <Loader2
                        className="size-3 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                      {t('Sending…')}
                    </span>
                  ) : null}
                  {message.interrupted ? (
                    <span
                      data-slot="user-message-interrupted"
                      className="italic text-amber-600 dark:text-amber-400"
                    >
                      {t('This turn was interrupted.')}
                    </span>
                  ) : null}
                  {sentDate ? <MessageTimestamp label={t('Sent')} date={sentDate} /> : null}
                  {showRevisionNavigation ? (
                    <TooltipProvider delayDuration={200}>
                      <div
                        data-slot="user-message-revision-navigation"
                        className="flex items-center gap-0.5 text-[13px] text-text-100"
                      >
                        <UserMessageActionTooltip label={t('Previous message revision')}>
                          <button
                            type="button"
                            className={userMessageActionButtonClassName}
                            aria-label={t('Previous message revision')}
                            disabled={!revisionNavigation.onPrevious || !canEditMessage}
                            onClick={revisionNavigation.onPrevious}
                          >
                            <ChevronLeft className="size-3.5" aria-hidden="true" />
                          </button>
                        </UserMessageActionTooltip>
                        <GitBranch
                          data-slot="user-message-revision-icon"
                          className="size-3.5 text-text-300"
                          aria-hidden="true"
                        />
                        <span aria-label={t('Message revision')} className="min-w-7 text-center">
                          {revisionNavigation.index + 1}/{revisionNavigation.total}
                        </span>
                        <UserMessageActionTooltip label={t('Next message revision')}>
                          <button
                            type="button"
                            className={userMessageActionButtonClassName}
                            aria-label={t('Next message revision')}
                            disabled={!revisionNavigation.onNext || !canEditMessage}
                            onClick={revisionNavigation.onNext}
                          >
                            <ChevronRight className="size-3.5" aria-hidden="true" />
                          </button>
                        </UserMessageActionTooltip>
                      </div>
                    </TooltipProvider>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        ) : (
          <div
            className={cn(
              assistantMessageSurfaceClassName,
              'select-text overflow-visible',
              // Reserve the tallest loading-row geometry only when this reply replaces that row.
              // If Thinking or a live tool remains below, the buffered message stays at line height.
              isAssistantPresenting && (reserveLoadingRowHeight ? 'min-h-14' : 'min-h-5')
            )}
          >
            {liveMessageContent ? (
              annotationPort ? (
                <TextAnnotationSurface
                  source={{
                    kind: 'agent-message',
                    sessionId: annotationPort.sessionId,
                    messageId: message.id
                  }}
                  activeAnnotations={annotationPort.activeAnnotations}
                  onAdd={annotationPort.onAdd}
                  onUpdateNote={annotationPort.onUpdateNote}
                  onError={annotationPort.onError}
                  isAnimating={isAssistantPresenting}
                >
                  <SessionMessageMarkdown
                    content={assistantPresentation.content}
                    isAnimating={isAssistantPresenting}
                    artifacts={artifacts}
                    onPreviewArtifact={onPreviewArtifact}
                    onPreviewArtifactModal={onPreviewArtifactModal}
                  />
                </TextAnnotationSurface>
              ) : (
                <SessionMessageMarkdown
                  content={assistantPresentation.content}
                  isAnimating={isAssistantPresenting}
                  artifacts={artifacts}
                  onPreviewArtifact={onPreviewArtifact}
                  onPreviewArtifactModal={onPreviewArtifactModal}
                />
              )
            ) : null}
            <MessageImageList images={message.images ?? []} />
            <MessageArtifactList onPreviewArtifact={onPreviewArtifact} artifacts={artifacts} />
            {showAssistantFooter && !isAssistantPresenting ? (
              <WorkspaceAssistantTurnCompletion
                message={message}
                turnStartedAt={turnStartedAt}
                runtimeIdentity={runtimeIdentity}
                canBranchInNewSession={canBranchInNewSession}
                onBranchInNewSession={onBranchInNewSession}
              />
            ) : null}
          </div>
        )}
      </div>
      <EditMessageConfirmDialog
        open={isConfirmingEdit}
        subsequentTurns={subsequentTurns}
        onCancel={() => setIsConfirmingEdit(false)}
        onConfirm={confirmEditedResend}
      />
    </MessageScrollerItem>
  )
}

// The scroller resolves artifacts fresh on every transcript rebuild, but the referenced artifact
// objects keep their identity (the store projects immutably), so compare element by element.
const areMessageArtifactsEqual = (
  previous: MessageArtifact[] | undefined,
  next: MessageArtifact[] | undefined
): boolean => {
  if (previous === next) return true
  const previousArtifacts = previous ?? []
  const nextArtifacts = next ?? []
  return (
    previousArtifacts.length === nextArtifacts.length &&
    previousArtifacts.every((artifact, index) => artifact === nextArtifacts[index])
  )
}

// Only these three fields are rendered (turn usage popover); the scroller may pass a whole
// runtime segment whose other fields are irrelevant here.
const areRuntimeIdentitiesEqual = (
  previous: MessageRuntimeIdentity | undefined,
  next: MessageRuntimeIdentity | undefined
): boolean =>
  previous === next ||
  (previous !== undefined &&
    next !== undefined &&
    previous.frameworkId === next.frameworkId &&
    previous.backendId === next.backendId &&
    previous.model === next.model)

const areTextAnnotationsEqual = (
  previous: readonly TextAnnotation[] | undefined,
  next: readonly TextAnnotation[] | undefined
): boolean => {
  if (previous === next) return true
  const left = previous ?? []
  const right = next ?? []
  return (
    left.length === right.length && left.every((annotation, index) => annotation === right[index])
  )
}

const areAnnotationPortsEqual = (
  previous: AnnotationPort | undefined,
  next: AnnotationPort | undefined
): boolean =>
  previous === next ||
  (previous !== undefined &&
    next !== undefined &&
    previous.sessionId === next.sessionId &&
    areTextAnnotationsEqual(previous.activeAnnotations, next.activeAnnotations) &&
    previous.onAdd === next.onAdd &&
    previous.onUpdateNote === next.onUpdateNote &&
    previous.onError === next.onError)

// The scroller rebuilds this object (with fresh closures) on every render. The closures only
// capture the session id and a revision's branch id, both of which change only together with
// index/total or the message itself, so those fields fully determine what a re-render would show.
const areRevisionNavigationsEqual = (
  previous: WorkspaceMessageItemProps['revisionNavigation'],
  next: WorkspaceMessageItemProps['revisionNavigation']
): boolean =>
  previous === next ||
  (previous !== undefined &&
    next !== undefined &&
    previous.index === next.index &&
    previous.total === next.total &&
    (previous.onPrevious === undefined) === (next.onPrevious === undefined) &&
    (previous.onNext === undefined) === (next.onNext === undefined))

// Streaming rebuilds the transcript once per chunk; a message whose object identity is unchanged
// renders identically, so bail out before re-running the Markdown pipeline for it.
const areWorkspaceMessageItemPropsEqual = (
  previous: WorkspaceMessageItemProps,
  next: WorkspaceMessageItemProps
): boolean =>
  previous.message === next.message &&
  previous.projectId === next.projectId &&
  previous.onPreviewArtifact === next.onPreviewArtifact &&
  previous.onPreviewArtifactModal === next.onPreviewArtifactModal &&
  previous.onPreviewUploadAttachment === next.onPreviewUploadAttachment &&
  previous.onOpenSkillMention === next.onOpenSkillMention &&
  previous.onPreviewMentionArtifact === next.onPreviewMentionArtifact &&
  previous.onSendEditedMessage === next.onSendEditedMessage &&
  previous.onEditAnnotationTargetChange === next.onEditAnnotationTargetChange &&
  areAnnotationPortsEqual(previous.annotationPort, next.annotationPort) &&
  (previous.canBranchInNewSession ?? false) === (next.canBranchInNewSession ?? false) &&
  previous.onBranchInNewSession === next.onBranchInNewSession &&
  (previous.canEditMessage ?? false) === (next.canEditMessage ?? false) &&
  (previous.showUserActions ?? true) === (next.showUserActions ?? true) &&
  (previous.sending ?? false) === (next.sending ?? false) &&
  previous.contentPaddingClassName === next.contentPaddingClassName &&
  previous.turnStartedAt === next.turnStartedAt &&
  (previous.showAssistantFooter ?? true) === (next.showAssistantFooter ?? true) &&
  (previous.subsequentTurns ?? 0) === (next.subsequentTurns ?? 0) &&
  previous.staticParts === next.staticParts &&
  areMessageArtifactsEqual(previous.artifacts, next.artifacts) &&
  areRuntimeIdentitiesEqual(previous.runtimeIdentity, next.runtimeIdentity) &&
  areRevisionNavigationsEqual(previous.revisionNavigation, next.revisionNavigation) &&
  previous.onPresentationChange === next.onPresentationChange &&
  (previous.presentationSourceOpen ?? true) === (next.presentationSourceOpen ?? true) &&
  (previous.presentationAnimateOnMount ?? true) === (next.presentationAnimateOnMount ?? true) &&
  (previous.reserveLoadingRowHeight ?? true) === (next.reserveLoadingRowHeight ?? true)

const WorkspaceMessageItem = memo(WorkspaceMessageItemImpl, areWorkspaceMessageItemPropsEqual)
WorkspaceMessageItem.displayName = 'WorkspaceMessageItem'

export { MessageArtifactList, WorkspaceAssistantTurnCompletion, WorkspaceMessageItem }
export type { ArtifactMentionPart, EditAnnotationTarget }
