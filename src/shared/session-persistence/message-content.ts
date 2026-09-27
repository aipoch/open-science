import {
  type PersistedArtifactKind,
  type PersistedArtifact,
  type MessagePart,
  MAX_LITERATURE_SCOPE_ID_LENGTH,
  MAX_LITERATURE_SCOPE_NAME_LENGTH,
  type SessionReference,
  MAX_SESSION_REFERENCES_PER_MESSAGE,
  MAX_SESSION_REFERENCE_ID_LENGTH,
  MAX_SESSION_REFERENCE_TITLE_LENGTH,
  type PersistedMessageImage,
  type PersistedChatMessage
} from './message'
import { asString, isRecord, asNumber } from './primitives'
import type { PersistedUploadedAttachment } from '../uploads'
import { literatureItemInputSchema } from '../literature'
import {
  MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE,
  sanitizeAcpMessageImage,
  MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE,
  MAX_ACP_SESSION_IMAGE_BYTES
} from '../acp'
import type { MaterializedPersistedChatSession, PersistedChatSession } from './session'
import {
  resolveActiveConversationMessages,
  projectConversationMessage
} from '../conversation-graph'

const ARTIFACT_KINDS = new Set<PersistedArtifactKind>([
  'workspace-file',
  'external-file',
  'managed-file'
])

// Accepts only artifact references, never arbitrary file payload shapes.
const asArtifactKind = (value: unknown): PersistedArtifactKind | undefined => {
  const kind = asString(value) as PersistedArtifactKind | undefined

  return kind && ARTIFACT_KINDS.has(kind) ? kind : undefined
}

// Rebuilds artifact metadata from allowed reference fields and drops embedded content.
export const sanitizeArtifact = (artifact: unknown): PersistedArtifact | undefined => {
  if (!isRecord(artifact)) return undefined

  const id = asString(artifact.id)
  const kind = asArtifactKind(artifact.kind)
  const path = asString(artifact.path)

  if (!id || !kind || !path) return undefined

  const sanitized: PersistedArtifact = {
    id,
    kind,
    path
  }
  const name = asString(artifact.name)
  const fileUrl = asString(artifact.fileUrl)
  const mimeType = asString(artifact.mimeType)
  const size = asNumber(artifact.size)
  const createdAt = asNumber(artifact.createdAt)
  const mtimeMs = asNumber(artifact.mtimeMs)
  const sha256 = asString(artifact.sha256)
  const artifactId = asString(artifact.artifactId)
  const versionId = asString(artifact.versionId)
  const versionNumber = asNumber(artifact.versionNumber)

  if (fileUrl) sanitized.fileUrl = fileUrl
  if (name) sanitized.name = name
  if (mimeType) sanitized.mimeType = mimeType
  if (size !== undefined) sanitized.size = size
  if (createdAt !== undefined && Number.isFinite(createdAt) && createdAt >= 0) {
    sanitized.createdAt = createdAt
  }
  if (mtimeMs !== undefined) sanitized.mtimeMs = mtimeMs
  if (sha256) sanitized.sha256 = sha256
  if (artifactId) sanitized.artifactId = artifactId
  if (versionId) sanitized.versionId = versionId
  if (versionNumber !== undefined && Number.isInteger(versionNumber) && versionNumber > 0) {
    sanitized.versionNumber = versionNumber
  }

  return sanitized
}

// Rebuilds uploaded file references without accepting embedded content or unknown payloads.
export const sanitizeUploadedAttachment = (
  attachment: unknown,
  options: { preserveLegacyPath?: boolean } = {}
): PersistedUploadedAttachment | undefined => {
  if (!isRecord(attachment)) return undefined

  const id = asString(attachment.id)
  const sessionId = asString(attachment.sessionId)
  const name = asString(attachment.name)
  if (!id || !sessionId || !name) return undefined

  const sanitized: PersistedUploadedAttachment = {
    id,
    sessionId,
    name,
    originalName: asString(attachment.originalName) ?? name,
    size: asNumber(attachment.size) ?? 0
  }
  const mimeType = asString(attachment.mimeType)
  const versionId = asString(attachment.versionId)
  const versionNumber = asNumber(attachment.versionNumber)
  const createdAt = asString(attachment.createdAt)
  const sha256 = asString(attachment.sha256) ?? asString(attachment.checksum)

  if (mimeType) sanitized.mimeType = mimeType
  if (versionId) sanitized.versionId = versionId
  if (versionNumber !== undefined && Number.isInteger(versionNumber) && versionNumber > 0) {
    sanitized.versionNumber = versionNumber
  }
  if (createdAt) sanitized.createdAt = createdAt
  if (sha256) sanitized.sha256 = sha256
  const legacyPath = asString(attachment.path)
  if (!versionId && options.preserveLegacyPath && legacyPath) sanitized.path = legacyPath

  return sanitized
}

