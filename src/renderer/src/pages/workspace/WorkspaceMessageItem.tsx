import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, formatByteSize } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import type { ChatMessage, ChatSession } from '@/stores/session-store'
import { Collapsible } from 'radix-ui'
import {
  Bot,
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleGauge,
  Copy,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Pencil
} from 'lucide-react'
import { useEffect, useId, useRef, useState, type FocusEvent } from 'react'
import type { ArtifactPreviewResult } from '../../../../shared/artifacts'
import type { ProvenanceMessagePart } from '../../../../shared/artifact-provenance'
import type { AcpTurnTokenUsage } from '../../../../shared/acp'
import type { PersistedRuntimeSegment } from '../../../../shared/conversation-graph'
import type { MessagePart } from '../../../../shared/session-persistence'
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
  emptyDoc,
  type ComposerDoc
} from './composer/composer-doc'
import {
  ARTIFACT_PREVIEW_BYTES,
  getArtifactName,
  shouldReadArtifactPreview
} from './artifact-preview-utils'
import { FILE_MISSING_TAG, isUnavailableFileError } from './previews/preview-errors'
import { useNearViewport } from './previews/useNearViewport'
import { useUnavailablePreviewProbe } from './previews/useUnavailablePreviewProbe'
import { resolveSessionProviderId } from './error-report'

type MessageArtifact = NonNullable<ChatSession['artifacts']>[number]
type MessageUploadAttachment = NonNullable<ChatMessage['uploads']>[number]
type MessageImage = NonNullable<ChatMessage['images']>[number]
type ArtifactMentionPart = Extract<MessagePart, { type: 'artifact' }>
type MessageRuntimeIdentity = Partial<
  Pick<PersistedRuntimeSegment, 'frameworkId' | 'backendId' | 'model'>
>
type WorkspaceMessageItemProps = {
  message: ChatMessage
  onPreviewArtifact: (artifact: MessageArtifact) => void
  onPreviewUploadAttachment: (attachment: MessageUploadAttachment) => void
  onOpenSkillMention: (skillId: string, name: string) => void
  onPreviewMentionArtifact: (part: ArtifactMentionPart) => void
  artifacts?: MessageArtifact[]
  // Inline editing is only enabled once the session's run settles; confirming forks the
  // conversation at this message and resends the adjusted doc as a fresh turn.
  canEditMessage?: boolean
  // Immutable transcript surfaces can reuse the normal message renderer without live actions.
  showUserActions?: boolean
  // Embedded transcript surfaces can supply their own horizontal gutter without changing live chat.
  contentPaddingClassName?: string
  onSendEditedMessage?: (messageId: string, doc: ComposerDoc) => void
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
}

const ARTIFACT_GALLERY_VISIBLE_COUNT = 5
const tokenCountFormatter = new Intl.NumberFormat('en-US')
const messageTimestampFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})
const messageTimestampTitleFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'full',
  timeStyle: 'long'
})

const toMessageDate = (timestamp: number | undefined): Date | undefined => {
  if (timestamp === undefined) return undefined
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? undefined : date
}

