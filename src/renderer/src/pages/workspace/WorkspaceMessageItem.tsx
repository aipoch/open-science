import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { cn, formatByteSize } from '@/lib/utils'
import type { ChatMessage, ChatSession } from '@/stores/session-store'
import { Collapsible } from 'radix-ui'
import { FileText, Image as ImageIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactPreviewResult } from '../../../../shared/artifacts'
import type { MessagePart } from '../../../../shared/session-persistence'
import { getUploadedAttachmentName } from '../../../../shared/uploads'

import { ArtifactPreview } from './artifact-preview'
import {
  ARTIFACT_IMAGE_PREVIEW_BYTES,
  ARTIFACT_PREVIEW_BYTES,
  getArtifactPreviewCacheKey,
  getArtifactName,
  getArtifactsForPreviewRead,
  isImageArtifact
} from './artifact-preview-utils'
import { FILE_MISSING_TAG, isUnavailableFileError } from './previews/preview-errors'

type MessageArtifact = NonNullable<ChatSession['artifacts']>[number]
type MessageUploadAttachment = NonNullable<ChatMessage['uploads']>[number]
type ArtifactMentionPart = Extract<MessagePart, { type: 'artifact' }>
type ArtifactPreviewState = Record<string, ArtifactPreviewResult | undefined>
type ArtifactPreviewCache = {
  key: string
  previews: ArtifactPreviewState
}

type WorkspaceMessageItemProps = {
  message: ChatMessage
  onPreviewArtifact: (artifact: MessageArtifact) => void
  onPreviewUploadAttachment: (attachment: MessageUploadAttachment) => void
  onOpenSkillMention: (skillId: string, name: string) => void
  onPreviewMentionArtifact: (part: ArtifactMentionPart) => void
  artifacts?: MessageArtifact[]
}

const ARTIFACT_GALLERY_VISIBLE_COUNT = 5
const artifactCardClassName =
  'h-[82px] w-[128px] shrink-0 overflow-hidden rounded-lg border border-border-200 bg-bg-000 text-left text-text-000 shadow-none transition-colors hover:bg-bg-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-200/60'
const artifactPreviewClassName = 'h-[56px] w-full overflow-hidden bg-bg-200'
const artifactGalleryClassName = 'grid max-w-full grid-cols-[repeat(auto-fill,128px)] gap-2 pb-1'

const userMessageBubbleClassName =
  'max-w-[90%] break-words rounded-2xl bg-bg-300 px-3.5 py-2 text-sm text-message-user-text md:max-w-[min(85%,56rem)] md:px-4 md:py-2.5 md:text-[15px]'
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