// Rebuilds one structured mention segment, dropping malformed entries so the bubble stays renderable.
const sanitizeMessagePart = (part: unknown): MessagePart | undefined => {
  if (!isRecord(part)) return undefined

  switch (asString(part.type)) {
    case 'text': {
      const text = asString(part.text)

      return text !== undefined ? { type: 'text', text } : undefined
    }
    case 'skill': {
      const id = asString(part.id)
      const name = asString(part.name)

      return id && name ? { type: 'skill', id, name } : undefined
    }
    case 'session': {
      const sessionId = asString(part.sessionId)
      const title = asString(part.title)

      return sessionId && title ? { type: 'session', sessionId, title } : undefined
    }
    case 'literature': {
      const itemId = asString(part.itemId)
      const metadataRevision = asNumber(part.metadataRevision)
      const item = literatureItemInputSchema.safeParse(part.item)
      const attachmentVersionId = asString(part.attachmentVersionId)

      if (
        !itemId ||
        typeof metadataRevision !== 'number' ||
        !Number.isInteger(metadataRevision) ||
        metadataRevision < 1 ||
        !item.success
      ) {
        return undefined
      }
      return {
        type: 'literature',
        itemId,
        metadataRevision,
        item: item.data,
        ...(attachmentVersionId ? { attachmentVersionId } : {})
      }
    }
    case 'literature-scope': {
      const scope = asString(part.scope)
      if (scope === 'project') return { type: 'literature-scope', scope }
      if (scope !== 'collection') return undefined
      const collectionId = asString(part.collectionId)
      const name = asString(part.name)
      return collectionId &&
        collectionId.length <= MAX_LITERATURE_SCOPE_ID_LENGTH &&
        name &&
        name.length <= MAX_LITERATURE_SCOPE_NAME_LENGTH
        ? { type: 'literature-scope', scope, collectionId, name }
        : undefined
    }
    case 'artifact': {
      const id = asString(part.id)
      const name = asString(part.name)
      const source = asString(part.source)

      if (!id || !name) return undefined

      const mimeType = asString(part.mimeType)
      if (source === 'linked-folder') {
        const rootId = asString(part.rootId)
        const relativePath = asString(part.relativePath)
        if (!rootId || !relativePath) return undefined

        return {
          type: 'artifact',
          id,
          name,
          source,
          rootId,
          relativePath,
          ...(mimeType ? { mimeType } : {})
        }
      }

      const path = asString(part.path)
      if (!path || (source !== 'upload' && source !== 'artifact' && source !== 'literature')) {
        return undefined
      }

      const sanitized: MessagePart = { type: 'artifact', id, name, path, source }
      const versionId = asString(part.versionId)
      const sourceFileId = asString(part.sourceFileId)

      return {
        ...sanitized,
        ...(mimeType ? { mimeType } : {}),
        ...(sourceFileId ? { sourceFileId } : {}),
        ...(versionId ? { versionId } : {})
      }
    }
    default:
      return undefined
  }
}

export const sanitizeMessageParts = (value: unknown): MessagePart[] =>
  Array.isArray(value)
    ? value.map(sanitizeMessagePart).filter((part): part is MessagePart => part !== undefined)
    : []

export const sanitizeSessionReferences = (value: unknown): SessionReference[] => {
  if (!Array.isArray(value)) return []
  const references: SessionReference[] = []
  for (const candidate of value) {
    if (references.length >= MAX_SESSION_REFERENCES_PER_MESSAGE) break
    const part = sanitizeMessagePart(candidate)
    if (
      part?.type !== 'session' ||
      part.sessionId.length > MAX_SESSION_REFERENCE_ID_LENGTH ||
      part.title.length > MAX_SESSION_REFERENCE_TITLE_LENGTH ||
      references.some((reference) => reference.sessionId === part.sessionId)
    ) {
      continue
    }
    references.push({ type: 'session', sessionId: part.sessionId, title: part.title })
  }
  return references
}

