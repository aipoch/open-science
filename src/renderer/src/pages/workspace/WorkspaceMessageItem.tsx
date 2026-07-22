import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { cn, formatByteSize } from '@/lib/utils'
import type { ChatMessage, ChatSession } from '@/stores/session-store'
import { Collapsible } from 'radix-ui'
import { Check, Copy, FileText, Image as ImageIcon, Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ArtifactPreviewResult } from '../../../../shared/artifacts'
import type { MessagePart } from '../../../../shared/session-persistence'
import { getUploadedAttachmentName } from '../../../../shared/uploads'

import { ArtifactPreview } from './artifact-preview'
import { ComposerEditor } from './composer/ComposerEditor'
import { EditMessageConfirmDialog } from './EditMessageConfirmDialog'
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

type MessageArtifact = NonNullable<ChatSession['artifacts']>[number]
type MessageUploadAttachment = NonNullable<ChatMessage['uploads']>[number]
type MessageImage = NonNullable<ChatMessage['images']>[number]
type ArtifactMentionPart = Extract<MessagePart, { type: 'artifact' }>
type WorkspaceMessageItemProps = {
  message: ChatMessage
  onPreviewArtifact: (artifact: MessageArtifact) => void
  onPreviewUploadAttachment: (attachment: MessageUploadAttachment) => void
  onOpenSkillMention: (skillId: string, name: string) => void
  onPreviewMentionArtifact: (part: ArtifactMentionPart) => void
  artifacts?: MessageArtifact[]
  // Inline editing is only enabled once the session's run settles; confirming truncates the
  // conversation at this message and resends the adjusted doc as a fresh turn.
  canEditMessage?: boolean
  onSendEditedMessage?: (messageId: string, doc: ComposerDoc) => void
  // Number of user turns after this message; drives the destructive-resend warning threshold.
  subsequentTurns?: number
}

const ARTIFACT_GALLERY_VISIBLE_COUNT = 5
const artifactCardClassName =
  'h-[82px] w-[128px] shrink-0 overflow-hidden rounded-lg border border-border-200 bg-bg-000 text-left text-text-000 shadow-none transition-colors hover:bg-bg-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-200/60'
const artifactPreviewClassName = 'h-[56px] w-full overflow-hidden bg-bg-200'
const artifactGalleryClassName = 'grid max-w-full grid-cols-[repeat(auto-fill,128px)] gap-2 pb-1'

const userMessageBubbleClassName =
  'max-w-[90%] break-words rounded-2xl bg-bg-300 px-3.5 py-2 text-sm text-message-user-text md:max-w-[min(85%,56rem)] md:px-4 md:py-2.5 md:text-[15px]'
// Hover actions (copy / edit) sit to the left of the user bubble, revealed on row hover or focus.
const userMessageActionsClassName =
  'flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100'
const userMessageActionButtonClassName =
  'flex size-6 items-center justify-center rounded-md text-text-300 transition-colors duration-200 ease-out hover:bg-bg-200 hover:text-text-100 disabled:cursor-not-allowed disabled:opacity-50'
// Inline editing replaces the bubble with a bordered multi-line editor card aligned to the right.
const editCardClassName =
  'flex w-[85%] max-w-[56rem] flex-col gap-2 rounded-2xl border border-border-200 bg-bg-000 px-3 py-2 shadow-card'
const editCancelButtonClassName =
  'flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium text-text-300 transition-colors duration-200 ease-out hover:bg-bg-200 hover:text-text-100'
const editSendButtonClassName =
  'flex h-7 items-center rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-foreground transition-colors duration-200 ease-out hover:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-primary'
// The inline editor ignores pasted files; plain-text paste is handled by the editor itself.
const ignoreEditPaste = (): void => {}
// Resending an edit drops every turn after the edited one; from this many turns up, ask first.
const EDIT_TRUNCATION_WARNING_TURNS = 2
// Staged uploads render as gray file pills inside the sent bubble.
const uploadedAttachmentButtonClassName =
  'inline-flex max-w-full items-center gap-1.5 rounded-md border border-border-200 bg-bg-200 px-2 py-0.5 text-left text-[13px] leading-5 text-text-000 transition-colors hover:bg-bg-000 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-200/60'
// Shared pill shape for inline skill/artifact mentions in the sent bubble. Capped width + truncation
// keeps a long file/skill name from overflowing the bubble.
const mentionPillClassName =
  'inline-block max-w-[220px] truncate align-middle rounded px-1.5 py-0.5 mx-0.5 text-sm font-medium'
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
      <div className="flex min-w-0 flex-1 items-center px-2">
        <span className="min-w-0 flex-1 truncate text-[12px] leading-5">{artifactName}</span>
        {sizeLabel ? (
          <span className="ml-2 shrink-0 text-[11px] text-text-300">{sizeLabel}</span>
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
            <span className="min-w-0 truncate">{attachmentName}</span>
          </button>
        )
      })}
    </div>
  )
}

// Renders a user message's structured mention segments as inline styled pills.
const MessagePartsContent = ({
  parts,
  onOpenSkillMention,
  onPreviewMentionArtifact
}: {
  parts: MessagePart[]
  onOpenSkillMention: (skillId: string, name: string) => void
  onPreviewMentionArtifact: (part: ArtifactMentionPart) => void
}): React.JSX.Element => (
  <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
    {parts.map((part, index) => {
      if (part.type === 'skill') {
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
        return (
          <button
            key={index}
            type="button"
            className={cn(
              mentionPillClassName,
              mentionButtonClassName,
              'bg-mention-chip text-mention-chip-foreground'
            )}
            onClick={() => onPreviewMentionArtifact(part)}
            aria-label={`Preview ${part.name}`}
          >
            @{part.name}
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
  onSendEditedMessage,
  subsequentTurns = 0,
  artifacts = []
}: WorkspaceMessageItemProps): React.JSX.Element => {
  const isUserMessage = message.role === 'user'
  const uploads = message.uploads ?? []
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

  // Confirms the inline edit; with several later turns at stake, ask before the destructive resend.
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
      scrollAnchor={message.role === 'user'}
      className="min-w-0"
    >
      <div className="px-4 pb-1 pt-5 md:px-6">
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
            <div className="group flex items-center justify-end gap-1">
              {/* Copy/edit actions ride to the left of the user bubble, surfaced on hover or focus. */}
              <div className={userMessageActionsClassName}>
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
                <button
                  type="button"
                  className={userMessageActionButtonClassName}
                  aria-label="Edit message"
                  disabled={!canEditMessage}
                  onClick={handleStartEdit}
                >
                  <Pencil className="size-3.5" strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
              <div className={userMessageBubbleClassName}>
                <MessageUploadAttachmentList
                  attachments={uploads}
                  onPreviewUploadAttachment={onPreviewUploadAttachment}
                />
                {/* Structured parts drive styled pills; plain content is the backward-compatible fallback. */}
                {message.parts && message.parts.length > 0 ? (
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
          )
        ) : (
          <div className={cn(assistantMessageSurfaceClassName, 'select-text overflow-visible')}>
            {message.content ? (
              <AgentMarkdown
                content={message.content}
                isAnimating={message.status === 'streaming'}
              />
            ) : null}
            <MessageImageList images={message.images ?? []} />
            <MessageArtifactList onPreviewArtifact={onPreviewArtifact} artifacts={artifacts} />
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