const MessageTimestamp = ({
  label,
  date
}: {
  label: 'Sent' | 'Completed' | 'Failed'
  date: Date
}): React.JSX.Element => {
  return (
    <time dateTime={date.toISOString()} title={messageTimestampTitleFormatter.format(date)}>
      {label} {messageTimestampFormatter.format(date)}
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
  const [open, setOpen] = useState(false)
  const frameworks = useSettingsStore((state) =>
    open && runtimeIdentity ? state.agentFrameworks : undefined
  )
  const providers = useSettingsStore((state) =>
    open && runtimeIdentity ? state.providers : undefined
  )
  const frameworkName = frameworks?.find(
    (framework) => framework.id === runtimeIdentity?.frameworkId
  )?.displayName
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
    ? 'Token usage for this response'
    : 'Token usage unavailable for this response'
  const hasCacheBreakdown =
    usage?.cachedReadTokens !== undefined && usage.cachedWriteTokens !== undefined
  const entries: readonly TurnTokenUsageEntry[] = hasCacheBreakdown
    ? [
        ['Input', usage.inputTokens, 'bg-chart-2'],
        ['Cache read', usage.cachedReadTokens, 'bg-chart-4'],
        ['Cache write', usage.cachedWriteTokens, 'bg-chart-3'],
        ['Output', usage.outputTokens, 'bg-chart-1']
      ]
    : [
        ['Input', usage?.inputTokens, 'bg-chart-2'],
        ['Cache', usage?.cacheTokens, 'bg-chart-4'],
        ['Output', usage?.outputTokens, 'bg-chart-1']
      ]
  const totalTokens = usage ? usage.inputTokens + usage.cacheTokens + usage.outputTokens : undefined
  const safeTotalTokens = Number.isSafeInteger(totalTokens) ? totalTokens : undefined
  const breakdownLabel =
    usage && safeTotalTokens !== undefined
      ? `${entries
          .map(([label, value]) => `${label} ${tokenCountFormatter.format(value ?? 0)}`)
          .join(', ')}; Total ${tokenCountFormatter.format(safeTotalTokens)} tokens`
      : 'Token usage breakdown unavailable'

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
            Usage
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
            <div className="text-[13px] font-medium">Usage</div>
            {frameworkName || provider ? (
              <div data-slot="turn-runtime-icons" className="flex items-center gap-1">
                {frameworkName && runtimeIdentity?.frameworkId ? (
                  <span
                    data-slot="turn-runtime-framework"
                    role="img"
                    aria-label={`Agent framework: ${frameworkName}`}
                    title={`Agent framework: ${frameworkName}`}
                    className="inline-flex size-5 items-center justify-center rounded-full border border-border bg-background"
                  >
                    <AgentFrameworkIcon frameworkId={runtimeIdentity.frameworkId} size={12} />
                  </span>
                ) : null}
                {provider && kindKey ? (
                  <span
                    data-slot="turn-runtime-model"
                    role="img"
                    aria-label={`Model provider: ${provider.name}${model ? `; model: ${model}` : ''}`}
                    title={`Model provider: ${provider.name}${model ? `; model: ${model}` : ''}`}
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
              {usage.turnCount} {usage.turnCount === 1 ? 'turn' : 'turns'}
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
                {typeof value === 'number' ? tokenCountFormatter.format(value) : '—'}
              </dd>
            </div>
          ))}
        </dl>
        <div
          data-slot="turn-token-usage-total"
          className="mt-2 flex items-center justify-between gap-4 border-t border-border pt-2 font-medium whitespace-nowrap"
        >
          <span>Total</span>
          <span className="tabular-nums">
            {safeTotalTokens !== undefined ? tokenCountFormatter.format(safeTotalTokens) : '—'}
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
                <span className="truncate">Agent: {frameworkName}</span>
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
                <span className="truncate">Model: {model}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

const artifactCardClassName =
  'h-[82px] w-[128px] shrink-0 overflow-hidden rounded-lg border border-border-200 bg-bg-000 text-left text-text-000 shadow-none transition-colors hover:bg-bg-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-200/60'
const artifactPreviewClassName = 'h-[56px] w-full overflow-hidden bg-bg-200'
const artifactGalleryClassName = 'grid max-w-full grid-cols-[repeat(auto-fill,128px)] gap-2 pb-1'

const userMessageBubbleClassName =
  'max-w-[90%] break-words rounded-2xl bg-bg-300 px-3.5 py-2 text-sm text-message-user-text md:max-w-[min(85%,56rem)] md:px-4 md:py-2.5 md:text-[15px]'
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

// ACP message images are already MIME- and size-checked at runtime and persistence boundaries.
const MessageImageList = ({ images }: { images: MessageImage[] }): React.JSX.Element | null => {
  if (images.length === 0) return null

  return (
    <div className="mt-3 grid max-w-full grid-cols-1 gap-3 sm:grid-cols-2">
      {images.map((image, index) => (
        <img
          key={image.id}
          src={`data:${image.mimeType};base64,${image.data}`}
          alt={`Agent-generated image ${index + 1}`}
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
    if (!shouldReadArtifactPreview(artifact)) return

    let canceled = false
    void window.api.artifacts
      .readPreview({ path: artifact.path, maxBytes: ARTIFACT_PREVIEW_BYTES, encoding: 'utf8' })
      .then((preview) => {
        if (!canceled) setPreviewState({ requestKey, preview })
      })
      .catch((error: unknown) => {
        // Missing or cross-root files are represented by the card badge, not noisy console errors.
        if (!isUnavailableFileError(error)) console.error('Failed to read artifact preview', error)
        if (!canceled) setPreviewState({ requestKey, preview: undefined })
      })

    return () => {
      canceled = true
    }
  }, [artifact, requestKey])

  const preview = previewState?.requestKey === requestKey ? previewState.preview : undefined
  return <ArtifactPreview artifact={artifact} preview={preview} isVisible />
}

// Thumbnail button for one generated file; clicking it previews the file instead of opening it.
const ArtifactCard = ({
  artifact,
  onPreviewArtifact
}: {
  artifact: MessageArtifact
  onPreviewArtifact: (artifact: MessageArtifact) => void
}): React.JSX.Element => {
  const artifactName = getArtifactName(artifact)
  const sizeLabel = formatByteSize(artifact.size) ?? ''
  const [setElement, isNearViewport] = useNearViewport<HTMLButtonElement>()
  const requestKey = JSON.stringify([
    artifact.id,
    artifact.path,
    artifact.size ?? null,
    artifact.mtimeMs ?? null
  ])
  const missing = useUnavailablePreviewProbe({
    enabled: isNearViewport,
    path: artifact.path,
    source: 'artifact'
  })

  return (
    <button
      ref={setElement}
      type="button"
      className={cn('group flex min-w-0 flex-col', artifactCardClassName)}
      onClick={() => {
        onPreviewArtifact(artifact)
      }}
      aria-label={`Preview generated file ${artifactName}`}
      title={artifact.path}
    >
      <div className={cn('relative', artifactPreviewClassName)}>
        <span className={cn('block size-full', missing && 'opacity-40')}>
          {/* Unmount the reader outside the overscan window so message history stays lightweight. */}
          {isNearViewport ? (
            <VisibleArtifactPreview artifact={artifact} requestKey={requestKey} />
          ) : (
            <ArtifactPreview artifact={artifact} isVisible={false} />
          )}
        </span>
        {missing ? (
          <span className="absolute left-1 top-1 rounded bg-text-000/75 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-bg-000 shadow-sm">
            {FILE_MISSING_TAG}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 items-center px-1.5">
        <ExtensionPreservingFileName
          name={artifactName}
          className="flex-1 text-[12px] leading-5"
          compact
        />
        {sizeLabel ? (
          <span className="ml-1 shrink-0 text-[11px] text-text-300">{sizeLabel}</span>
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
  const [expanded, setExpanded] = useState(false)
  const visibleCount = expanded ? artifacts.length : ARTIFACT_GALLERY_VISIBLE_COUNT
  const visibleArtifacts = artifacts.slice(0, visibleCount)
  if (artifacts.length === 0) return null

  const remainingCount = artifacts.length - visibleArtifacts.length

  return (
    <div className="mt-3 border-t border-border-200 pt-3">
      <div className="mb-2 text-[11px] font-medium uppercase text-text-300">
        GENERATED · {artifacts.length}
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
                aria-label="Expand generated files"
              >
                +{remainingCount} more
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
                aria-label="Collapse generated files"
              >
                Show less
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
            aria-label={`Preview uploaded attachment ${attachmentName}`}
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
}): React.JSX.Element => (
  <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
    {parts.map((part, index) => {
      if (part.type === 'skill') {
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
            aria-label={`Open skill ${part.name}`}
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
            aria-label={`Preview ${part.name}`}
          >
            @<ExtensionPreservingFileName name={part.name} />
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

// Renders one chat message with user bubbles and full-width assistant markdown surfaces.
const WorkspaceMessageItem = ({
  message,
  onPreviewArtifact,
  onPreviewUploadAttachment,
  onOpenSkillMention,
  onPreviewMentionArtifact,
  canEditMessage = false,
  showUserActions = true,
  contentPaddingClassName,
  onSendEditedMessage,
  turnStartedAt,
  runtimeIdentity,
  showAssistantFooter = true,
  subsequentTurns = 0,
  revisionNavigation,
  artifacts = [],
  staticParts
}: WorkspaceMessageItemProps): React.JSX.Element => {
  const isUserMessage = message.role === 'user'
  const uploads = message.uploads ?? []
  const hasTurnUsage = Boolean(message.turnUsage || message.turnUsageUnavailable)
  const showTurnUsage = hasTurnUsage || (message.status === 'complete' && Boolean(runtimeIdentity))
  const terminalTimestamp =
    message.status === 'complete'
      ? message.completedAt
      : message.status === 'error'
        ? message.failedAt
        : undefined
  const sentDate = toMessageDate(message.createdAt)
  const terminalDate = toMessageDate(terminalTimestamp)
  const turnStartedDate = toMessageDate(turnStartedAt)
  const terminalLabel = message.status === 'error' ? 'Failed' : 'Completed'
  const showRevisionNavigation =
    showUserActions && revisionNavigation && revisionNavigation.total > 1
  const [copied, setCopied] = useState(false)
  // Inline editing swaps the bubble for a multi-line editor; the doc starts from the message's
  // structured parts so mention chips survive the round-trip.
  const [isEditing, setIsEditing] = useState(false)
  const [editDoc, setEditDoc] = useState<ComposerDoc>(emptyDoc)
  // True while the destructive-resend confirmation dialog is open.
  const [isConfirmingEdit, setIsConfirmingEdit] = useState(false)
  const copyResetTimeoutRef = useRef<number | null>(null)

  // Clear a pending copied-state reset so it never fires setState after unmount.
  useEffect(
    () => () => {
      if (copyResetTimeoutRef.current !== null) window.clearTimeout(copyResetTimeoutRef.current)
    },
    []
  )

  // Copies the prompt text and briefly swaps the icon to confirm the clipboard write succeeded.
  const handleCopyMessage = (): void => {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true)
      if (copyResetTimeoutRef.current !== null) window.clearTimeout(copyResetTimeoutRef.current)
      copyResetTimeoutRef.current = window.setTimeout(() => setCopied(false), 2000)
    })
  }

  // Opens the inline editor with the prompt rebuilt as a composer doc (mention chips restored when
  // the message carries structured parts, plain text otherwise).
  const handleStartEdit = (): void => {
    setEditDoc(
      message.parts && message.parts.length > 0
        ? docFromMessageParts(message.parts)
        : docFromText(message.content)
    )
    setIsEditing(true)
  }

  const handleCancelEdit = (): void => {
    setIsEditing(false)
  }

  // The destructive resend itself: the conversation is truncated at this message and the adjusted
  // prompt is resent as a fresh turn, then the editor closes.
  const confirmEditedResend = (): void => {
    onSendEditedMessage?.(message.id, editDoc)
    setIsConfirmingEdit(false)
    setIsEditing(false)
  }

  // Confirms the inline edit; with several later turns changing visibility, ask before branching.
  const handleConfirmEdit = (): void => {
    if (!canEditMessage || docIsEmpty(editDoc)) return

    if (subsequentTurns >= EDIT_TRUNCATION_WARNING_TURNS) {
      setIsConfirmingEdit(true)
      return
    }

    confirmEditedResend()
  }

  return (
    <MessageScrollerItem
      key={message.id}
      messageId={message.id}
      disableContainment={message.status === 'streaming'}
      scrollAnchor={message.role === 'user'}
      className="min-w-0"
    >
      <div className={cn('px-4 pb-1 pt-5 md:px-6', contentPaddingClassName)}>
        {/* User prompts stay compact; assistant responses remain a readable transcript surface. */}
        {isUserMessage ? (
          isEditing ? (
            <div className="flex justify-end">
              {/* Inline editing swaps the bubble for a multi-line editor; confirm resends the prompt. */}
              <div className={editCardClassName}>
                <ComposerEditor
                  doc={editDoc}
                  onDocChange={setEditDoc}
                  onSubmit={handleConfirmEdit}
                  onPaste={ignoreEditPaste}
                  placeholder="Edit your message"
                  ariaLabel="Edit message"
                />
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    className={editCancelButtonClassName}
                    onClick={handleCancelEdit}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={editSendButtonClassName}
                    disabled={!canEditMessage || docIsEmpty(editDoc)}
                    onClick={handleConfirmEdit}
                  >
                    Send
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
                {showUserActions ? (
                  <TooltipProvider delayDuration={200}>
                    <div data-slot="user-message-actions" className={userMessageActionsClassName}>
                      <UserMessageActionTooltip label={copied ? 'Copied' : 'Copy message'}>
                        <button
                          type="button"
                          className={userMessageActionButtonClassName}
                          aria-label={copied ? 'Copied' : 'Copy message'}
                          onClick={handleCopyMessage}
                        >
                          {copied ? (
                            <Check className="size-3.5" strokeWidth={2} aria-hidden="true" />
                          ) : (
                            <Copy className="size-3.5" strokeWidth={2} aria-hidden="true" />
                          )}
                        </button>
                      </UserMessageActionTooltip>
                      <UserMessageActionTooltip label="Edit message">
                        <button
                          type="button"
                          className={userMessageActionButtonClassName}
                          aria-label="Edit message"
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
                  <MessageUploadAttachmentList
                    attachments={uploads}
                    onPreviewUploadAttachment={onPreviewUploadAttachment}
                  />
                  {/* Structured parts drive styled pills; plain content is the backward-compatible fallback. */}
                  {staticParts && staticParts.length > 0 ? (
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
                    <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                      {message.content}
                    </p>
                  ) : null}
                </div>
              </div>
              {sentDate || showRevisionNavigation ? (
                <div
                  data-slot="user-message-footer"
                  className="mt-1 flex min-h-6 w-full flex-wrap items-center justify-end gap-x-2 text-[11px] leading-4 text-text-000/70 tabular-nums"
                >
                  {sentDate ? <MessageTimestamp label="Sent" date={sentDate} /> : null}
                  {showRevisionNavigation ? (
                    <TooltipProvider delayDuration={200}>
                      <div
                        data-slot="user-message-revision-navigation"
                        className="flex items-center gap-0.5 text-[13px] text-text-100"
                      >
                        <UserMessageActionTooltip label="Previous message revision">
                          <button
                            type="button"
                            className={userMessageActionButtonClassName}
                            aria-label="Previous message revision"
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
                        <span aria-label="Message revision" className="min-w-7 text-center">
                          {revisionNavigation.index + 1}/{revisionNavigation.total}
                        </span>
                        <UserMessageActionTooltip label="Next message revision">
                          <button
                            type="button"
                            className={userMessageActionButtonClassName}
                            aria-label="Next message revision"
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
          <div className={cn(assistantMessageSurfaceClassName, 'select-text overflow-visible')}>
            {message.content ? (
              <AgentMarkdown
                content={message.content}
                isAnimating={message.status === 'streaming'}
                sessionLinks
              />
            ) : null}
            <MessageImageList images={message.images ?? []} />
            <MessageArtifactList onPreviewArtifact={onPreviewArtifact} artifacts={artifacts} />
            {showAssistantFooter &&
            (terminalDate || (terminalTimestamp !== undefined && showTurnUsage)) ? (
              <div
                data-slot="assistant-message-footer"
                className="mt-3 flex items-center gap-x-3 whitespace-nowrap text-[11px] leading-4 text-text-000/70 tabular-nums"
              >
                {terminalDate ? (
                  <MessageTimestamp label={terminalLabel} date={terminalDate} />
                ) : null}
                {terminalDate && turnStartedDate ? (
                  <span data-slot="assistant-message-elapsed-segment" className="whitespace-nowrap">
                    <span aria-label="Elapsed run time">
                      Elapsed{' '}
                      {formatElapsedDuration(terminalDate.getTime() - turnStartedDate.getTime())}
                    </span>
                  </span>
                ) : null}
                {showTurnUsage ? (
                  <TurnTokenUsage usage={message.turnUsage} runtimeIdentity={runtimeIdentity} />
                ) : null}
              </div>
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

export { WorkspaceMessageItem }
export type { ArtifactMentionPart }