// Revalidates embedded message images before writing or restoring a session file. The count and
// aggregate byte budget prevent many individually valid chunks from growing one message without bound.
export const sanitizeMessageImages = (value: unknown): PersistedMessageImage[] | undefined => {
  if (!Array.isArray(value)) return undefined

  const images: PersistedMessageImage[] = []
  let totalBytes = 0

  for (const candidate of value) {
    if (images.length >= MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE || !isRecord(candidate)) break

    const id = asString(candidate.id)
    const image = sanitizeAcpMessageImage(candidate)

    if (!id || !image) continue
    if (totalBytes + image.byteLength > MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE) break

    images.push({ id, ...image })
    totalBytes += image.byteLength
  }

  return images.length > 0 ? images : undefined
}

// Applies the image boundary immediately before repository serialization without changing runtime
// status fields (running sessions must remain restorable as interrupted sessions after a restart).
export function sanitizeSessionMessageImages(
  session: MaterializedPersistedChatSession
): MaterializedPersistedChatSession

export function sanitizeSessionMessageImages(session: PersistedChatSession): PersistedChatSession

export function sanitizeSessionMessageImages(session: PersistedChatSession): PersistedChatSession {
  const sanitizeMessages = <Message extends PersistedChatMessage>(
    messages: readonly Message[]
  ): Message[] => {
    let totalBytes = 0
    return messages.map((message) => {
      const images = (sanitizeMessageImages(message.images) ?? []).filter((image) => {
        if (totalBytes + image.byteLength > MAX_ACP_SESSION_IMAGE_BYTES) return false
        totalBytes += image.byteLength
        return true
      })
      const annotations = (message.annotations ?? []).map((annotation) => {
        if (
          annotation.kind !== 'pdf' ||
          annotation.selector.kind !== 'region' ||
          !annotation.selector.image
        )
          return annotation
        if (totalBytes + annotation.selector.image.byteLength > MAX_ACP_SESSION_IMAGE_BYTES) {
          return {
            ...annotation,
            selector: {
              ...annotation.selector,
              image: undefined,
              imageOmissionReason: 'session-budget' as const
            }
          }
        }
        totalBytes += annotation.selector.image.byteLength
        return annotation
      })
      return {
        ...message,
        annotations: annotations.length > 0 ? annotations : undefined,
        images: images.length > 0 ? images : undefined
      }
    })
  }

  if (!session.conversationGraph) {
    return { ...session, messages: sanitizeMessages(session.messages) }
  }

  // The graph is canonical and includes inactive Branches. Sanitize it once under one aggregate
  // budget, then rebuild the active compatibility projection so duplicate active messages are not
  // counted twice and hidden Branches cannot bypass the on-disk image boundary.
  const conversationGraph = {
    ...session.conversationGraph,
    messages: sanitizeMessages(session.conversationGraph.messages)
  }
  return {
    ...session,
    conversationGraph,
    messages: resolveActiveConversationMessages(conversationGraph).map(projectConversationMessage)
  }
}

// Applies the path-free upload boundary immediately before repository serialization without
// normalizing run/session state. This preserves crash-restoration semantics while ensuring legacy
// renderer paths and checksum aliases can never leak into newly written Session JSON.
export const sanitizeSessionUploadedAttachments = (
  session: PersistedChatSession
): PersistedChatSession => {
  const sanitizeUploads = <Message extends PersistedChatMessage>(message: Message): Message => {
    const uploads = (message.uploads ?? [])
      .map((upload) => sanitizeUploadedAttachment(upload))
      .filter((upload): upload is PersistedUploadedAttachment => !!upload)
    return { ...message, uploads: uploads.length > 0 ? uploads : undefined }
  }
  return {
    ...session,
    messages: session.messages.map(sanitizeUploads),
    ...(session.conversationGraph
      ? {
          conversationGraph: {
            ...session.conversationGraph,
            messages: session.conversationGraph.messages.map(sanitizeUploads)
          }
        }
      : {})
  }
}