// Thumbnail button for one generated file; clicking it previews the file instead of opening it.
const ArtifactCard = ({
  artifact,
  onPreviewArtifact,
  preview,
  missing = false
}: {
  artifact: MessageArtifact
  onPreviewArtifact: (artifact: MessageArtifact) => void
  preview?: ArtifactPreviewResult
  missing?: boolean
}): React.JSX.Element => {
  const artifactName = getArtifactName(artifact)
  const sizeLabel = formatByteSize(artifact.size) ?? ''

  return (
    <button
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
          <ArtifactPreview artifact={artifact} preview={preview} />
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
  const [artifactPreviewCache, setArtifactPreviewCache] = useState<ArtifactPreviewCache>({
    key: '',
    previews: {}
  })
  // Ids of generated files whose source is gone from disk, badged "Missing" on the thumbnail.
  const [missingArtifactIds, setMissingArtifactIds] = useState<Set<string>>(() => new Set())
  const probedPathsRef = useRef<Set<string>>(new Set())
  const previewKey = useMemo(() => getArtifactPreviewCacheKey(artifacts), [artifacts])
  const artifactPreviews = useMemo(
    () => (artifactPreviewCache.key === previewKey ? artifactPreviewCache.previews : {}),
    [artifactPreviewCache, previewKey]
  )
  const visibleCount = expanded ? artifacts.length : ARTIFACT_GALLERY_VISIBLE_COUNT
  const visibleArtifacts = artifacts.slice(0, visibleCount)

  useEffect(() => {
    const previewArtifacts = getArtifactsForPreviewRead({
      artifacts,
      cachedPreviews: artifactPreviews,
      visibleCount
    })
    let canceled = false

    if (previewArtifacts.length === 0) return

    void Promise.all(
      previewArtifacts.map(async (artifact) => {
        try {
          const preview = await window.api.artifacts.readPreview({
            path: artifact.path,
            maxBytes: isImageArtifact(artifact)
              ? ARTIFACT_IMAGE_PREVIEW_BYTES
              : ARTIFACT_PREVIEW_BYTES,
            encoding: isImageArtifact(artifact) ? 'base64' : 'utf8'
          })

          return { artifactId: artifact.id, preview }
        } catch (error) {
          // Unavailable files (missing / outside storage) are expected and badged; keep the console
          // for genuine read failures only.
          if (!isUnavailableFileError(error)) {
            console.error('Failed to read artifact preview', error)
          }
          return { artifactId: artifact.id, preview: undefined }
        }
      })
    ).then((previews) => {
      if (canceled) return

      setArtifactPreviewCache((currentCache) => {
        const currentPreviews = currentCache.key === previewKey ? currentCache.previews : {}

        return {
          key: previewKey,
          previews: previews.reduce<ArtifactPreviewState>(
            (nextPreviews, item) => {
              nextPreviews[item.artifactId] = item.preview
              return nextPreviews
            },
            { ...currentPreviews }
          )
        }
      })
    })

    return () => {
      canceled = true
    }
  }, [artifactPreviews, artifacts, previewKey, visibleCount])

  // Existence probe for the "Missing" badge (mirrors the Files grid): a tiny 1-byte read that
  // resolves if the file exists and rejects with ENOENT if not, covering every type — including
  // PDFs, which render their own thumbnail and skip the preview read above. Paths are marked probed
  // only after a run commits (NOT synchronously): StrictMode cancels the first pass, so pre-claiming
  // would let the surviving pass skip everything and never badge.
  useEffect(() => {
    const targets = artifacts
      .slice(0, visibleCount)
      .filter((artifact) => !probedPathsRef.current.has(artifact.path))
    if (targets.length === 0) return

    let canceled = false

    void Promise.all(
      targets.map(async (artifact) => {
        try {
          await window.api.artifacts.readPreview({
            path: artifact.path,
            maxBytes: 1,
            encoding: 'base64'
          })
          return { id: artifact.id, path: artifact.path, missing: false }
        } catch (error) {
          return { id: artifact.id, path: artifact.path, missing: isUnavailableFileError(error) }
        }
      })
    ).then((results) => {
      if (canceled) return
      results.forEach((result) => probedPathsRef.current.add(result.path))
      const newlyMissing = results.filter((result) => result.missing).map((result) => result.id)
      if (newlyMissing.length === 0) return
      setMissingArtifactIds((current) => new Set([...current, ...newlyMissing]))
    })

    return () => {
      canceled = true
    }
  }, [artifacts, visibleCount])

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
              preview={artifactPreviews[artifact.id]}
              missing={missingArtifactIds.has(artifact.id)}
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
  artifacts = []
}: WorkspaceMessageItemProps): React.JSX.Element => {
  const isUserMessage = message.role === 'user'
  const uploads = message.uploads ?? []

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
          <div className="flex justify-end">
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
        ) : (
          <div className={cn(assistantMessageSurfaceClassName, 'select-text overflow-visible')}>
            <AgentMarkdown content={message.content} isAnimating={message.status === 'streaming'} />
            <MessageArtifactList onPreviewArtifact={onPreviewArtifact} artifacts={artifacts} />
          </div>
        )}
      </div>
    </MessageScrollerItem>
  )
}

export { WorkspaceMessageItem }
export type { ArtifactMentionPart }
